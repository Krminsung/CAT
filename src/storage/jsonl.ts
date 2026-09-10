import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ConfigurationError, StorageError } from "../core/errors.js";
import type { JsonObject, JsonValue } from "../core/json.js";
import { Redactor } from "../security/redaction.js";

const READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_SCAN_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 40;
const DEFAULT_MAX_NODES = 40_000;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_PAGE_RECORDS = 1_000;
const MAX_PAGE_WARNINGS = 128;
const MAX_CURSOR_BYTES = 1_024;
const MAX_LOCK_BYTES = 4_096;
const MAX_PATH_CHARACTERS = 4_096;
const MAX_REDACTION_SECRETS = 256;
const MIN_REDACTION_SECRET_BYTES = 8;
const MAX_REDACTION_SECRET_BYTES = 64 * 1024;
const MAX_REDACTION_TOTAL_BYTES = 1024 * 1024;
const REDACTED = "[REDACTED]";
const SENSITIVE_FIELD = /^(?:api[_ -]?key|authorization|cookie|set-cookie|password|passwd|secret|token|access[_ -]?token|refresh[_ -]?token|credentials?)$/iu;

export type JsonlWarningKind =
  | "corrupt_record"
  | "oversized_record"
  | "truncated_last_record";

export interface JsonlWarning {
  readonly kind: JsonlWarningKind;
  readonly lineNumber: number;
  readonly byteOffset: number;
  readonly message: string;
}

export interface JsonlPositionedRecord<RecordValue> {
  readonly value: RecordValue;
  readonly lineNumber: number;
  readonly byteOffset: number;
}

export interface JsonlPage<RecordValue> {
  readonly records: readonly JsonlPositionedRecord<RecordValue>[];
  readonly warnings: readonly JsonlWarning[];
  readonly omittedWarnings: number;
  readonly snapshotBytes: number;
  readonly nextCursor?: string;
}

export interface JsonlReadOptions<RecordValue = JsonObject> {
  readonly cursor?: string;
  readonly limit?: number;
  readonly label?: string;
  readonly maxLineBytes?: number;
  readonly maxScanBytes?: number;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly requireOwner?: boolean;
  readonly requirePrivateMode?: boolean;
  readonly decode?: (
    value: JsonObject,
    position: { readonly lineNumber: number; readonly byteOffset: number },
  ) => RecordValue;
}

export interface JsonlWriterOptions {
  readonly lockPath?: string;
  readonly label?: string;
  readonly maxLineBytes?: number;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly secrets?: readonly string[];
  readonly now?: () => number;
}

interface CursorPayload {
  readonly version: 1;
  readonly pathHash: string;
  readonly device: string;
  readonly inode: string;
  readonly birthtimeMs: string;
  readonly observedSize: number;
  readonly offset: number;
  readonly lineNumber: number;
  readonly lineStartOffset: number;
  readonly skippingOversized: boolean;
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function assertStoragePath(value: string, label: string): void {
  if (
    !value ||
    value.includes("\0") ||
    /[\u0001-\u001f\u007f]/u.test(value) ||
    [...value].length > MAX_PATH_CHARACTERS
  ) {
    throw new ConfigurationError(`${label} 경로가 올바르지 않습니다.`);
  }
}

function boundedLabel(value: string | undefined): string {
  const selected = value ?? "JSONL 저장소";
  if (
    !selected.trim() ||
    /[\u0000-\u001f\u007f]/u.test(selected) ||
    [...selected].length > 256
  ) {
    throw new ConfigurationError("JSONL label이 올바르지 않습니다.");
  }
  return selected;
}

export function normalizeJsonlSecrets(
  values: readonly string[],
): readonly string[] {
  if (!Array.isArray(values) || values.length > MAX_REDACTION_SECRETS) {
    throw new ConfigurationError("JSONL redaction secret 수가 너무 많습니다.");
  }
  const unique = new Set<string>();
  let totalBytes = 0;
  for (const value of values) {
    if (typeof value !== "string") {
      throw new ConfigurationError("JSONL redaction secret은 문자열이어야 합니다.");
    }
    if (!value || unique.has(value)) continue;
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes < MIN_REDACTION_SECRET_BYTES || REDACTED.includes(value)) {
      throw new ConfigurationError("JSONL redaction secret이 너무 짧거나 안전하지 않습니다.");
    }
    if (bytes > MAX_REDACTION_SECRET_BYTES) {
      throw new ConfigurationError("JSONL redaction secret 하나가 너무 큽니다.");
    }
    totalBytes += bytes;
    if (totalBytes > MAX_REDACTION_TOTAL_BYTES) {
      throw new ConfigurationError("JSONL redaction secret 전체가 너무 큽니다.");
    }
    unique.add(value);
  }
  return Object.freeze([...unique]);
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (
    !Number.isSafeInteger(selected) ||
    selected < minimum ||
    selected > maximum
  ) {
    throw new ConfigurationError(
      `${label}은 ${minimum}–${maximum} 범위의 정수여야 합니다.`,
    );
  }
  return selected;
}

function currentUserId(): number | undefined {
  return process.platform !== "win32" && typeof process.geteuid === "function"
    ? process.geteuid()
    : undefined;
}

function assertOwner(info: Stats, label: string): void {
  const expected = currentUserId();
  if (expected !== undefined && info.uid !== expected) {
    throw new StorageError(`${label}이 현재 사용자 소유가 아닙니다.`);
  }
}

function assertPrivateMode(info: Stats, label: string): void {
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new StorageError(`${label}의 권한은 현재 사용자에게만 허용되어야 합니다.`);
  }
}

function assertRegularFile(info: Stats, label: string): void {
  if (!info.isFile()) throw new StorageError(`${label}이 일반 파일이 아닙니다.`);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  let info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new StorageError("JSONL 저장 디렉터리가 실제 디렉터리가 아닙니다.");
  }
  assertOwner(info, "JSONL 저장 디렉터리");
  if (process.platform !== "win32") {
    await chmod(path, 0o700);
    info = await lstat(path);
    assertPrivateMode(info, "JSONL 저장 디렉터리");
  }
}

function pathHash(path: string): string {
  return createHash("sha256").update(resolve(path), "utf8").digest("hex");
}

function identity(info: Stats): Pick<
  CursorPayload,
  "device" | "inode" | "birthtimeMs"
> {
  return {
    device: String(info.dev),
    inode: String(info.ino),
    birthtimeMs: String(info.birthtimeMs),
  };
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function cursorInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= minimum &&
      value <= maximum
    ? value
    : undefined;
}

function decodeCursor(cursor: string, path: string, info: Stats): CursorPayload {
  if (!cursor || Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES) {
    throw new ConfigurationError("JSONL page cursor가 올바르지 않습니다.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new ConfigurationError("JSONL page cursor를 해석할 수 없습니다.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigurationError("JSONL page cursor 형식이 올바르지 않습니다.");
  }
  const value = parsed as Record<string, unknown>;
  const observedSize = cursorInteger(value.observedSize, 0, Number.MAX_SAFE_INTEGER);
  const offset = cursorInteger(value.offset, 0, info.size);
  const lineNumber = cursorInteger(value.lineNumber, 1, Number.MAX_SAFE_INTEGER);
  const lineStartOffset = cursorInteger(value.lineStartOffset, 0, info.size);
  const currentIdentity = identity(info);
  if (
    value.version !== 1 ||
    value.pathHash !== pathHash(path) ||
    value.device !== currentIdentity.device ||
    value.inode !== currentIdentity.inode ||
    value.birthtimeMs !== currentIdentity.birthtimeMs ||
    observedSize === undefined ||
    info.size < observedSize ||
    offset === undefined ||
    lineNumber === undefined ||
    lineStartOffset === undefined ||
    lineStartOffset > offset ||
    typeof value.skippingOversized !== "boolean"
  ) {
    throw new StorageError(
      "JSONL 파일이 page cursor 생성 뒤 교체되거나 축소됐습니다.",
    );
  }
  return {
    version: 1,
    pathHash: String(value.pathHash),
    device: String(value.device),
    inode: String(value.inode),
    birthtimeMs: String(value.birthtimeMs),
    observedSize,
    offset,
    lineNumber,
    lineStartOffset,
    skippingOversized: value.skippingOversized,
  };
}

function assertJsonTree(
  value: unknown,
  label: string,
  maxDepth: number,
  maxNodes: number,
): asserts value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError(`${label}은 JSON 객체여야 합니다.`);
  }
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value, depth: 0 },
  ];
  const seen = new Set<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > maxNodes) {
      throw new ConfigurationError(`${label}의 JSON 항목 수가 너무 많습니다.`);
    }
    if (current.depth > maxDepth) {
      throw new ConfigurationError(`${label}의 JSON 중첩이 너무 깊습니다.`);
    }
    const item = current.value;
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    ) {
      continue;
    }
    if (typeof item !== "object") {
      throw new ConfigurationError(`${label}에 JSON이 아닌 값이 있습니다.`);
    }
    if (seen.has(item)) {
      throw new ConfigurationError(`${label}에 순환 참조가 있습니다.`);
    }
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(item) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ConfigurationError(`${label}에 일반 JSON 객체가 아닌 값이 있습니다.`);
    }
    for (const child of Object.values(item as Record<string, unknown>)) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function freezeJson(value: JsonValue): void {
  if (value === null || typeof value !== "object") return;
  const pending: object[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    for (const child of Array.isArray(item)
      ? item
      : Object.values(item as Record<string, JsonValue>)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
    Object.freeze(item);
  }
}

function assertJsonByteBudget(
  value: JsonObject,
  label: string,
  maximumBytes: number,
): void {
  const pending: JsonValue[] = [value];
  let bytes = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined || item === null) {
      bytes += 4;
    } else if (typeof item === "string") {
      bytes += Buffer.byteLength(item, "utf8") + 2;
    } else if (typeof item === "number" || typeof item === "boolean") {
      bytes += 32;
    } else if (Array.isArray(item)) {
      bytes += item.length + 2;
      for (const child of item) pending.push(child);
    } else {
      bytes += Object.keys(item).length + 2;
      for (const [key, child] of Object.entries(item)) {
        bytes += Buffer.byteLength(key, "utf8") + 3;
        pending.push(child);
      }
    }
    if (bytes > maximumBytes) {
      throw new ConfigurationError(`${label}이 JSON byte 제한을 초과했습니다.`);
    }
  }
}

function stableJsonObject(
  value: JsonObject,
  label: string,
  maxDepth: number,
  maxNodes: number,
  maxBytes = MAX_LINE_BYTES,
): JsonObject {
  assertJsonTree(value, label, maxDepth, maxNodes);
  assertJsonByteBudget(value, label, maxBytes);
  let serialized: string;
  try {
    const candidate = JSON.stringify(value);
    if (candidate === undefined) throw new Error("undefined_json");
    serialized = candidate;
  } catch {
    throw new ConfigurationError(`${label}을 JSON으로 복제할 수 없습니다.`);
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new ConfigurationError(`${label}이 JSON byte 제한을 초과했습니다.`);
  }
  const parsed = JSON.parse(serialized) as unknown;
  assertJsonTree(parsed, label, maxDepth, maxNodes);
  freezeJson(parsed);
  return parsed;
}

function redactJsonObject(
  value: JsonObject,
  redactor: Redactor,
  label: string,
  maxDepth: number,
  maxNodes: number,
  maxBytes: number,
): JsonObject {
  const cloned = stableJsonObject(
    value,
    label,
    maxDepth,
    maxNodes,
    maxBytes,
  );
  const mutable = JSON.parse(JSON.stringify(cloned)) as JsonObject;
  const pending: JsonValue[] = [mutable];
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined || item === null || typeof item !== "object") continue;
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index += 1) {
        const child = item[index];
        if (typeof child === "string") item[index] = redactor.redact(child);
        else if (child !== undefined) pending.push(child);
      }
      continue;
    }
    for (const [key, child] of Object.entries(item)) {
      if (redactor.redact(key) !== key) {
        throw new ConfigurationError(`${label}의 field 이름에 secret을 저장할 수 없습니다.`);
      }
      if (SENSITIVE_FIELD.test(key)) {
        item[key] = REDACTED;
      } else if (typeof child === "string") {
        item[key] = redactor.redact(child);
      } else {
        pending.push(child);
      }
    }
  }
  return mutable;
}

function parseLine<RecordValue>(
  parts: readonly Buffer[],
  lineBytes: number,
  position: { readonly lineNumber: number; readonly byteOffset: number },
  options: Required<
    Pick<JsonlReadOptions<RecordValue>, "label" | "maxDepth" | "maxNodes">
  > & Pick<JsonlReadOptions<RecordValue>, "decode">,
): RecordValue {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const text = decoder.decode(Buffer.concat(parts, lineBytes));
  const parsed = JSON.parse(text) as unknown;
  assertJsonTree(parsed, options.label, options.maxDepth, options.maxNodes);
  const stable = stableJsonObject(
    parsed,
    options.label,
    options.maxDepth,
    options.maxNodes,
  );
  return options.decode
    ? options.decode(stable, position)
    : stable as unknown as RecordValue;
}

export async function readJsonlPage<RecordValue = JsonObject>(
  path: string,
  options: JsonlReadOptions<RecordValue> = {},
): Promise<JsonlPage<RecordValue>> {
  assertStoragePath(path, "JSONL 저장");
  const label = boundedLabel(options.label);
  const limit = boundedInteger(
    options.limit,
    100,
    1,
    MAX_PAGE_RECORDS,
    "JSONL page record 수",
  );
  const maxLineBytes = boundedInteger(
    options.maxLineBytes,
    DEFAULT_MAX_LINE_BYTES,
    1_024,
    MAX_LINE_BYTES,
    "JSONL line byte",
  );
  const maxScanBytes = boundedInteger(
    options.maxScanBytes,
    DEFAULT_MAX_SCAN_BYTES,
    READ_CHUNK_BYTES,
    MAX_SCAN_BYTES,
    "JSONL page scan byte",
  );
  const maxDepth = boundedInteger(
    options.maxDepth,
    DEFAULT_MAX_DEPTH,
    1,
    100,
    "JSONL JSON 깊이",
  );
  const maxNodes = boundedInteger(
    options.maxNodes,
    DEFAULT_MAX_NODES,
    1,
    200_000,
    "JSONL JSON node 수",
  );

  let handle: FileHandle;
  try {
    handle = await open(resolve(path), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (errnoCode(error) === "ENOENT" && options.cursor === undefined) {
      return Object.freeze({
        records: Object.freeze([]),
        warnings: Object.freeze([]),
        omittedWarnings: 0,
        snapshotBytes: 0,
      });
    }
    if (errnoCode(error) === "ENOENT") {
      throw new StorageError("JSONL page cursor가 가리키는 파일이 없습니다.");
    }
    throw new StorageError(`${label}을 열 수 없습니다.`, { cause: error });
  }

  try {
    const info = await handle.stat();
    assertRegularFile(info, label);
    if (!Number.isSafeInteger(info.size) || info.size < 0) {
      throw new StorageError(`${label} 크기를 안전하게 표현할 수 없습니다.`);
    }
    if (options.requireOwner !== false) assertOwner(info, label);
    if (options.requirePrivateMode !== false) assertPrivateMode(info, label);
    const snapshotBytes = info.size;
    const start = options.cursor
      ? decodeCursor(options.cursor, path, info)
      : {
          version: 1 as const,
          pathHash: pathHash(path),
          ...identity(info),
          observedSize: snapshotBytes,
          offset: 0,
          lineNumber: 1,
          lineStartOffset: 0,
          skippingOversized: false,
        };
    let position = start.offset;
    const initialOffset = start.offset;
    let lineNumber = start.lineNumber;
    let lineStartOffset = start.lineStartOffset;
    let skippingOversized = start.skippingOversized;
    let lineBytes = 0;
    let parts: Buffer[] = [];
    let stopped = false;
    const records: JsonlPositionedRecord<RecordValue>[] = [];
    const warnings: JsonlWarning[] = [];
    let omittedWarnings = 0;

    const warn = (
      kind: JsonlWarningKind,
      message: string,
      warningLine = lineNumber,
      warningOffset = lineStartOffset,
    ): void => {
      if (warnings.length < MAX_PAGE_WARNINGS) {
        warnings.push(Object.freeze({
          kind,
          lineNumber: warningLine,
          byteOffset: warningOffset,
          message,
        }));
      } else {
        omittedWarnings += 1;
      }
    };

    const addSegment = (segment: Uint8Array): void => {
      if (segment.byteLength === 0 || skippingOversized) return;
      if (lineBytes + segment.byteLength > maxLineBytes) {
        parts = [];
        lineBytes = 0;
        skippingOversized = true;
        warn("oversized_record", `${label}의 line이 허용 크기를 초과했습니다.`);
        return;
      }
      parts.push(Buffer.from(segment));
      lineBytes += segment.byteLength;
    };

    const consumeTerminatedLine = (): void => {
      if (!skippingOversized) {
        if (lineBytes === 0) {
          warn("corrupt_record", `${label}에 빈 JSONL record가 있습니다.`);
        } else {
          try {
            const value = parseLine(
              parts,
              lineBytes,
              { lineNumber, byteOffset: lineStartOffset },
              {
                label,
                maxDepth,
                maxNodes,
                ...(options.decode ? { decode: options.decode } : {}),
              },
            );
            records.push(Object.freeze({
              value,
              lineNumber,
              byteOffset: lineStartOffset,
            }));
          } catch {
            warn(
              "corrupt_record",
              `${label}의 중간 record를 해석하지 못했습니다. 원본은 변경하지 않았습니다.`,
            );
          }
        }
      }
      parts = [];
      lineBytes = 0;
      skippingOversized = false;
    };

    while (position < snapshotBytes && !stopped) {
      const chunkStart = position;
      const wanted = Math.min(READ_CHUNK_BYTES, snapshotBytes - chunkStart);
      const chunk = Buffer.allocUnsafe(wanted);
      const { bytesRead } = await handle.read(chunk, 0, wanted, chunkStart);
      if (bytesRead <= 0) {
        throw new StorageError(`${label}이 page 읽기 중 축소됐습니다.`);
      }
      let segmentStart = 0;
      for (let index = 0; index < bytesRead; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        addSegment(chunk.subarray(segmentStart, index));
        consumeTerminatedLine();
        position = chunkStart + index + 1;
        lineNumber += 1;
        lineStartOffset = position;
        segmentStart = index + 1;
        if (
          records.length >= limit ||
          position - initialOffset >= maxScanBytes
        ) {
          stopped = position < snapshotBytes;
          break;
        }
      }
      if (stopped) break;
      addSegment(chunk.subarray(segmentStart, bytesRead));
      position = chunkStart + bytesRead;
      if (
        skippingOversized &&
        position - initialOffset >= maxScanBytes &&
        position < snapshotBytes
      ) {
        stopped = true;
      }
    }

    if (!stopped && position >= snapshotBytes) {
      if (skippingOversized || lineBytes > 0) {
        warn(
          "truncated_last_record",
          `${label}의 마지막 record가 줄바꿈 전에 끝났습니다. 원본은 변경하지 않았습니다.`,
        );
      }
      parts = [];
      lineBytes = 0;
    }

    const nextCursor = stopped
      ? encodeCursor({
          version: 1,
          pathHash: pathHash(path),
          ...identity(info),
          observedSize: snapshotBytes,
          offset: position,
          lineNumber,
          lineStartOffset,
          skippingOversized,
        })
      : undefined;
    return Object.freeze({
      records: Object.freeze(records),
      warnings: Object.freeze(warnings),
      omittedWarnings,
      snapshotBytes,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    });
  } finally {
    await handle.close();
  }
}

function timestamp(now: () => number): string {
  const value = now();
  const date = new Date(value);
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isFinite(date.getTime())
  ) {
    throw new ConfigurationError("JSONL writer 시간이 올바르지 않습니다.");
  }
  return date.toISOString();
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs;
}

async function readSmallHandle(handle: FileHandle, maximum: number): Promise<string> {
  const info = await handle.stat();
  if (!info.isFile() || info.size < 1 || info.size > maximum) return "";
  const data = Buffer.alloc(info.size);
  const { bytesRead } = await handle.read(data, 0, data.length, 0);
  return bytesRead === data.length ? data.toString("utf8") : "";
}

async function removeFailedOwnedLock(
  lockPath: string,
  lockHandle: FileHandle,
): Promise<void> {
  let pathHandle: FileHandle | undefined;
  try {
    const originalInfo = await lockHandle.stat();
    pathHandle = await open(lockPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const pathInfo = await pathHandle.stat();
    if (!sameIdentity(originalInfo, pathInfo)) return;
    await pathHandle.close();
    pathHandle = undefined;
    await unlink(lockPath);
  } catch {
    // 초기화 오류를 가리지 않으며, 소유권을 확인할 수 없는 lock은 자동 제거하지 않는다.
  } finally {
    if (pathHandle) await pathHandle.close().catch(() => undefined);
  }
}

export class JsonlWriterLease {
  readonly targetPath: string;
  readonly lockPath: string;
  readonly token: string;
  readonly #label: string;
  readonly #maxLineBytes: number;
  readonly #maxDepth: number;
  readonly #maxNodes: number;
  #secrets: readonly string[];
  #redactor: Redactor;
  #lockHandle: FileHandle | undefined;
  #released = false;
  #writing = false;

  constructor(
    targetPath: string,
    lockPath: string,
    token: string,
    lockHandle: FileHandle,
    options: {
      readonly label: string;
      readonly maxLineBytes: number;
      readonly maxDepth: number;
      readonly maxNodes: number;
      readonly secrets: readonly string[];
    },
  ) {
    this.targetPath = targetPath;
    this.lockPath = lockPath;
    this.token = token;
    this.#lockHandle = lockHandle;
    this.#label = options.label;
    this.#maxLineBytes = options.maxLineBytes;
    this.#maxDepth = options.maxDepth;
    this.#maxNodes = options.maxNodes;
    this.#secrets = options.secrets;
    this.#redactor = new Redactor(this.#secrets);
  }

  get released(): boolean {
    return this.#released;
  }

  addRedactionSecrets(secrets: readonly string[]): void {
    if (this.#released || !this.#lockHandle) {
      throw new StorageError("해제된 JSONL writer에는 redaction secret을 추가할 수 없습니다.");
    }
    if (this.#writing) {
      throw new StorageError("JSONL append 중에는 redaction secret을 변경할 수 없습니다.");
    }
    const selected = normalizeJsonlSecrets([...this.#secrets, ...secrets]);
    this.#secrets = selected;
    this.#redactor = new Redactor(selected);
  }

  async append(record: JsonObject): Promise<void> {
    if (this.#released || !this.#lockHandle) {
      throw new StorageError("해제된 JSONL writer lock으로 기록할 수 없습니다.");
    }
    if (this.#writing) {
      throw new StorageError("같은 JSONL writer에서 append를 동시에 실행할 수 없습니다.");
    }
    this.#writing = true;
    try {
      const safe = redactJsonObject(
        record,
        this.#redactor,
        this.#label,
        this.#maxDepth,
        this.#maxNodes,
        this.#maxLineBytes,
      );
      const serialized = JSON.stringify(safe);
      const line = Buffer.from(`${serialized}\n`, "utf8");
      if (line.byteLength > this.#maxLineBytes) {
        throw new StorageError(`${this.#label} record가 line 크기 제한을 초과했습니다.`);
      }
      await ensurePrivateDirectory(dirname(this.targetPath));
      const flags = fsConstants.O_CREAT |
        fsConstants.O_APPEND |
        fsConstants.O_RDWR |
        fsConstants.O_NOFOLLOW;
      let handle: FileHandle;
      try {
        handle = await open(this.targetPath, flags, 0o600);
      } catch (error) {
        throw new StorageError(`${this.#label}을 append용으로 열 수 없습니다.`, {
          cause: error,
        });
      }
      try {
        let info = await handle.stat();
        assertRegularFile(info, this.#label);
        assertOwner(info, this.#label);
        if (process.platform !== "win32") {
          await handle.chmod(0o600);
          info = await handle.stat();
          assertPrivateMode(info, this.#label);
        }
        let separator = Buffer.alloc(0);
        if (info.size > 0) {
          const last = Buffer.alloc(1);
          const read = await handle.read(last, 0, 1, info.size - 1);
          if (read.bytesRead !== 1) {
            throw new StorageError(`${this.#label}의 마지막 byte를 확인하지 못했습니다.`);
          }
          if (last[0] !== 0x0a) separator = Buffer.from("\n", "utf8");
        }
        const payload = separator.byteLength > 0
          ? Buffer.concat([separator, line], separator.byteLength + line.byteLength)
          : line;
        let written = 0;
        while (written < payload.byteLength) {
          const result = await handle.write(
            payload,
            written,
            payload.byteLength - written,
            null,
          );
          if (result.bytesWritten <= 0) {
            throw new StorageError(`${this.#label} append가 진행되지 않았습니다.`);
          }
          written += result.bytesWritten;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
    } finally {
      this.#writing = false;
    }
  }

  async release(): Promise<boolean> {
    if (this.#released) return false;
    if (this.#writing) {
      throw new StorageError("JSONL append 중에는 writer lock을 해제할 수 없습니다.");
    }
    this.#released = true;
    const lockHandle = this.#lockHandle;
    this.#lockHandle = undefined;
    if (!lockHandle) return false;
    let ownsPath = false;
    let pathHandle: FileHandle | undefined;
    try {
      const originalInfo = await lockHandle.stat();
      try {
        pathHandle = await open(
          this.lockPath,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
        const pathInfo = await pathHandle.stat();
        const contents = await readSmallHandle(pathHandle, MAX_LOCK_BYTES);
        ownsPath = sameIdentity(originalInfo, pathInfo) &&
          contents.includes(`"token":"${this.token}"`);
      } catch (error) {
        if (errnoCode(error) !== "ENOENT") throw error;
      } finally {
        await pathHandle?.close();
      }
    } finally {
      await lockHandle.close();
    }
    if (!ownsPath) return false;
    try {
      await unlink(this.lockPath);
      return true;
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return false;
      throw new StorageError("JSONL writer lock을 제거하지 못했습니다.", {
        cause: error,
      });
    }
  }
}

export async function acquireJsonlWriter(
  targetPath: string,
  options: JsonlWriterOptions = {},
): Promise<JsonlWriterLease> {
  assertStoragePath(targetPath, "JSONL writer 대상");
  if (options.lockPath !== undefined) {
    assertStoragePath(options.lockPath, "JSONL writer lock");
  }
  const absoluteTarget = resolve(targetPath);
  const lockPath = resolve(options.lockPath ?? `${absoluteTarget}.lock`);
  if (lockPath === absoluteTarget) {
    throw new ConfigurationError("JSONL writer lock과 대상 경로는 달라야 합니다.");
  }
  const label = boundedLabel(options.label);
  const secrets = normalizeJsonlSecrets(options.secrets ?? []);
  const maxLineBytes = boundedInteger(
    options.maxLineBytes,
    DEFAULT_MAX_LINE_BYTES,
    1_024,
    MAX_LINE_BYTES,
    "JSONL line byte",
  );
  const maxDepth = boundedInteger(
    options.maxDepth,
    DEFAULT_MAX_DEPTH,
    1,
    100,
    "JSONL JSON 깊이",
  );
  const maxNodes = boundedInteger(
    options.maxNodes,
    DEFAULT_MAX_NODES,
    1,
    200_000,
    "JSONL JSON node 수",
  );
  const now = options.now ?? Date.now;
  const token = randomUUID();
  await ensurePrivateDirectory(dirname(absoluteTarget));
  await ensurePrivateDirectory(dirname(lockPath));
  const flags = fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    fsConstants.O_RDWR |
    fsConstants.O_NOFOLLOW;
  let lockHandle: FileHandle;
  try {
    lockHandle = await open(lockPath, flags, 0o600);
  } catch (error) {
    if (errnoCode(error) === "EEXIST") {
      throw new StorageError(
        "JSONL writer lock이 이미 존재합니다. PID만 보고 자동 삭제하지 않습니다.",
      );
    }
    throw new StorageError("JSONL writer lock을 만들 수 없습니다.", {
      cause: error,
    });
  }

  try {
    if (process.platform !== "win32") {
      await lockHandle.chmod(0o600);
      assertPrivateMode(await lockHandle.stat(), "JSONL writer lock");
    }
    const lockRecord = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      token,
      pid: process.pid,
      createdAt: timestamp(now),
      targetHash: pathHash(absoluteTarget),
    }) + "\n", "utf8");
    if (lockRecord.byteLength > MAX_LOCK_BYTES) {
      throw new ConfigurationError("JSONL writer lock record가 너무 큽니다.");
    }
    let written = 0;
    while (written < lockRecord.byteLength) {
      const result = await lockHandle.write(
        lockRecord,
        written,
        lockRecord.byteLength - written,
        written,
      );
      if (result.bytesWritten <= 0) {
        throw new StorageError("JSONL writer lock 기록이 진행되지 않았습니다.");
      }
      written += result.bytesWritten;
    }
    await lockHandle.sync();
    return new JsonlWriterLease(
      absoluteTarget,
      lockPath,
      token,
      lockHandle,
      {
        label,
        maxLineBytes,
        maxDepth,
        maxNodes,
        secrets,
      },
    );
  } catch (error) {
    await removeFailedOwnedLock(lockPath, lockHandle);
    await lockHandle.close().catch(() => undefined);
    throw error;
  }
}

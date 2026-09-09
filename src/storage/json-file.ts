import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConfigurationError, StorageError } from "../core/errors.js";
import type { JsonObject, JsonValue } from "../core/json.js";

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_NODES = 20_000;
const MAX_CONFIGURED_BYTES = 64 * 1024 * 1024;

export interface JsonReadOptions {
  label?: string;
  maxBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
  requireOwner?: boolean;
  requirePrivateMode?: boolean;
}

export interface JsonWriteOptions {
  label?: string;
  maxBytes?: number;
  directoryMode?: number;
  fileMode?: number;
  requireOwner?: boolean;
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function currentUserId(): number | undefined {
  return process.platform !== "win32" && typeof process.geteuid === "function"
    ? process.geteuid()
    : undefined;
}

function assertOwned(uid: number, label: string): void {
  const expected = currentUserId();
  if (expected !== undefined && uid !== expected) {
    throw new StorageError(`${label}이 현재 사용자 소유가 아닙니다.`);
  }
}

function assertByteLimit(maxBytes: number): void {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_CONFIGURED_BYTES
  ) {
    throw new ConfigurationError(
      `JSON 크기 제한은 1–${MAX_CONFIGURED_BYTES} bytes 범위의 정수여야 합니다.`,
    );
  }
}

function assertPrivateMode(info: Stats, label: string): void {
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new StorageError(`${label}의 권한은 현재 사용자에게만 허용되어야 합니다.`);
  }
}

function assertJsonTree(
  value: unknown,
  label: string,
  maxDepth: number,
  maxNodes: number,
): asserts value is JsonValue {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
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
    if (Array.isArray(item)) {
      for (const child of item) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    if (typeof item === "object") {
      for (const child of Object.values(item as Record<string, unknown>)) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    throw new ConfigurationError(`${label}에 JSON으로 표현할 수 없는 값이 있습니다.`);
  }
}

function parseJson(text: string, label: string, options: JsonReadOptions): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 JSON 오류";
    const positionText = /position\s+(\d+)/iu.exec(message)?.[1];
    let location = "";
    if (positionText) {
      const position = Math.min(Number(positionText), text.length);
      const prefix = text.slice(0, position);
      const line = prefix.split("\n").length;
      const column = position - prefix.lastIndexOf("\n");
      location = `:${line}:${column}`;
    }
    throw new ConfigurationError(`${label}${location}의 JSON이 올바르지 않습니다.`, {
      cause: error,
    });
  }
  assertJsonTree(
    parsed,
    label,
    options.maxDepth ?? DEFAULT_MAX_DEPTH,
    options.maxNodes ?? DEFAULT_MAX_NODES,
  );
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigurationError(`${label}의 최상위 값은 객체여야 합니다.`);
  }
  return parsed;
}

export async function readJsonObject(
  path: string,
  options: JsonReadOptions = {},
): Promise<JsonObject | undefined> {
  const label = options.label ?? path;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  assertByteLimit(maxBytes);
  let parent: Stats;
  try {
    parent = await lstat(dirname(path));
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new StorageError(`${label}의 상위 경로를 확인할 수 없습니다.`, { cause: error });
  }
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new StorageError(`${label}의 상위 경로는 실제 디렉터리여야 합니다.`);
  }
  if (options.requireOwner) assertOwned(parent.uid, `${label}의 상위 경로`);
  if (options.requirePrivateMode) assertPrivateMode(parent, `${label}의 상위 경로`);

  let initial: Stats;
  try {
    initial = await lstat(path);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new StorageError(`${label}을 읽을 수 없습니다.`, { cause: error });
  }
  if (initial.isSymbolicLink() || !initial.isFile()) {
    throw new StorageError(`${label}은 실제 일반 파일이어야 합니다.`);
  }
  if (options.requireOwner) assertOwned(initial.uid, label);
  if (options.requirePrivateMode) assertPrivateMode(initial, label);
  if (initial.size > maxBytes) {
    throw new StorageError(`${label}이 허용 크기 ${maxBytes} bytes를 초과했습니다.`);
  }

  const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (opened.dev !== initial.dev || opened.ino !== initial.ino || !opened.isFile()) {
      throw new StorageError(`${label}이 읽는 동안 변경되었습니다.`);
    }
    if (options.requireOwner) assertOwned(opened.uid, label);
    if (options.requirePrivateMode) assertPrivateMode(opened, label);
    if (opened.size > maxBytes) {
      throw new StorageError(`${label}이 허용 크기 ${maxBytes} bytes를 초과했습니다.`);
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let totalRead = 0;
    while (totalRead < buffer.length) {
      const chunk = await handle.read(
        buffer,
        totalRead,
        buffer.length - totalRead,
        totalRead,
      );
      if (chunk.bytesRead === 0) break;
      totalRead += chunk.bytesRead;
    }
    if (totalRead > maxBytes) {
      throw new StorageError(`${label}이 허용 크기 ${maxBytes} bytes를 초과했습니다.`);
    }
    const completed = await handle.stat();
    if (
      completed.size !== opened.size ||
      completed.mtimeMs !== opened.mtimeMs ||
      completed.ctimeMs !== opened.ctimeMs
    ) {
      throw new StorageError(`${label}이 읽는 동안 변경되었습니다.`);
    }
    if (totalRead !== opened.size) {
      throw new StorageError(`${label}을 완전하게 읽지 못했습니다.`);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, totalRead),
      );
    } catch (error) {
      throw new ConfigurationError(`${label}은 UTF-8이어야 합니다.`, { cause: error });
    }
    return parseJson(text, label, options);
  } catch (error) {
    if (error instanceof ConfigurationError || error instanceof StorageError) {
      throw error;
    }
    throw new StorageError(`${label}을 읽을 수 없습니다.`, { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeJsonObjectAtomic(
  path: string,
  data: JsonObject,
  options: JsonWriteOptions = {},
): Promise<void> {
  const label = options.label ?? path;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  assertByteLimit(maxBytes);
  const parent = dirname(path);
  const directoryMode = options.directoryMode ?? 0o700;
  const fileMode = options.fileMode ?? 0o600;
  try {
    await mkdir(parent, { recursive: true, mode: directoryMode });
    const parentInfo = await lstat(parent);
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
      throw new StorageError(`${label}의 상위 경로는 실제 디렉터리여야 합니다.`);
    }
    if (options.requireOwner) assertOwned(parentInfo.uid, `${label}의 상위 경로`);
    if (process.platform !== "win32") await chmod(parent, directoryMode);

    try {
      const existing = await lstat(path);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new StorageError(`${label}은 실제 일반 파일이어야 합니다.`);
      }
      if (options.requireOwner) assertOwned(existing.uid, label);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError(`${label}의 저장 경로를 준비하지 못했습니다.`, {
      cause: error,
    });
  }

  let serialized: string;
  try {
    serialized = `${JSON.stringify(data, null, 2)}\n`;
  } catch (error) {
    throw new StorageError(`${label}의 JSON을 직렬화하지 못했습니다.`, { cause: error });
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new StorageError(`${label}이 허용 크기 ${maxBytes} bytes를 초과했습니다.`);
  }

  const temporary = join(parent, `.${randomUUID()}.${process.pid}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", fileMode);
    await handle.writeFile(serialized, { encoding: "utf8" });
    await handle.sync();
    if (process.platform !== "win32") await handle.chmod(fileMode);
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    throw new StorageError(`${label}을 원자적으로 저장하지 못했습니다.`, {
      cause: error,
    });
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

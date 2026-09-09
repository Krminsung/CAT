import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { ConfigurationError, StorageError } from "../core/errors.js";
import type { JsonObject, JsonValue } from "../core/json.js";
import {
  acquireJsonlWriter,
  normalizeJsonlSecrets,
  readJsonlPage,
  type JsonlPage,
  type JsonlWriterLease,
} from "./jsonl.js";

export const SESSION_SCHEMA_VERSION = 1;

export const TRANSCRIPT_RECORD_KINDS = [
  "message",
  "agent_event",
  "compaction",
  "checkpoint",
  "lifecycle",
] as const;

export type TranscriptRecordKind = (typeof TRANSCRIPT_RECORD_KINDS)[number];
export type SessionStatus = "active" | "closed";

export interface SessionMetadata {
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly status: SessionStatus;
  readonly provider?: string;
  readonly profile?: string;
  readonly responseId?: string;
  readonly name?: string;
  readonly parentSessionId?: string;
}

export interface StoredSessionRecord {
  readonly recordId: string;
  readonly writtenAt: string;
  readonly metadata: SessionMetadata;
}

export interface StoredTranscriptRecord {
  readonly recordId: string;
  readonly sessionId: string;
  readonly kind: TranscriptRecordKind;
  readonly createdAt: string;
  readonly data: Readonly<JsonObject>;
  readonly runId?: string;
}

export interface TranscriptAppendRequest {
  readonly kind: TranscriptRecordKind;
  readonly data?: JsonObject;
  readonly runId?: string;
  readonly createdAt?: string;
}

export interface TranscriptAppendReceipt {
  readonly recordId: string;
  readonly createdAt: string;
}

export interface SessionJsonlStoreOptions {
  readonly root: string;
  readonly secrets?: readonly string[];
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const RECORD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/u;
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SESSION_INDEX_LINE_BYTES = 256 * 1024;
const TRANSCRIPT_LINE_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_PAGE = 500;
const MAX_TRANSCRIPT_PAGE = 500;

function object(value: JsonValue | undefined, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError(`${label}은 객체여야 합니다.`);
  }
  return value;
}

function onlyKeys(value: JsonObject, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ConfigurationError(`${label}에 알 수 없는 ${key} field가 있습니다.`);
    }
  }
}

function identifier(
  value: JsonValue | undefined,
  pattern: RegExp,
  label: string,
): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ConfigurationError(`${label} 형식이 올바르지 않습니다.`);
  }
  return value;
}

function boundedText(
  value: JsonValue | undefined,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    [...value].length > maximum
  ) {
    throw new ConfigurationError(`${label} 형식이 올바르지 않습니다.`);
  }
  return value;
}

function optionalText(
  value: JsonValue | undefined,
  label: string,
  maximum: number,
): string | undefined {
  return value === undefined ? undefined : boundedText(value, label, maximum);
}

function isoTimestamp(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.length > 64) {
    throw new ConfigurationError(`${label}이 ISO timestamp가 아닙니다.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new ConfigurationError(`${label}이 정규화된 ISO timestamp가 아닙니다.`);
  }
  return value;
}

function revision(value: JsonValue | undefined): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new ConfigurationError("세션 revision이 올바르지 않습니다.");
  }
  return value;
}

export function assertSessionId(value: string): void {
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new ConfigurationError("세션 ID 형식이 올바르지 않습니다.");
  }
}

function assertRecordId(value: string): void {
  if (!RECORD_ID_PATTERN.test(value)) {
    throw new ConfigurationError("세션 record ID 형식이 올바르지 않습니다.");
  }
}

function normalizedMetadata(input: SessionMetadata): SessionMetadata {
  assertSessionId(input.sessionId);
  if (
    !isAbsolute(input.cwd) ||
    input.cwd.includes("\0") ||
    [...input.cwd].length > 4_096
  ) {
    throw new ConfigurationError("세션 cwd는 유효한 절대 경로여야 합니다.");
  }
  const model = boundedText(input.model, "세션 model", 256);
  const createdAt = isoTimestamp(input.createdAt, "세션 createdAt");
  const updatedAt = isoTimestamp(input.updatedAt, "세션 updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new ConfigurationError("세션 updatedAt이 createdAt보다 이를 수 없습니다.");
  }
  if (input.status !== "active" && input.status !== "closed") {
    throw new ConfigurationError("세션 status가 올바르지 않습니다.");
  }
  if (input.provider !== undefined && !PROFILE_ID_PATTERN.test(input.provider)) {
    throw new ConfigurationError("세션 provider ID가 올바르지 않습니다.");
  }
  if (input.profile !== undefined && !PROFILE_ID_PATTERN.test(input.profile)) {
    throw new ConfigurationError("세션 profile ID가 올바르지 않습니다.");
  }
  if (input.parentSessionId !== undefined) {
    assertSessionId(input.parentSessionId);
    if (input.parentSessionId === input.sessionId) {
      throw new ConfigurationError("세션은 자기 자신을 parent로 가질 수 없습니다.");
    }
  }
  const responseId = input.responseId === undefined
    ? undefined
    : boundedText(input.responseId, "세션 response ID", 512);
  const name = input.name === undefined
    ? undefined
    : boundedText(input.name, "세션 이름", 256).trim();
  return Object.freeze({
    sessionId: input.sessionId,
    cwd: resolve(input.cwd),
    model,
    createdAt,
    updatedAt,
    revision: revision(input.revision),
    status: input.status,
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    ...(responseId === undefined ? {} : { responseId }),
    ...(name === undefined ? {} : { name }),
    ...(input.parentSessionId === undefined
      ? {}
      : { parentSessionId: input.parentSessionId }),
  });
}

function metadataToJson(metadata: SessionMetadata): JsonObject {
  return {
    sessionId: metadata.sessionId,
    cwd: metadata.cwd,
    model: metadata.model,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    revision: metadata.revision,
    status: metadata.status,
    ...(metadata.provider === undefined ? {} : { provider: metadata.provider }),
    ...(metadata.profile === undefined ? {} : { profile: metadata.profile }),
    ...(metadata.responseId === undefined ? {} : { responseId: metadata.responseId }),
    ...(metadata.name === undefined ? {} : { name: metadata.name }),
    ...(metadata.parentSessionId === undefined
      ? {}
      : { parentSessionId: metadata.parentSessionId }),
  };
}

const METADATA_KEYS = new Set([
  "sessionId",
  "cwd",
  "model",
  "createdAt",
  "updatedAt",
  "revision",
  "status",
  "provider",
  "profile",
  "responseId",
  "name",
  "parentSessionId",
]);

function metadataFromJson(value: JsonValue | undefined): SessionMetadata {
  const raw = object(value, "세션 metadata");
  onlyKeys(raw, METADATA_KEYS, "세션 metadata");
  const status = raw.status;
  if (status !== "active" && status !== "closed") {
    throw new ConfigurationError("세션 status가 올바르지 않습니다.");
  }
  const sessionId = identifier(raw.sessionId, SESSION_ID_PATTERN, "세션 ID");
  const cwd = boundedText(raw.cwd, "세션 cwd", 4_096);
  const model = boundedText(raw.model, "세션 model", 256);
  const provider = optionalText(raw.provider, "세션 provider", 64);
  const profile = optionalText(raw.profile, "세션 profile", 64);
  const responseId = optionalText(raw.responseId, "세션 response ID", 512);
  const name = optionalText(raw.name, "세션 이름", 256);
  const parentSessionId = optionalText(raw.parentSessionId, "parent 세션 ID", 128);
  return normalizedMetadata({
    sessionId,
    cwd,
    model,
    createdAt: isoTimestamp(raw.createdAt, "세션 createdAt"),
    updatedAt: isoTimestamp(raw.updatedAt, "세션 updatedAt"),
    revision: revision(raw.revision),
    status,
    ...(provider === undefined ? {} : { provider }),
    ...(profile === undefined ? {} : { profile }),
    ...(responseId === undefined ? {} : { responseId }),
    ...(name === undefined ? {} : { name }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
  });
}

const SESSION_RECORD_KEYS = new Set([
  "schemaVersion",
  "recordType",
  "recordId",
  "writtenAt",
  "metadata",
]);

function sessionRecordFromJson(value: JsonObject): StoredSessionRecord {
  onlyKeys(value, SESSION_RECORD_KEYS, "세션 index record");
  if (
    value.schemaVersion !== SESSION_SCHEMA_VERSION ||
    value.recordType !== "session_metadata"
  ) {
    throw new ConfigurationError("세션 index record version 또는 종류가 올바르지 않습니다.");
  }
  const recordId = identifier(value.recordId, RECORD_ID_PATTERN, "세션 record ID");
  return Object.freeze({
    recordId,
    writtenAt: isoTimestamp(value.writtenAt, "세션 record writtenAt"),
    metadata: metadataFromJson(value.metadata),
  });
}

function transcriptKind(value: JsonValue | undefined): TranscriptRecordKind {
  if (
    typeof value !== "string" ||
    !(TRANSCRIPT_RECORD_KINDS as readonly string[]).includes(value)
  ) {
    throw new ConfigurationError("Transcript record 종류가 올바르지 않습니다.");
  }
  return value as TranscriptRecordKind;
}

const TRANSCRIPT_RECORD_KEYS = new Set([
  "schemaVersion",
  "recordType",
  "recordId",
  "sessionId",
  "kind",
  "createdAt",
  "runId",
  "data",
]);

function transcriptRecordFromJson(
  value: JsonObject,
  expectedSessionId: string,
): StoredTranscriptRecord {
  onlyKeys(value, TRANSCRIPT_RECORD_KEYS, "Transcript record");
  if (
    value.schemaVersion !== SESSION_SCHEMA_VERSION ||
    value.recordType !== "transcript"
  ) {
    throw new ConfigurationError("Transcript record version 또는 종류가 올바르지 않습니다.");
  }
  const sessionId = identifier(value.sessionId, SESSION_ID_PATTERN, "Transcript 세션 ID");
  if (sessionId !== expectedSessionId) {
    throw new ConfigurationError("Transcript record의 세션 ID가 파일 소유자와 다릅니다.");
  }
  const runId = optionalText(value.runId, "Transcript run ID", 256);
  return Object.freeze({
    recordId: identifier(value.recordId, RECORD_ID_PATTERN, "Transcript record ID"),
    sessionId,
    kind: transcriptKind(value.kind),
    createdAt: isoTimestamp(value.createdAt, "Transcript createdAt"),
    data: object(value.data, "Transcript data"),
    ...(runId === undefined ? {} : { runId }),
  });
}

function timestamp(now: () => number): string {
  const value = now();
  const date = new Date(value);
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isFinite(date.getTime())
  ) {
    throw new ConfigurationError("세션 저장 시간이 올바르지 않습니다.");
  }
  return date.toISOString();
}

export class SessionTranscriptWriter {
  readonly sessionId: string;
  readonly targetPath: string;
  readonly #lease: JsonlWriterLease;
  readonly #now: () => number;
  readonly #idFactory: () => string;

  constructor(
    sessionId: string,
    targetPath: string,
    lease: JsonlWriterLease,
    now: () => number,
    idFactory: () => string,
  ) {
    this.sessionId = sessionId;
    this.targetPath = targetPath;
    this.#lease = lease;
    this.#now = now;
    this.#idFactory = idFactory;
  }

  get released(): boolean {
    return this.#lease.released;
  }

  async append(request: TranscriptAppendRequest): Promise<TranscriptAppendReceipt> {
    if (
      !(TRANSCRIPT_RECORD_KINDS as readonly string[]).includes(request.kind)
    ) {
      throw new ConfigurationError("Transcript record 종류가 올바르지 않습니다.");
    }
    const recordId = this.#idFactory();
    assertRecordId(recordId);
    const createdAt = request.createdAt === undefined
      ? timestamp(this.#now)
      : isoTimestamp(request.createdAt, "Transcript createdAt");
    if (request.runId !== undefined) {
      boundedText(request.runId, "Transcript run ID", 256);
    }
    await this.#lease.append({
      schemaVersion: SESSION_SCHEMA_VERSION,
      recordType: "transcript",
      recordId,
      sessionId: this.sessionId,
      kind: request.kind,
      createdAt,
      ...(request.runId === undefined ? {} : { runId: request.runId }),
      data: request.data ?? {},
    });
    return Object.freeze({ recordId, createdAt });
  }

  async release(): Promise<boolean> {
    return await this.#lease.release();
  }
}

export class SessionJsonlStore {
  readonly root: string;
  readonly indexPath: string;
  readonly transcriptDirectory: string;
  readonly lockDirectory: string;
  readonly #secrets: readonly string[];
  readonly #now: () => number;
  readonly #idFactory: () => string;

  constructor(options: SessionJsonlStoreOptions) {
    if (
      !isAbsolute(options.root) ||
      options.root.includes("\0") ||
      /[\u0001-\u001f\u007f]/u.test(options.root) ||
      [...options.root].length > 4_096
    ) {
      throw new ConfigurationError("세션 저장소 root는 절대 경로여야 합니다.");
    }
    this.root = resolve(options.root);
    this.indexPath = join(this.root, "sessions.jsonl");
    this.transcriptDirectory = join(this.root, "transcripts");
    this.lockDirectory = join(this.root, "locks");
    this.#secrets = normalizeJsonlSecrets(options.secrets ?? []);
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  transcriptPath(sessionId: string): string {
    assertSessionId(sessionId);
    return join(this.transcriptDirectory, `${sessionId}.jsonl`);
  }

  async acquireTranscriptWriter(sessionId: string): Promise<SessionTranscriptWriter> {
    assertSessionId(sessionId);
    const targetPath = this.transcriptPath(sessionId);
    const lease = await acquireJsonlWriter(targetPath, {
      lockPath: join(this.lockDirectory, `${sessionId}.lock`),
      label: `세션 ${sessionId} transcript`,
      maxLineBytes: TRANSCRIPT_LINE_BYTES,
      maxDepth: 40,
      maxNodes: 40_000,
      secrets: this.#secrets,
      now: this.#now,
    });
    return new SessionTranscriptWriter(
      sessionId,
      targetPath,
      lease,
      this.#now,
      this.#idFactory,
    );
  }

  async saveSession(
    input: SessionMetadata,
    owner: SessionTranscriptWriter,
  ): Promise<StoredSessionRecord> {
    const metadata = normalizedMetadata(input);
    if (
      owner.released ||
      owner.sessionId !== metadata.sessionId ||
      owner.targetPath !== this.transcriptPath(metadata.sessionId)
    ) {
      throw new StorageError("세션 metadata를 기록할 transcript writer 소유권이 없습니다.");
    }
    const recordId = this.#idFactory();
    assertRecordId(recordId);
    const writtenAt = timestamp(this.#now);
    const record: JsonObject = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      recordType: "session_metadata",
      recordId,
      writtenAt,
      metadata: metadataToJson(metadata),
    };
    const writer = await acquireJsonlWriter(this.indexPath, {
      lockPath: join(this.lockDirectory, "sessions-index.lock"),
      label: "세션 index",
      maxLineBytes: SESSION_INDEX_LINE_BYTES,
      maxDepth: 12,
      maxNodes: 1_024,
      secrets: this.#secrets,
      now: this.#now,
    });
    try {
      await writer.append(record);
    } finally {
      await writer.release();
    }
    return Object.freeze({ recordId, writtenAt, metadata });
  }

  async readSessionPage(options: {
    readonly cursor?: string;
    readonly limit?: number;
  } = {}): Promise<JsonlPage<StoredSessionRecord>> {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SESSION_PAGE) {
      throw new ConfigurationError(`세션 page 크기는 1–${MAX_SESSION_PAGE} 범위여야 합니다.`);
    }
    return await readJsonlPage(this.indexPath, {
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      limit,
      label: "세션 index",
      maxLineBytes: SESSION_INDEX_LINE_BYTES,
      maxScanBytes: 8 * 1024 * 1024,
      maxDepth: 12,
      maxNodes: 1_024,
      decode: (value) => sessionRecordFromJson(value),
    });
  }

  async readTranscriptPage(
    sessionId: string,
    options: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<JsonlPage<StoredTranscriptRecord>> {
    assertSessionId(sessionId);
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TRANSCRIPT_PAGE) {
      throw new ConfigurationError(
        `Transcript page 크기는 1–${MAX_TRANSCRIPT_PAGE} 범위여야 합니다.`,
      );
    }
    return await readJsonlPage(this.transcriptPath(sessionId), {
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      limit,
      label: `세션 ${sessionId} transcript`,
      maxLineBytes: TRANSCRIPT_LINE_BYTES,
      maxScanBytes: 16 * 1024 * 1024,
      maxDepth: 40,
      maxNodes: 40_000,
      decode: (value) => transcriptRecordFromJson(value, sessionId),
    });
  }
}

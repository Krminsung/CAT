import { randomUUID } from "node:crypto";
import { ConfigurationError, StorageError } from "../core/errors.js";
import type { JsonObject, JsonValue } from "../core/json.js";
import type {
  CheckpointManager,
  CheckpointRestoreResult,
  CheckpointSummary,
} from "../storage/checkpoints.js";
import type { JsonlWarning } from "../storage/jsonl.js";
import { canonicalWorkspace } from "../storage/paths.js";
import {
  assertSessionId,
  normalizeSessionMetadata,
  SESSION_SCHEMA_VERSION,
  TRANSCRIPT_RECORD_KINDS,
  type SessionJsonlStore,
  type SessionMetadata,
  type SessionTranscriptWriter,
  type StoredSessionRecord,
  type StoredTranscriptRecord,
  type TranscriptAppendReceipt,
  type TranscriptAppendRequest,
} from "../storage/sessions.js";

const MAX_ACTIVE_SESSION_HANDLES = 32;
const SESSION_INDEX_PAGE_RECORDS = 250;
const MAX_SESSION_INDEX_RECORDS = 50_000;
const MAX_SESSION_INDEX_PAGES = 512;
const MAX_SESSION_INDEX_BYTES = 256 * 1024 * 1024;
const TRANSCRIPT_PAGE_RECORDS = 200;
const MAX_INHERIT_SOURCE_RECORDS = 100_000;
const MAX_INHERIT_SOURCE_PAGES = 512;
const MAX_INHERIT_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_INHERITED_RECORDS = 2_000;
const MAX_INHERITED_BYTES = 12 * 1024 * 1024;
const MAX_MEMORY_RECORDS = 2_500;
const MAX_MEMORY_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_MEMORY_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_LIFECYCLE_NOTICES = 128;
const MAX_STATE_CLEANERS = 32;
const RECORD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/u;
const CLEANER_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

export type SessionPersistence = "persistent" | "none";

export interface SessionLifecycleNotice {
  readonly code:
    | "corrupt_session_index"
    | "corrupt_transcript"
    | "history_truncated"
    | "omitted_warnings";
  readonly message: string;
}

export interface RestoredSessionConfiguration {
  readonly cwd: string;
  readonly model: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly responseId?: string;
}

export interface SessionHandle {
  readonly metadata: SessionMetadata;
  readonly persistence: SessionPersistence;
  readonly closed: boolean;
  readonly notices: readonly SessionLifecycleNotice[];
  appendTranscript(request: TranscriptAppendRequest): Promise<TranscriptAppendReceipt>;
}

export interface NewSessionRequest {
  readonly cwd: string;
  readonly model: string;
  readonly persistence?: SessionPersistence;
  readonly sessionId?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly responseId?: string;
  readonly name?: string;
}

export interface ResumeSessionRequest {
  readonly sessionId: string;
  readonly persistence?: SessionPersistence;
  readonly expectedCwd?: string;
}

export interface ContinueSessionRequest {
  readonly cwd: string;
  readonly persistence?: SessionPersistence;
}

export interface ForkSessionRequest {
  readonly persistence?: SessionPersistence;
  readonly name?: string;
  readonly sessionId?: string;
}

export interface SessionMetadataUpdate {
  readonly model?: string;
  readonly provider?: string | null;
  readonly profile?: string | null;
  readonly responseId?: string | null;
  readonly name?: string | null;
}

export interface SessionMetadataUpdateResult {
  readonly metadata: SessionMetadata;
  readonly transcriptStatus: "recorded" | "memory_only" | "record_failed";
  readonly transcriptError?: string;
}

export interface SessionCloseResult {
  readonly sessionId: string;
  readonly complete: boolean;
  readonly metadataRecorded: boolean;
  readonly transcriptRecorded: boolean;
  readonly lockReleased?: boolean;
  readonly failures: readonly string[];
}

export interface SessionRewindResult extends CheckpointRestoreResult {
  readonly transcriptStatus: "recorded" | "memory_only" | "record_failed";
  readonly transcriptError?: string;
  readonly scope: "workspace_files_only";
  readonly shellNetworkAndMcpReverted: false;
}

export interface SessionActiveRunPort {
  activeRunId(sessionId: string): string | undefined;
  acquireMaintenance(sessionId: string):
    | { readonly acquired: true; readonly lease: { release(): boolean } }
    | { readonly acquired: false; readonly activeRunId: string };
}

export interface SessionStateCleaner {
  readonly name: string;
  clearSession(sessionId: string): void | Promise<void>;
}

export interface SessionLifecycleServiceOptions {
  readonly store: SessionJsonlStore;
  readonly checkpoints: CheckpointManager;
  readonly activeRuns: SessionActiveRunPort;
  readonly stateCleaners?: readonly SessionStateCleaner[];
  readonly now?: () => number;
  readonly sessionIdFactory?: () => string;
  readonly recordIdFactory?: () => string;
}

interface IndexScanResult {
  readonly records: number;
  readonly notices: readonly SessionLifecycleNotice[];
}

interface SessionLookupResult extends IndexScanResult {
  readonly record?: StoredSessionRecord;
}

interface TranscriptCandidate {
  readonly request: TranscriptAppendRequest;
  readonly bytes: number;
}

interface CollectedHistory {
  readonly candidates: readonly TranscriptCandidate[];
  readonly notices: readonly SessionLifecycleNotice[];
}

interface JsonCloneState {
  nodes: number;
  readonly ancestors: WeakSet<object>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "알 수 없는 오류";
}

function timestamp(now: () => number, minimum?: string): string {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConfigurationError("세션 수명주기 시간이 올바르지 않습니다.");
  }
  const floor = minimum === undefined ? 0 : Date.parse(minimum);
  const selected = Math.max(value, Number.isFinite(floor) ? floor : 0);
  const date = new Date(selected);
  if (!Number.isFinite(date.getTime())) {
    throw new ConfigurationError("세션 수명주기 시간이 올바르지 않습니다.");
  }
  return date.toISOString();
}

function nextRevision(metadata: SessionMetadata): number {
  const value = metadata.revision + 1;
  if (!Number.isSafeInteger(value)) {
    throw new StorageError("세션 revision을 더 늘릴 수 없습니다.");
  }
  return value;
}

function boundedReason(value: string): string {
  const selected = value.trim();
  if (
    !selected ||
    [...selected].length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(selected)
  ) {
    throw new ConfigurationError("세션 종료 이유가 올바르지 않습니다.");
  }
  return selected;
}

function selectedPersistence(
  value: SessionPersistence | undefined,
  fallback: SessionPersistence,
): SessionPersistence {
  const selected = value ?? fallback;
  if (selected !== "persistent" && selected !== "none") {
    throw new ConfigurationError("세션 persistence 값이 올바르지 않습니다.");
  }
  return selected;
}

function defaultForkName(metadata: SessionMetadata): string {
  const suffix = " (fork)";
  const maximumBase = 256 - [...suffix].length;
  const base = [...(metadata.name ?? metadata.sessionId)]
    .slice(0, maximumBase)
    .join("");
  return `${base}${suffix}`;
}

function cloneJsonValue(
  value: unknown,
  depth: number,
  state: JsonCloneState,
): JsonValue {
  state.nodes += 1;
  if (state.nodes > 40_000 || depth > 40) {
    throw new ConfigurationError("메모리 transcript JSON 구조가 너무 큽니다.");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ConfigurationError("메모리 transcript에는 유한한 숫자만 쓸 수 있습니다.");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new ConfigurationError("메모리 transcript는 JSON 값만 포함해야 합니다.");
  }
  if (state.ancestors.has(value)) {
    throw new ConfigurationError("메모리 transcript에 순환 참조가 있습니다.");
  }
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const output = value.map((item) => cloneJsonValue(item, depth + 1, state));
      Object.freeze(output);
      return output;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ConfigurationError("메모리 transcript에는 일반 JSON 객체만 쓸 수 있습니다.");
    }
    const output: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = cloneJsonValue(item, depth + 1, state);
    }
    Object.freeze(output);
    return output;
  } finally {
    state.ancestors.delete(value);
  }
}

function cloneJsonObject(value: unknown): JsonObject {
  const copied = cloneJsonValue(value, 0, {
    nodes: 0,
    ancestors: new WeakSet<object>(),
  });
  if (copied === null || typeof copied !== "object" || Array.isArray(copied)) {
    throw new ConfigurationError("Transcript data는 JSON 객체여야 합니다.");
  }
  return copied;
}

function transcriptRecordBytes(record: StoredTranscriptRecord): number {
  const serialized = JSON.stringify(record);
  if (serialized === undefined) {
    throw new ConfigurationError("메모리 transcript record를 직렬화할 수 없습니다.");
  }
  return Buffer.byteLength(serialized, "utf8") + 1;
}

function newerRecord(
  current: StoredSessionRecord | undefined,
  candidate: StoredSessionRecord,
): StoredSessionRecord {
  if (!current) return candidate;
  if (candidate.metadata.revision !== current.metadata.revision) {
    return candidate.metadata.revision > current.metadata.revision
      ? candidate
      : current;
  }
  return candidate.writtenAt >= current.writtenAt ? candidate : current;
}

function laterSession(
  current: StoredSessionRecord | undefined,
  candidate: StoredSessionRecord,
): StoredSessionRecord {
  if (!current) return candidate;
  const updatedDifference = Date.parse(candidate.metadata.updatedAt) -
    Date.parse(current.metadata.updatedAt);
  if (updatedDifference !== 0) return updatedDifference > 0 ? candidate : current;
  if (candidate.writtenAt !== current.writtenAt) {
    return candidate.writtenAt > current.writtenAt ? candidate : current;
  }
  return candidate.metadata.sessionId > current.metadata.sessionId
    ? candidate
    : current;
}

function warningNotices(
  warnings: readonly JsonlWarning[],
  omittedWarnings: number,
  code: "corrupt_session_index" | "corrupt_transcript",
): SessionLifecycleNotice[] {
  const warningLimit = omittedWarnings > 0 || warnings.length > MAX_LIFECYCLE_NOTICES
    ? MAX_LIFECYCLE_NOTICES - 1
    : MAX_LIFECYCLE_NOTICES;
  const totalOmitted = omittedWarnings + Math.max(0, warnings.length - warningLimit);
  const notices: SessionLifecycleNotice[] = warnings.slice(0, warningLimit).map((warning) =>
    Object.freeze({ code, message: warning.message })
  );
  if (totalOmitted > 0) {
    notices.push(Object.freeze({
      code: "omitted_warnings",
      message: `${totalOmitted}개의 저장소 경고가 상한 때문에 생략되었습니다.`,
    }));
  }
  return notices;
}

function mergeNotices(
  ...groups: readonly (readonly SessionLifecycleNotice[])[]
): readonly SessionLifecycleNotice[] {
  const total = groups.reduce((sum, group) => sum + group.length, 0);
  const limit = total > MAX_LIFECYCLE_NOTICES
    ? MAX_LIFECYCLE_NOTICES - 1
    : MAX_LIFECYCLE_NOTICES;
  const output: SessionLifecycleNotice[] = [];
  for (const group of groups) {
    for (const notice of group) {
      if (output.length >= limit) break;
      output.push(Object.freeze({ ...notice }));
    }
    if (output.length >= limit) break;
  }
  if (total > MAX_LIFECYCLE_NOTICES) {
    output.push(Object.freeze({
      code: "omitted_warnings",
      message: `${total - limit}개의 세션 경고가 상한 때문에 생략되었습니다.`,
    }));
  }
  return Object.freeze(output);
}

class RecentTranscriptBuffer {
  readonly #items: TranscriptCandidate[] = [];
  #start = 0;
  #bytes = 0;
  #truncated = false;

  add(record: StoredTranscriptRecord): void {
    if (record.kind !== "message" && record.kind !== "compaction") return;
    const data = cloneJsonObject(record.data);
    const request: TranscriptAppendRequest = {
      kind: record.kind,
      data,
      createdAt: record.createdAt,
    };
    const serialized = JSON.stringify(request);
    if (serialized === undefined) {
      throw new ConfigurationError("분기할 transcript record를 직렬화할 수 없습니다.");
    }
    const bytes = Buffer.byteLength(serialized, "utf8") + 1;
    if (bytes > MAX_MEMORY_RECORD_BYTES || bytes > MAX_INHERITED_BYTES) {
      this.#truncated = true;
      return;
    }
    while (
      this.size >= MAX_INHERITED_RECORDS ||
      this.#bytes + bytes > MAX_INHERITED_BYTES
    ) {
      const removed = this.#items[this.#start];
      if (!removed) break;
      this.#bytes -= removed.bytes;
      this.#start += 1;
      this.#truncated = true;
    }
    this.#items.push(Object.freeze({ request: Object.freeze(request), bytes }));
    this.#bytes += bytes;
    if (this.#start >= 1_024 && this.#start * 2 >= this.#items.length) {
      this.#items.splice(0, this.#start);
      this.#start = 0;
    }
  }

  get size(): number {
    return this.#items.length - this.#start;
  }

  result(notices: readonly SessionLifecycleNotice[]): CollectedHistory {
    const truncation: SessionLifecycleNotice[] = this.#truncated
      ? [Object.freeze({
          code: "history_truncated",
          message: "분기 기록은 안전한 최근 대화 구간만 제한된 크기로 상속했습니다.",
        })]
      : [];
    return Object.freeze({
      candidates: Object.freeze(this.#items.slice(this.#start)),
      notices: mergeNotices(notices, truncation),
    });
  }
}

class ManagedSessionHandle implements SessionHandle {
  readonly owner: symbol;
  readonly persistence: SessionPersistence;
  readonly notices: readonly SessionLifecycleNotice[];
  readonly #store: SessionJsonlStore;
  readonly #now: () => number;
  readonly #recordIdFactory: () => string;
  #metadata: SessionMetadata;
  #writer: SessionTranscriptWriter | undefined;
  #closed = false;
  #operating = false;
  #memoryBytes = 0;
  readonly #memory: StoredTranscriptRecord[] = [];
  readonly #memoryRecordIds = new Set<string>();

  constructor(options: {
    readonly owner: symbol;
    readonly store: SessionJsonlStore;
    readonly metadata: SessionMetadata;
    readonly persistence: SessionPersistence;
    readonly writer?: SessionTranscriptWriter;
    readonly notices: readonly SessionLifecycleNotice[];
    readonly now: () => number;
    readonly recordIdFactory: () => string;
  }) {
    this.owner = options.owner;
    this.#store = options.store;
    this.#metadata = normalizeSessionMetadata(options.metadata);
    this.persistence = options.persistence;
    this.#writer = options.writer;
    this.notices = mergeNotices(options.notices);
    this.#now = options.now;
    this.#recordIdFactory = options.recordIdFactory;
    if ((this.persistence === "persistent") !== (this.#writer !== undefined)) {
      throw new ConfigurationError("세션 persistence와 writer 구성이 일치하지 않습니다.");
    }
  }

  get metadata(): SessionMetadata {
    return this.#metadata;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async appendTranscript(request: TranscriptAppendRequest): Promise<TranscriptAppendReceipt> {
    return await this.runExclusive(async () => await this.appendWithin(request));
  }

  async runExclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (this.#closed) throw new StorageError("닫힌 세션은 변경할 수 없습니다.");
    if (this.#operating) {
      throw new StorageError("같은 세션에서 수명주기 작업을 동시에 실행할 수 없습니다.");
    }
    this.#operating = true;
    try {
      return await operation();
    } finally {
      this.#operating = false;
    }
  }

  async appendWithin(request: TranscriptAppendRequest): Promise<TranscriptAppendReceipt> {
    if (this.#closed) throw new StorageError("닫힌 세션에는 기록할 수 없습니다.");
    if (this.#writer) return await this.#writer.append(request);
    if (!(TRANSCRIPT_RECORD_KINDS as readonly string[]).includes(request.kind)) {
      throw new ConfigurationError("Transcript record 종류가 올바르지 않습니다.");
    }
    const recordId = this.#recordIdFactory();
    if (!RECORD_ID_PATTERN.test(recordId)) {
      throw new ConfigurationError("메모리 transcript record ID가 올바르지 않습니다.");
    }
    if (this.#memoryRecordIds.has(recordId)) {
      throw new StorageError("메모리 transcript record ID가 중복되었습니다.");
    }
    const createdAt = request.createdAt ?? timestamp(this.#now);
    const createdMilliseconds = Date.parse(createdAt);
    const createdDate = new Date(createdMilliseconds);
    if (
      !Number.isFinite(createdMilliseconds) ||
      !Number.isFinite(createdDate.getTime()) ||
      createdDate.toISOString() !== createdAt
    ) {
      throw new ConfigurationError("메모리 transcript 시간이 올바르지 않습니다.");
    }
    if (
      request.runId !== undefined &&
      (!request.runId || request.runId.length > 256 || /[\u0000-\u001f\u007f]/u.test(request.runId))
    ) {
      throw new ConfigurationError("메모리 transcript run ID가 올바르지 않습니다.");
    }
    const data = cloneJsonObject(request.data ?? {});
    const record: StoredTranscriptRecord = Object.freeze({
      recordId,
      sessionId: this.#metadata.sessionId,
      kind: request.kind,
      createdAt,
      data,
      ...(request.runId === undefined ? {} : { runId: request.runId }),
    });
    const bytes = transcriptRecordBytes(record);
    if (bytes > MAX_MEMORY_RECORD_BYTES) {
      throw new StorageError("메모리 transcript record 크기 제한을 초과했습니다.");
    }
    if (
      this.#memory.length >= MAX_MEMORY_RECORDS ||
      this.#memoryBytes + bytes > MAX_MEMORY_TRANSCRIPT_BYTES
    ) {
      throw new StorageError(
        "메모리 transcript 상한에 도달했습니다. 영구 저장 없이 더 기록할 수 없습니다.",
      );
    }
    this.#memory.push(record);
    this.#memoryRecordIds.add(recordId);
    this.#memoryBytes += bytes;
    return Object.freeze({ recordId, createdAt });
  }

  memoryRecordsWithin(): readonly StoredTranscriptRecord[] {
    return Object.freeze([...this.#memory]);
  }

  writerWithin(): SessionTranscriptWriter {
    if (!this.#writer || this.persistence !== "persistent") {
      throw new StorageError("영구 세션 transcript writer가 없습니다.");
    }
    return this.#writer;
  }

  replaceMetadataWithin(metadata: SessionMetadata): void {
    if (metadata.sessionId !== this.#metadata.sessionId) {
      throw new StorageError("활성 세션의 ID를 변경할 수 없습니다.");
    }
    this.#metadata = normalizeSessionMetadata(metadata);
  }

  async releaseWriterWithin(): Promise<boolean | undefined> {
    const writer = this.#writer;
    this.#writer = undefined;
    return writer ? await writer.release() : undefined;
  }

  finishCloseWithin(): void {
    this.#memory.splice(0, this.#memory.length);
    this.#memoryRecordIds.clear();
    this.#memoryBytes = 0;
    this.#closed = true;
  }

  async abandonUnregistered(): Promise<boolean | undefined> {
    this.#memory.splice(0, this.#memory.length);
    this.#memoryRecordIds.clear();
    this.#memoryBytes = 0;
    this.#closed = true;
    const writer = this.#writer;
    this.#writer = undefined;
    return writer ? await writer.release() : undefined;
  }

  async persistWithin(metadata: SessionMetadata): Promise<SessionMetadata> {
    const stored = await this.#store.saveSession(metadata, this.writerWithin());
    return stored.metadata;
  }
}

export function restoredSessionConfiguration(
  handle: SessionHandle,
): RestoredSessionConfiguration {
  const metadata = handle.metadata;
  return Object.freeze({
    cwd: metadata.cwd,
    model: metadata.model,
    ...(metadata.provider === undefined ? {} : { provider: metadata.provider }),
    ...(metadata.profile === undefined ? {} : { profile: metadata.profile }),
    ...(metadata.responseId === undefined ? {} : { responseId: metadata.responseId }),
  });
}

export class SessionLifecycleService {
  readonly #store: SessionJsonlStore;
  readonly #checkpoints: CheckpointManager;
  readonly #activeRuns: SessionActiveRunPort;
  readonly #stateCleaners: readonly SessionStateCleaner[];
  readonly #now: () => number;
  readonly #sessionIdFactory: () => string;
  readonly #recordIdFactory: () => string;
  readonly #owner = Symbol("session-lifecycle");
  readonly #active = new Map<string, ManagedSessionHandle>();
  #opening = 0;

  constructor(options: SessionLifecycleServiceOptions) {
    this.#store = options.store;
    this.#checkpoints = options.checkpoints;
    this.#activeRuns = options.activeRuns;
    this.#now = options.now ?? Date.now;
    this.#sessionIdFactory = options.sessionIdFactory ?? (() => randomUUID().replaceAll("-", ""));
    this.#recordIdFactory = options.recordIdFactory ?? randomUUID;
    const cleaners = options.stateCleaners ?? [];
    if (cleaners.length > MAX_STATE_CLEANERS) {
      throw new ConfigurationError("세션 상태 정리기 수가 너무 많습니다.");
    }
    const names = new Set<string>();
    for (const cleaner of cleaners) {
      if (!CLEANER_NAME_PATTERN.test(cleaner.name) || names.has(cleaner.name)) {
        throw new ConfigurationError("세션 상태 정리기 이름이 올바르지 않습니다.");
      }
      names.add(cleaner.name);
    }
    this.#stateCleaners = Object.freeze([...cleaners]);
  }

  active(sessionId: string): SessionHandle | undefined {
    return this.#active.get(sessionId);
  }

  async create(request: NewSessionRequest): Promise<SessionHandle> {
    this.#assertCapacity();
    const cwd = await canonicalWorkspace(request.cwd);
    const persistence = selectedPersistence(request.persistence, "persistent");
    const sessionId = await this.#allocateSessionId(request.sessionId);
    await this.#clearIsolationState(sessionId, true);
    const createdAt = timestamp(this.#now);
    const metadata = normalizeSessionMetadata({
      sessionId,
      cwd,
      model: request.model,
      createdAt,
      updatedAt: createdAt,
      revision: 1,
      status: "active",
      ...(request.provider === undefined ? {} : { provider: request.provider }),
      ...(request.profile === undefined ? {} : { profile: request.profile }),
      ...(request.responseId === undefined ? {} : { responseId: request.responseId }),
      ...(request.name === undefined ? {} : { name: request.name }),
    });
    return await this.#initialize(
      metadata,
      persistence,
      [],
      [],
      { action: "session_started", source: "new", schemaVersion: SESSION_SCHEMA_VERSION },
      true,
    );
  }

  async resume(request: ResumeSessionRequest): Promise<SessionHandle> {
    this.#assertCapacity();
    assertSessionId(request.sessionId);
    const lookup = await this.#findSession(request.sessionId);
    if (!lookup.record) {
      throw new ConfigurationError(`세션을 찾을 수 없습니다: ${request.sessionId}`);
    }
    return await this.#resumeRecord(
      lookup.record,
      selectedPersistence(request.persistence, "persistent"),
      request.expectedCwd,
      lookup.notices,
      "resume",
    );
  }

  async continueLatest(request: ContinueSessionRequest): Promise<SessionHandle> {
    this.#assertCapacity();
    const cwd = await canonicalWorkspace(request.cwd);
    const lookup = await this.#latestSessionForCwd(cwd);
    if (!lookup.record) {
      throw new ConfigurationError("이 작업 폴더에 저장된 세션이 없습니다.");
    }
    return await this.#resumeRecord(
      lookup.record,
      selectedPersistence(request.persistence, "persistent"),
      cwd,
      lookup.notices,
      "continue",
    );
  }

  async fork(
    sourceHandle: SessionHandle,
    request: ForkSessionRequest = {},
  ): Promise<SessionHandle> {
    this.#assertCapacity();
    const source = this.#managed(sourceHandle);
    return await this.#withMaintenance(source.metadata.sessionId, async () => {
      return await source.runExclusive(async () => {
        const history = source.persistence === "persistent"
          ? await this.#collectStoredHistory(source.metadata.sessionId)
          : this.#collectMemoryHistory(source.memoryRecordsWithin());
        const targetId = await this.#allocateSessionId(request.sessionId);
        await this.#clearIsolationState(targetId, true);
        const createdAt = timestamp(this.#now);
        const metadata = normalizeSessionMetadata({
          sessionId: targetId,
          cwd: source.metadata.cwd,
          model: source.metadata.model,
          createdAt,
          updatedAt: createdAt,
          revision: 1,
          status: "active",
          parentSessionId: source.metadata.sessionId,
          ...(source.metadata.provider === undefined
            ? {}
            : { provider: source.metadata.provider }),
          ...(source.metadata.profile === undefined
            ? {}
            : { profile: source.metadata.profile }),
          ...(request.name === undefined
            ? { name: defaultForkName(source.metadata) }
            : { name: request.name }),
        });
        return await this.#initialize(
          metadata,
          selectedPersistence(request.persistence, source.persistence),
          history.candidates,
          history.notices,
          {
            action: "session_started",
            source: "fork",
            parentSessionId: source.metadata.sessionId,
            inheritedKinds: ["message", "compaction"],
            inheritedCheckpointOwnership: false,
            inheritedPermissionState: false,
            inheritedTaskState: false,
          },
          true,
        );
      });
    });
  }

  async rename(
    handle: SessionHandle,
    name: string,
  ): Promise<SessionMetadataUpdateResult> {
    if (!name.trim()) throw new ConfigurationError("세션 이름이 필요합니다.");
    return await this.update(handle, { name });
  }

  async update(
    handle: SessionHandle,
    update: SessionMetadataUpdate,
  ): Promise<SessionMetadataUpdateResult> {
    const managed = this.#managed(handle);
    return await this.#withMaintenance(managed.metadata.sessionId, async () => {
      return await managed.runExclusive(async () => {
        const current = managed.metadata;
        const updatedAt = timestamp(this.#now, current.createdAt);
        const provider = update.provider === null
          ? undefined
          : update.provider ?? current.provider;
        const profile = update.profile === null
          ? undefined
          : update.profile ?? current.profile;
        const responseId = update.responseId === null
          ? undefined
          : update.responseId ?? current.responseId;
        const name = update.name === null ? undefined : update.name ?? current.name;
        const next = normalizeSessionMetadata({
          sessionId: current.sessionId,
          cwd: current.cwd,
          model: update.model ?? current.model,
          createdAt: current.createdAt,
          updatedAt,
          revision: nextRevision(current),
          status: current.status,
          ...(provider === undefined ? {} : { provider }),
          ...(profile === undefined ? {} : { profile }),
          ...(responseId === undefined ? {} : { responseId }),
          ...(name === undefined ? {} : { name }),
          ...(current.parentSessionId === undefined
            ? {}
            : { parentSessionId: current.parentSessionId }),
        });
        const stored = managed.persistence === "persistent"
          ? await managed.persistWithin(next)
          : next;
        managed.replaceMetadataWithin(stored);
        try {
          await managed.appendWithin({
            kind: "lifecycle",
            data: {
              action: "session_metadata_updated",
              revision: stored.revision,
              ...(update.name === undefined ? {} : { renamed: true }),
            },
          });
          return Object.freeze({
            metadata: stored,
            transcriptStatus: managed.persistence === "persistent"
              ? "recorded"
              : "memory_only",
          });
        } catch (error) {
          return Object.freeze({
            metadata: stored,
            transcriptStatus: "record_failed",
            transcriptError: errorMessage(error),
          });
        }
      });
    });
  }

  latestCheckpoint(handle: SessionHandle): CheckpointSummary | undefined {
    const managed = this.#managed(handle);
    return this.#checkpoints.latest(managed.metadata.sessionId);
  }

  async rewind(handle: SessionHandle): Promise<SessionRewindResult> {
    const managed = this.#managed(handle);
    return await this.#withMaintenance(managed.metadata.sessionId, async () => {
      return await managed.runExclusive(async () => {
        const latest = this.#checkpoints.latest(managed.metadata.sessionId);
        if (!latest || latest.sessionId !== managed.metadata.sessionId) {
          throw new ConfigurationError("현재 세션이 소유한 파일 checkpoint가 없습니다.");
        }
        const result = await this.#checkpoints.rewind(managed.metadata.sessionId);
        let transcriptStatus: SessionRewindResult["transcriptStatus"] =
          managed.persistence === "persistent" ? "recorded" : "memory_only";
        let transcriptError: string | undefined;
        try {
          await managed.appendWithin({
            kind: "checkpoint",
            data: {
              action: "rewind",
              checkpointId: result.checkpointId,
              status: result.complete ? "completed" : "partial_failure",
              restored: [...result.restored],
              alreadyOriginal: [...result.alreadyOriginal],
              failures: [...result.failures],
              recordPreserved: result.recordPreserved,
              scope: "workspace_files_only",
              shellNetworkAndMcpReverted: false,
            },
          });
        } catch (error) {
          transcriptStatus = "record_failed";
          transcriptError = errorMessage(error);
        }
        return Object.freeze({
          ...result,
          transcriptStatus,
          ...(transcriptError === undefined ? {} : { transcriptError }),
          scope: "workspace_files_only",
          shellNetworkAndMcpReverted: false,
        });
      });
    });
  }

  async close(handle: SessionHandle, reason = "closed"): Promise<SessionCloseResult> {
    const managed = this.#managed(handle);
    const selectedReason = boundedReason(reason);
    const failures: string[] = [];
    let metadataRecorded = false;
    let transcriptRecorded = false;
    let lockReleased: boolean | undefined;
    const sessionId = managed.metadata.sessionId;

    await this.#withMaintenance(sessionId, async () => {
      await managed.runExclusive(async () => {
        const current = managed.metadata;
        const closed = normalizeSessionMetadata({
          ...current,
          updatedAt: timestamp(this.#now, current.createdAt),
          revision: nextRevision(current),
          status: "closed",
        });
        if (managed.persistence === "persistent") {
          try {
            const stored = await managed.persistWithin(closed);
            managed.replaceMetadataWithin(stored);
            metadataRecorded = true;
          } catch (error) {
            failures.push(`세션 metadata 종료 기록 실패: ${errorMessage(error)}`);
          }
          try {
            await managed.appendWithin({
              kind: "lifecycle",
              data: { action: "session_closed", reason: selectedReason },
            });
            transcriptRecorded = true;
          } catch (error) {
            failures.push(`세션 transcript 종료 기록 실패: ${errorMessage(error)}`);
          }
        }
        managed.replaceMetadataWithin(closed);
        try {
          lockReleased = await managed.releaseWriterWithin();
          if (managed.persistence === "persistent" && lockReleased !== true) {
            failures.push("세션 writer lock 소유권을 확인해 제거하지 못했습니다.");
          }
        } catch (error) {
          failures.push(`세션 writer lock 해제 실패: ${errorMessage(error)}`);
        }
        managed.finishCloseWithin();
      });
    });
    this.#active.delete(sessionId);

    for (const cleaner of this.#stateCleaners) {
      try {
        await cleaner.clearSession(sessionId);
      } catch (error) {
        failures.push(`${cleaner.name} 세션 상태 정리 실패: ${errorMessage(error)}`);
      }
    }
    if (managed.persistence === "none") {
      try {
        this.#checkpoints.clearSession(sessionId);
      } catch (error) {
        failures.push(`checkpoint 세션 상태 정리 실패: ${errorMessage(error)}`);
      }
    }
    return Object.freeze({
      sessionId,
      complete: failures.length === 0,
      metadataRecorded,
      transcriptRecorded,
      ...(lockReleased === undefined ? {} : { lockReleased }),
      failures: Object.freeze(failures),
    });
  }

  async #initialize(
    metadata: SessionMetadata,
    persistence: SessionPersistence,
    history: readonly TranscriptCandidate[],
    notices: readonly SessionLifecycleNotice[],
    lifecycleData: JsonObject,
    clearCheckpointsOnFailure: boolean,
  ): Promise<ManagedSessionHandle> {
    if (this.#active.has(metadata.sessionId)) {
      throw new StorageError("같은 세션이 이 process에서 이미 활성 상태입니다.");
    }
    this.#reserveCapacity();
    try {
      const writer = persistence === "persistent"
        ? await this.#store.acquireTranscriptWriter(metadata.sessionId)
        : undefined;
      const handle = new ManagedSessionHandle({
        owner: this.#owner,
        store: this.#store,
        metadata,
        persistence,
        ...(writer === undefined ? {} : { writer }),
        notices,
        now: this.#now,
        recordIdFactory: this.#recordIdFactory,
      });
      try {
        for (const item of history) await handle.appendWithin(item.request);
        await handle.appendWithin({ kind: "lifecycle", data: lifecycleData });
        if (persistence === "persistent") {
          const stored = await handle.persistWithin(metadata);
          handle.replaceMetadataWithin(stored);
        }
        this.#active.set(metadata.sessionId, handle);
        return handle;
      } catch (error) {
        const cleanupErrors: unknown[] = [error];
        try {
          const released = await handle.abandonUnregistered();
          if (persistence === "persistent" && released !== true) {
            cleanupErrors.push(new StorageError("실패한 세션의 writer lock을 제거하지 못했습니다."));
          }
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        try {
          await this.#clearIsolationState(
            metadata.sessionId,
            clearCheckpointsOnFailure,
          );
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        throw new StorageError("세션을 안전하게 열지 못했습니다.", {
          cause: new AggregateError(cleanupErrors),
        });
      }
    } finally {
      this.#opening -= 1;
    }
  }

  async #resumeRecord(
    record: StoredSessionRecord,
    persistence: SessionPersistence,
    expectedCwd: string | undefined,
    notices: readonly SessionLifecycleNotice[],
    source: "resume" | "continue",
  ): Promise<SessionHandle> {
    const stored = record.metadata;
    const cwd = await canonicalWorkspace(stored.cwd);
    if (expectedCwd !== undefined) {
      const expected = await canonicalWorkspace(expectedCwd);
      if (expected !== cwd) {
        throw new ConfigurationError(`세션의 작업 폴더가 다릅니다: ${stored.cwd}`);
      }
    }
    if (persistence === "none") {
      const history = await this.#collectStoredHistory(stored.sessionId);
      const sessionId = await this.#allocateSessionId();
      await this.#clearIsolationState(sessionId, true);
      const createdAt = timestamp(this.#now);
      const metadata = normalizeSessionMetadata({
        sessionId,
        cwd,
        model: stored.model,
        createdAt,
        updatedAt: createdAt,
        revision: 1,
        status: "active",
        parentSessionId: stored.sessionId,
        ...(stored.provider === undefined ? {} : { provider: stored.provider }),
        ...(stored.profile === undefined ? {} : { profile: stored.profile }),
        ...(stored.responseId === undefined ? {} : { responseId: stored.responseId }),
        ...(stored.name === undefined ? {} : { name: stored.name }),
      });
      return await this.#initialize(
        metadata,
        "none",
        history.candidates,
        mergeNotices(notices, history.notices),
        {
          action: "session_started",
          source,
          resumedFromSessionId: stored.sessionId,
          persistence: "none",
          restoredTrust: false,
          restoredCredentials: false,
        },
        true,
      );
    }
    return await this.#withMaintenance(stored.sessionId, async () => {
      if (this.#active.has(stored.sessionId)) {
        throw new StorageError("재개할 세션이 이 process에서 이미 활성 상태입니다.");
      }
      await this.#clearIsolationState(stored.sessionId, false);
      const updatedAt = timestamp(this.#now, stored.createdAt);
      const metadata = normalizeSessionMetadata({
        ...stored,
        cwd,
        updatedAt,
        revision: nextRevision(stored),
        status: "active",
      });
      return await this.#initialize(
        metadata,
        "persistent",
        [],
        notices,
        {
          action: "session_started",
          source,
          restoredTrust: false,
          restoredCredentials: false,
        },
        false,
      );
    });
  }

  async #allocateSessionId(requested?: string): Promise<string> {
    const value = requested ?? this.#sessionIdFactory();
    assertSessionId(value);
    if (this.#active.has(value)) {
      throw new StorageError("같은 세션 ID가 이 process에서 이미 사용 중입니다.");
    }
    const lookup = await this.#findSession(value);
    if (lookup.record) throw new StorageError(`세션 ID가 이미 존재합니다: ${value}`);
    const transcript = await this.#store.readTranscriptPage(value, { limit: 1 });
    if (transcript.snapshotBytes > 0) {
      throw new StorageError(`세션 transcript ID가 이미 존재합니다: ${value}`);
    }
    return value;
  }

  async #scanIndex(
    visit: (record: StoredSessionRecord) => void,
  ): Promise<IndexScanResult> {
    let cursor: string | undefined;
    let pages = 0;
    let records = 0;
    let snapshotBytes: number | undefined;
    let omittedWarnings = 0;
    const notices: SessionLifecycleNotice[] = [];
    const seenCursors = new Set<string>();
    while (true) {
      if (pages >= MAX_SESSION_INDEX_PAGES) {
        throw new StorageError("세션 index page 검색 상한을 초과했습니다.");
      }
      const page = await this.#store.readSessionPage({
        ...(cursor === undefined ? {} : { cursor }),
        limit: SESSION_INDEX_PAGE_RECORDS,
      });
      pages += 1;
      if (snapshotBytes === undefined) {
        snapshotBytes = page.snapshotBytes;
        if (snapshotBytes > MAX_SESSION_INDEX_BYTES) {
          throw new StorageError("세션 index 전체 크기 상한을 초과했습니다.");
        }
      } else if (snapshotBytes !== page.snapshotBytes) {
        throw new StorageError("세션 index가 page 검색 중 변경되었습니다.");
      }
      records += page.records.length;
      if (records > MAX_SESSION_INDEX_RECORDS) {
        throw new StorageError("세션 index record 검색 상한을 초과했습니다.");
      }
      for (const item of page.records) visit(item.value);
      omittedWarnings += page.omittedWarnings;
      for (const notice of warningNotices(
        page.warnings,
        0,
        "corrupt_session_index",
      )) {
        if (notices.length < MAX_LIFECYCLE_NOTICES) notices.push(notice);
        else omittedWarnings += 1;
      }
      const next = page.nextCursor;
      if (next === undefined) break;
      if (seenCursors.has(next)) {
        throw new StorageError("세션 index cursor가 반복되었습니다.");
      }
      seenCursors.add(next);
      cursor = next;
    }
    if (omittedWarnings > 0) {
      const omittedNotice: SessionLifecycleNotice = Object.freeze({
        code: "omitted_warnings",
        message: `${omittedWarnings}개의 세션 index 경고가 생략되었습니다.`,
      });
      if (notices.length < MAX_LIFECYCLE_NOTICES) notices.push(omittedNotice);
      else notices[MAX_LIFECYCLE_NOTICES - 1] = omittedNotice;
    }
    return Object.freeze({ records, notices: Object.freeze(notices) });
  }

  async #findSession(sessionId: string): Promise<SessionLookupResult> {
    let record: StoredSessionRecord | undefined;
    const scan = await this.#scanIndex((candidate) => {
      if (candidate.metadata.sessionId === sessionId) {
        record = newerRecord(record, candidate);
      }
    });
    return Object.freeze({
      ...scan,
      ...(record === undefined ? {} : { record }),
    });
  }

  async #latestSessionForCwd(cwd: string): Promise<SessionLookupResult> {
    const latestById = new Map<string, StoredSessionRecord>();
    const scan = await this.#scanIndex((candidate) => {
      latestById.set(
        candidate.metadata.sessionId,
        newerRecord(latestById.get(candidate.metadata.sessionId), candidate),
      );
    });
    let record: StoredSessionRecord | undefined;
    for (const candidate of latestById.values()) {
      if (candidate.metadata.cwd === cwd) record = laterSession(record, candidate);
    }
    return Object.freeze({
      ...scan,
      ...(record === undefined ? {} : { record }),
    });
  }

  async #collectStoredHistory(sessionId: string): Promise<CollectedHistory> {
    const buffer = new RecentTranscriptBuffer();
    const notices: SessionLifecycleNotice[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let records = 0;
    let snapshotBytes: number | undefined;
    let omittedWarnings = 0;
    while (true) {
      if (pages >= MAX_INHERIT_SOURCE_PAGES) {
        throw new StorageError("상속할 transcript page 검색 상한을 초과했습니다.");
      }
      const page = await this.#store.readTranscriptPage(sessionId, {
        ...(cursor === undefined ? {} : { cursor }),
        limit: TRANSCRIPT_PAGE_RECORDS,
      });
      pages += 1;
      if (snapshotBytes === undefined) {
        snapshotBytes = page.snapshotBytes;
        if (snapshotBytes > MAX_INHERIT_SOURCE_BYTES) {
          throw new StorageError(
            "상속할 transcript가 직접 분기할 수 있는 크기 상한을 초과했습니다. 먼저 압축해야 합니다.",
          );
        }
      } else if (snapshotBytes !== page.snapshotBytes) {
        throw new StorageError("상속할 transcript가 page 검색 중 변경되었습니다.");
      }
      records += page.records.length;
      if (records > MAX_INHERIT_SOURCE_RECORDS) {
        throw new StorageError("상속할 transcript record 검색 상한을 초과했습니다.");
      }
      for (const item of page.records) buffer.add(item.value);
      omittedWarnings += page.omittedWarnings;
      for (const notice of warningNotices(page.warnings, 0, "corrupt_transcript")) {
        if (notices.length < MAX_LIFECYCLE_NOTICES) notices.push(notice);
        else omittedWarnings += 1;
      }
      const next = page.nextCursor;
      if (next === undefined) break;
      if (seenCursors.has(next)) {
        throw new StorageError("Transcript cursor가 반복되었습니다.");
      }
      seenCursors.add(next);
      cursor = next;
    }
    if (omittedWarnings > 0) {
      const omittedNotice: SessionLifecycleNotice = Object.freeze({
        code: "omitted_warnings",
        message: `${omittedWarnings}개의 transcript 경고가 생략되었습니다.`,
      });
      if (notices.length < MAX_LIFECYCLE_NOTICES) notices.push(omittedNotice);
      else notices[MAX_LIFECYCLE_NOTICES - 1] = omittedNotice;
    }
    return buffer.result(notices);
  }

  #collectMemoryHistory(
    records: readonly StoredTranscriptRecord[],
  ): CollectedHistory {
    const buffer = new RecentTranscriptBuffer();
    for (const record of records) buffer.add(record);
    return buffer.result([]);
  }

  #managed(handle: SessionHandle): ManagedSessionHandle {
    if (!(handle instanceof ManagedSessionHandle) || handle.owner !== this.#owner) {
      throw new ConfigurationError("이 수명주기 서비스가 소유한 세션 handle이 아닙니다.");
    }
    const active = this.#active.get(handle.metadata.sessionId);
    if (active !== handle || handle.closed) {
      throw new StorageError("세션 handle이 더 이상 활성 상태가 아닙니다.");
    }
    return handle;
  }

  #assertCapacity(): void {
    if (this.#active.size + this.#opening >= MAX_ACTIVE_SESSION_HANDLES) {
      throw new StorageError("동시에 열 수 있는 세션 handle 상한에 도달했습니다.");
    }
  }

  #reserveCapacity(): void {
    this.#assertCapacity();
    this.#opening += 1;
  }

  async #withMaintenance<Result>(
    sessionId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const acquired = this.#activeRuns.acquireMaintenance(sessionId);
    if (!acquired.acquired) {
      throw new StorageError(
        `활성 run ${acquired.activeRunId}이 끝나기 전에는 세션을 전환할 수 없습니다.`,
      );
    }
    let outcome:
      | { readonly ok: true; readonly value: Result }
      | { readonly ok: false; readonly error: unknown };
    try {
      outcome = { ok: true, value: await operation() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    const released = acquired.lease.release();
    if (!outcome.ok) {
      if (!released) {
        throw new StorageError("세션 maintenance lease 해제에도 실패했습니다.", {
          cause: new AggregateError([outcome.error]),
        });
      }
      throw outcome.error;
    }
    if (!released) {
      throw new StorageError("세션 maintenance lease 소유권을 확인해 해제하지 못했습니다.");
    }
    return outcome.value;
  }

  async #clearIsolationState(
    sessionId: string,
    includeCheckpoints: boolean,
  ): Promise<void> {
    const failures: unknown[] = [];
    for (const cleaner of this.#stateCleaners) {
      try {
        await cleaner.clearSession(sessionId);
      } catch (error) {
        failures.push(new StorageError(`${cleaner.name} 세션 상태를 정리하지 못했습니다.`, {
          cause: error,
        }));
      }
    }
    if (includeCheckpoints) {
      try {
        this.#checkpoints.clearSession(sessionId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new StorageError("격리된 세션 상태를 준비하지 못했습니다.", {
        cause: new AggregateError(failures),
      });
    }
  }
}

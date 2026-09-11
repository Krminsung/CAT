import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  type Dirent,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { JsonObject } from "../core/json.js";
import { ConfigurationError, StorageError } from "../core/errors.js";

const TASK_ID = /^[a-f0-9]{16}$/u;
const TASK_ID_PREFIX = /^[a-f0-9]{1,16}$/u;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MANIFEST_FILE = /^([a-f0-9]{16})\.json$/u;
const MANIFEST_STATUSES = new Set<BackgroundTaskStatus>([
  "starting",
  "running",
  "completed",
  "failed",
  "stopped",
  "timed_out",
  "stale",
  "unknown",
]);
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_READ_BYTES = 60_000;
const MAX_READ_BYTES = 96 * 1024;
const MAX_RUNNING_TASKS = 8;
const MAX_SESSION_TASKS = 64;
const MAX_MANAGED_TASKS = 128;
const MAX_RESTORED_TASKS = 256;
const MAX_DIRECTORY_ENTRIES = 4_096;
const MAX_MANIFEST_BYTES = 128 * 1024;
const DEFAULT_DEADLINE_SECONDS = 3_600;
const MAX_DEADLINE_SECONDS = 86_400;
const TERMINATE_GRACE_MS = 1_000;
const KILL_GRACE_MS = 1_000;
const STOP_WAIT_MS = TERMINATE_GRACE_MS + KILL_GRACE_MS + 1_000;
const LOG_MAGIC = Buffer.from("CATTASK1", "ascii");
const LOG_HEADER_BYTES = 32;
const LOG_VERSION = 1;
const TRUNCATION_NOTICE = Buffer.from("[... 이전 background 출력 생략 ...]\n", "utf8");

export type BackgroundTaskStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "timed_out"
  | "stale"
  | "unknown";

export interface BackgroundTaskManagerOptions {
  readonly workspace: string;
  readonly storageRoot: string;
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

export interface BackgroundTaskStartRequest {
  readonly sessionId: string;
  readonly command: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly deadlineSeconds?: number;
}

export interface BackgroundTaskIdentity {
  readonly taskId: string;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly commandDigest: string;
}

export interface BackgroundTaskStopResult {
  readonly task: JsonObject;
  readonly signalSent: boolean;
  readonly terminationConfirmed: boolean;
  readonly alreadyTerminal: boolean;
}

export interface BackgroundTaskCloseResult {
  readonly complete: boolean;
  readonly failures: readonly string[];
}

interface PersistedTaskManifest {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly sessionId: string;
  readonly command: string;
  readonly workspace: string;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly status: BackgroundTaskStatus;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  readonly timedOut: boolean;
  readonly stopRequested: boolean;
  readonly terminationConfirmed: boolean;
  readonly outputError: string | null;
}

interface LogState {
  readonly stored: number;
  readonly writeOffset: number;
  readonly wrapped: boolean;
  readonly seen: number;
  readonly saturated: boolean;
}

interface BackgroundTaskRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly command: string;
  readonly startedAt: string;
  readonly startedMs: number;
  readonly deadlineAt: string;
  readonly deadlineMs: number;
  readonly outputPath: string;
  readonly manifestPath: string;
  readonly ownedHere: boolean;
  child: ChildProcess | undefined;
  pid: number | undefined;
  outputDescriptor: number | undefined;
  outputBytesSeen: number;
  outputBytesStored: number;
  outputWriteOffset: number;
  outputWrapped: boolean;
  outputCounterSaturated: boolean;
  outputPending: boolean;
  outputError: string | undefined;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  exitSignal: string | null;
  timedOut: boolean;
  stopRequested: boolean;
  terminationConfirmed: boolean;
  closed: boolean;
  deadlineTimer: NodeJS.Timeout | undefined;
  killTimer: NodeJS.Timeout | undefined;
  forceTimer: NodeJS.Timeout | undefined;
  readonly closeWaiters: Set<() => void>;
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "알 수 없는 오류";
}

function assertSessionId(value: string): void {
  if (!SESSION_ID.test(value)) throw new ConfigurationError("background task session ID가 올바르지 않습니다.");
}

function assertCommand(value: string): void {
  if (!value.trim() || value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_COMMAND_BYTES) {
    throw new ConfigurationError("background task 명령이 비어 있거나 크기 제한을 초과했습니다.");
  }
}

function assertDeadlineSeconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DEADLINE_SECONDS) {
    throw new ConfigurationError(
      `background task deadline_seconds는 1–${MAX_DEADLINE_SECONDS} 사이의 정수여야 합니다.`,
    );
  }
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) return undefined;
  return milliseconds;
}

function cleanText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "�");
}

function boundedError(value: string): string {
  const clean = cleanText(value);
  const bytes = Buffer.from(clean, "utf8");
  if (bytes.byteLength <= 4_096) return clean;
  let end = 4_093;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}…`;
}

function writeAll(descriptor: number, data: Buffer, position: number): void {
  let offset = 0;
  while (offset < data.byteLength) {
    const written = writeSync(
      descriptor,
      data,
      offset,
      data.byteLength - offset,
      position + offset,
    );
    if (written <= 0) throw new StorageError("background task 로그 쓰기가 진전되지 않았습니다.");
    offset += written;
  }
}

function readInto(
  descriptor: number,
  target: Buffer,
  targetOffset: number,
  length: number,
  position: number,
): number {
  let total = 0;
  while (total < length) {
    const amount = readSync(
      descriptor,
      target,
      targetOffset + total,
      length - total,
      position + total,
    );
    if (amount <= 0) break;
    total += amount;
  }
  return total;
}

function logHeader(task: BackgroundTaskRecord): Buffer {
  const header = Buffer.alloc(LOG_HEADER_BYTES);
  LOG_MAGIC.copy(header, 0);
  header.writeUInt32LE(LOG_VERSION, 8);
  header.writeUInt32LE(task.outputBytesStored, 12);
  header.writeUInt32LE(task.outputWriteOffset, 16);
  header.writeUInt32LE(
    (task.outputWrapped ? 1 : 0) | (task.outputCounterSaturated ? 2 : 0),
    20,
  );
  header.writeBigUInt64LE(BigInt(task.outputBytesSeen), 24);
  return header;
}

function parseLogHeader(header: Buffer): LogState {
  if (
    header.byteLength !== LOG_HEADER_BYTES ||
    !header.subarray(0, LOG_MAGIC.byteLength).equals(LOG_MAGIC) ||
    header.readUInt32LE(8) !== LOG_VERSION
  ) {
    throw new StorageError("background task 로그 header가 올바르지 않습니다.");
  }
  const stored = header.readUInt32LE(12);
  const writeOffset = header.readUInt32LE(16);
  const flags = header.readUInt32LE(20);
  const rawSeen = header.readBigUInt64LE(24);
  if (
    stored > MAX_OUTPUT_BYTES ||
    writeOffset >= MAX_OUTPUT_BYTES ||
    (flags & ~3) !== 0 ||
    rawSeen > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new StorageError("background task 로그 상태가 허용 범위를 벗어났습니다.");
  }
  const seen = Number(rawSeen);
  const wrapped = (flags & 1) !== 0;
  if (
    seen < stored ||
    (!wrapped && writeOffset !== (stored % MAX_OUTPUT_BYTES)) ||
    (wrapped && stored !== MAX_OUTPUT_BYTES)
  ) {
    throw new StorageError("background task 로그 위치 정보가 일치하지 않습니다.");
  }
  return {
    stored,
    writeOffset,
    wrapped,
    seen,
    saturated: (flags & 2) !== 0,
  };
}

function openVerifiedRegularFile(path: string): number {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new StorageError("background task 로그가 일반 파일이 아닙니다.");
  }
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const descriptor = openSync(path, fsConstants.O_RDONLY | noFollow);
  const after = fstatSync(descriptor);
  if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
    closeSync(descriptor);
    throw new StorageError("background task 로그 identity가 읽기 전에 변경되었습니다.");
  }
  return descriptor;
}

function readLogState(path: string): LogState {
  const descriptor = openVerifiedRegularFile(path);
  try {
    const header = Buffer.alloc(LOG_HEADER_BYTES);
    if (readInto(descriptor, header, 0, header.byteLength, 0) !== header.byteLength) {
      throw new StorageError("background task 로그 header를 전부 읽지 못했습니다.");
    }
    return parseLogHeader(header);
  } finally {
    closeSync(descriptor);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(
  value: unknown,
  expectedId: string,
  expectedWorkspace: string,
): PersistedTaskManifest | undefined {
  if (!isRecord(value)) return undefined;
  const status = value.status;
  const startedMs = parseTimestamp(value.startedAt);
  const deadlineMs = parseTimestamp(value.deadlineAt);
  const command = value.command;
  const sessionId = value.sessionId;
  const exitCode = value.exitCode;
  const exitSignal = value.exitSignal;
  const outputError = value.outputError;
  if (
    value.schemaVersion !== 1 ||
    value.taskId !== expectedId ||
    value.workspace !== expectedWorkspace ||
    typeof command !== "string" ||
    !command.trim() ||
    command.includes("\0") ||
    Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES ||
    typeof sessionId !== "string" ||
    !SESSION_ID.test(sessionId) ||
    typeof status !== "string" ||
    !MANIFEST_STATUSES.has(status as BackgroundTaskStatus) ||
    startedMs === undefined ||
    deadlineMs === undefined ||
    deadlineMs < startedMs ||
    (exitCode !== null && (
      typeof exitCode !== "number" ||
      !Number.isSafeInteger(exitCode) ||
      exitCode < -255 ||
      exitCode > 255
    )) ||
    (exitSignal !== null && (typeof exitSignal !== "string" || exitSignal.length > 32)) ||
    typeof value.timedOut !== "boolean" ||
    typeof value.stopRequested !== "boolean" ||
    typeof value.terminationConfirmed !== "boolean" ||
    (outputError !== null && (typeof outputError !== "string" || Buffer.byteLength(outputError, "utf8") > 4_096))
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    taskId: expectedId,
    sessionId,
    command,
    workspace: expectedWorkspace,
    startedAt: value.startedAt as string,
    deadlineAt: value.deadlineAt as string,
    status: status as BackgroundTaskStatus,
    exitCode: exitCode as number | null,
    exitSignal: exitSignal as string | null,
    timedOut: value.timedOut,
    stopRequested: value.stopRequested,
    terminationConfirmed: value.terminationConfirmed,
    outputError: outputError as string | null,
  };
}

function taskManifest(task: BackgroundTaskRecord, workspace: string): PersistedTaskManifest {
  return {
    schemaVersion: 1,
    taskId: task.id,
    sessionId: task.sessionId,
    command: task.command,
    workspace,
    startedAt: task.startedAt,
    deadlineAt: task.deadlineAt,
    status: task.status,
    exitCode: task.exitCode,
    exitSignal: task.exitSignal,
    timedOut: task.timedOut,
    stopRequested: task.stopRequested,
    terminationConfirmed: task.terminationConfirmed,
    outputError: task.outputError ?? null,
  };
}

function statusIsActive(task: BackgroundTaskRecord): boolean {
  return task.child !== undefined && !task.closed;
}

export class BackgroundTaskManager {
  readonly workspace: string;
  readonly storageDirectory: string;
  readonly #now: () => number;
  readonly #idFactory: () => string;
  readonly #tasks = new Map<string, BackgroundTaskRecord>();
  #scanTruncated = false;
  #closed = false;

  constructor(options: BackgroundTaskManagerOptions) {
    if (
      !isAbsolute(options.workspace) ||
      options.workspace.includes("\0") ||
      !isAbsolute(options.storageRoot) ||
      options.storageRoot.includes("\0")
    ) {
      throw new ConfigurationError("background task 경로가 올바르지 않습니다.");
    }
    const workspace = realpathSync(resolve(options.workspace));
    const workspaceInfo = lstatSync(workspace);
    if (!workspaceInfo.isDirectory()) {
      throw new ConfigurationError("background task workspace가 디렉터리가 아닙니다.");
    }
    this.workspace = workspace;
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? (() => randomBytes(8).toString("hex"));

    const storageRoot = resolve(options.storageRoot);
    mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
    const rootInfo = lstatSync(storageRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new StorageError("background task 저장소가 일반 디렉터리가 아닙니다.");
    }
    const workspaceKey = createHash("sha256").update(workspace, "utf8").digest("hex");
    const requestedDirectory = join(storageRoot, workspaceKey);
    mkdirSync(requestedDirectory, { recursive: true, mode: 0o700 });
    const directoryInfo = lstatSync(requestedDirectory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new StorageError("workspace별 background task 저장소가 일반 디렉터리가 아닙니다.");
    }
    try {
      chmodSync(storageRoot, 0o700);
      chmodSync(requestedDirectory, 0o700);
    } catch (error) {
      if (process.platform !== "win32") {
        throw new StorageError("background task 저장소 권한을 0700으로 설정하지 못했습니다.", {
          cause: error,
        });
      }
    }
    this.storageDirectory = realpathSync(requestedDirectory);
    this.#restorePersistedTasks();
  }

  get scanTruncated(): boolean {
    return this.#scanTruncated;
  }

  start(request: BackgroundTaskStartRequest): JsonObject {
    if (this.#closed) throw new StorageError("닫힌 background task manager에서는 작업을 시작할 수 없습니다.");
    assertSessionId(request.sessionId);
    assertCommand(request.command);
    const deadlineSeconds = request.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS;
    assertDeadlineSeconds(deadlineSeconds);
    this.#pruneForCapacity(request.sessionId);
    if (this.#activeCount() >= MAX_RUNNING_TASKS) {
      throw new StorageError(`동시에 실행할 수 있는 background task는 최대 ${MAX_RUNNING_TASKS}개입니다.`);
    }

    const startedMs = this.#now();
    if (!Number.isSafeInteger(startedMs) || startedMs < 0) {
      throw new ConfigurationError("background task 시작 시간이 올바르지 않습니다.");
    }
    const deadlineMs = startedMs + deadlineSeconds * 1_000;
    if (!Number.isSafeInteger(deadlineMs)) {
      throw new ConfigurationError("background task 종료 시각이 올바르지 않습니다.");
    }
    const allocated = this.#allocateFiles();
    const task: BackgroundTaskRecord = {
      id: allocated.id,
      sessionId: request.sessionId,
      command: request.command,
      startedAt: new Date(startedMs).toISOString(),
      startedMs,
      deadlineAt: new Date(deadlineMs).toISOString(),
      deadlineMs,
      outputPath: allocated.outputPath,
      manifestPath: allocated.manifestPath,
      ownedHere: true,
      child: undefined,
      pid: undefined,
      outputDescriptor: allocated.outputDescriptor,
      outputBytesSeen: 0,
      outputBytesStored: 0,
      outputWriteOffset: 0,
      outputWrapped: false,
      outputCounterSaturated: false,
      outputPending: true,
      outputError: undefined,
      status: "starting",
      exitCode: null,
      exitSignal: null,
      timedOut: false,
      stopRequested: false,
      terminationConfirmed: false,
      closed: false,
      deadlineTimer: undefined,
      killTimer: undefined,
      forceTimer: undefined,
      closeWaiters: new Set(),
    };
    this.#tasks.set(task.id, task);
    try {
      writeAll(allocated.outputDescriptor, logHeader(task), 0);
      this.#persist(task);
      const child = spawn("/bin/sh", ["-c", request.command], {
        cwd: this.workspace,
        env: request.environment,
        detached: process.platform !== "win32",
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      task.child = child;
      task.pid = child.pid;
      this.#attach(task, child);
      const remaining = Math.max(1, deadlineMs - this.#now());
      task.deadlineTimer = setTimeout(() => this.#deadline(task), remaining);
      task.deadlineTimer.unref();
      return this.#snapshot(task);
    } catch (error) {
      task.outputError = boundedError(`background task를 시작하지 못했습니다: ${errorMessage(error)}`);
      if (task.child === undefined) {
        task.status = "failed";
        task.outputPending = false;
        task.terminationConfirmed = true;
        task.closed = true;
        this.#closeOutput(task);
      } else {
        task.status = "unknown";
        this.#sendSignal(task, "SIGKILL");
      }
      this.#tryPersist(task);
      throw new StorageError("background task 프로세스를 시작하지 못했습니다.", { cause: error });
    }
  }

  list(sessionId: string): readonly JsonObject[] {
    assertSessionId(sessionId);
    return Object.freeze(
      [...this.#tasks.values()]
        .filter((task) => task.sessionId === sessionId)
        .sort((left, right) => right.startedMs - left.startedMs || left.id.localeCompare(right.id))
        .slice(0, MAX_SESSION_TASKS)
        .map((task) => Object.freeze(this.#snapshot(task))),
    );
  }

  read(sessionId: string, taskId: string, maximumBytes = DEFAULT_READ_BYTES): JsonObject {
    assertSessionId(sessionId);
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_READ_BYTES) {
      throw new ConfigurationError(`background 출력 max_bytes는 1–${MAX_READ_BYTES} 사이의 정수여야 합니다.`);
    }
    const task = this.#find(sessionId, taskId);
    let output = Buffer.alloc(0);
    let readError: string | undefined;
    try {
      output = this.#readTail(task, maximumBytes);
    } catch (error) {
      readError = boundedError(`background 출력을 읽지 못했습니다: ${errorMessage(error)}`);
    }
    const truncated = task.outputWrapped ||
      task.outputCounterSaturated ||
      task.outputBytesSeen > output.byteLength ||
      task.outputError !== undefined;
    if (truncated && output.byteLength > 0 && maximumBytes > TRUNCATION_NOTICE.byteLength) {
      output = Buffer.concat([
        TRUNCATION_NOTICE,
        output.subarray(-(maximumBytes - TRUNCATION_NOTICE.byteLength)),
      ]);
    }
    return {
      ...this.#snapshot(task),
      output: cleanText(new TextDecoder("utf-8").decode(output)),
      output_truncated: truncated,
      ...(readError === undefined ? {} : { output_read_error: readError }),
    };
  }

  identity(sessionId: string, taskId: string): BackgroundTaskIdentity {
    assertSessionId(sessionId);
    const task = this.#find(sessionId, taskId);
    return Object.freeze({
      taskId: task.id,
      sessionId: task.sessionId,
      startedAt: task.startedAt,
      commandDigest: createHash("sha256").update(task.command, "utf8").digest("hex"),
    });
  }

  identityMatches(identity: BackgroundTaskIdentity): boolean {
    try {
      const current = this.identity(identity.sessionId, identity.taskId);
      return current.startedAt === identity.startedAt &&
        current.commandDigest === identity.commandDigest;
    } catch {
      return false;
    }
  }

  async stop(sessionId: string, taskId: string): Promise<BackgroundTaskStopResult> {
    assertSessionId(sessionId);
    const task = this.#find(sessionId, taskId);
    if (!statusIsActive(task)) {
      return Object.freeze({
        task: this.#snapshot(task),
        signalSent: false,
        terminationConfirmed: task.terminationConfirmed,
        alreadyTerminal: task.status !== "stale" && task.status !== "unknown",
      });
    }
    const signalSent = this.#beginTermination(task, "user");
    await this.#waitForClose(task, STOP_WAIT_MS);
    if (!task.closed) {
      task.status = "unknown";
      task.outputError ??= "background task 종료 상태를 제한 시간 안에 확인하지 못했습니다.";
      this.#tryPersist(task);
    }
    return Object.freeze({
      task: this.#snapshot(task),
      signalSent,
      terminationConfirmed: task.terminationConfirmed,
      alreadyTerminal: false,
    });
  }

  async clearSession(sessionId: string): Promise<void> {
    assertSessionId(sessionId);
    const selected = [...this.#tasks.values()].filter(
      (task) => task.sessionId === sessionId && task.ownedHere,
    );
    const failures: string[] = [];
    for (const task of selected) {
      if (statusIsActive(task)) {
        const result = await this.stop(sessionId, task.id);
        if (!result.terminationConfirmed) {
          failures.push(`${task.id} 종료를 확인하지 못했습니다.`);
          continue;
        }
      }
      try {
        this.#discard(task);
      } catch (error) {
        failures.push(`${task.id} 기록 정리 실패: ${errorMessage(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new StorageError(`background task 세션 정리가 완료되지 않았습니다: ${failures.join("; ")}`);
    }
  }

  async close(): Promise<BackgroundTaskCloseResult> {
    this.#closed = true;
    const failures: string[] = [];
    const sessions = [...new Set(
      [...this.#tasks.values()]
        .filter((task) => task.ownedHere)
        .map((task) => task.sessionId),
    )];
    for (const sessionId of sessions) {
      try {
        await this.clearSession(sessionId);
      } catch (error) {
        failures.push(errorMessage(error));
      }
    }
    return Object.freeze({
      complete: failures.length === 0,
      failures: Object.freeze(failures),
    });
  }

  #restorePersistedTasks(): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(this.storageDirectory, { withFileTypes: true });
    } catch (error) {
      throw new StorageError("background task 저장소를 읽지 못했습니다.", { cause: error });
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    if (entries.length > MAX_DIRECTORY_ENTRIES) this.#scanTruncated = true;
    for (const entry of entries.slice(0, MAX_DIRECTORY_ENTRIES)) {
      const match = entry.isFile() ? entry.name.match(MANIFEST_FILE) : null;
      const id = match?.[1];
      if (!id) continue;
      if (this.#tasks.size >= MAX_RESTORED_TASKS) {
        this.#scanTruncated = true;
        break;
      }
      const manifestPath = join(this.storageDirectory, entry.name);
      try {
        const info = lstatSync(manifestPath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) continue;
        const manifest = parseManifest(
          JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
          id,
          this.workspace,
        );
        if (!manifest) continue;
        const outputPath = join(this.storageDirectory, `${id}.log`);
        let logState: LogState = {
          stored: 0,
          writeOffset: 0,
          wrapped: false,
          seen: 0,
          saturated: false,
        };
        let outputError = manifest.outputError ?? undefined;
        try {
          logState = readLogState(outputPath);
        } catch (error) {
          outputError ??= boundedError(`이전 background 로그를 복원하지 못했습니다: ${errorMessage(error)}`);
        }
        const startedMs = Date.parse(manifest.startedAt);
        const deadlineMs = Date.parse(manifest.deadlineAt);
        const wasUnconfirmed = !manifest.terminationConfirmed ||
          manifest.status === "starting" ||
          manifest.status === "running" ||
          manifest.status === "stale" ||
          manifest.status === "unknown";
        const task: BackgroundTaskRecord = {
          id,
          sessionId: manifest.sessionId,
          command: manifest.command,
          startedAt: manifest.startedAt,
          startedMs,
          deadlineAt: manifest.deadlineAt,
          deadlineMs,
          outputPath,
          manifestPath,
          ownedHere: false,
          child: undefined,
          pid: undefined,
          outputDescriptor: undefined,
          outputBytesSeen: logState.seen,
          outputBytesStored: logState.stored,
          outputWriteOffset: logState.writeOffset,
          outputWrapped: logState.wrapped,
          outputCounterSaturated: logState.saturated,
          outputPending: false,
          outputError,
          status: wasUnconfirmed ? "stale" : manifest.status,
          exitCode: manifest.exitCode,
          exitSignal: manifest.exitSignal,
          timedOut: manifest.timedOut,
          stopRequested: manifest.stopRequested,
          terminationConfirmed: manifest.terminationConfirmed &&
            manifest.status !== "stale" &&
            manifest.status !== "unknown",
          closed: true,
          deadlineTimer: undefined,
          killTimer: undefined,
          forceTimer: undefined,
          closeWaiters: new Set(),
        };
        this.#tasks.set(id, task);
        if (wasUnconfirmed) this.#tryPersist(task);
      } catch {
        // 손상되거나 교체된 기록은 실행 중이라고 추측하지 않고 건너뛴다.
      }
    }
  }

  #allocateFiles(): {
    readonly id: string;
    readonly outputPath: string;
    readonly manifestPath: string;
    readonly outputDescriptor: number;
  } {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = this.#idFactory().toLowerCase();
      if (!TASK_ID.test(id)) {
        throw new ConfigurationError("background task ID factory가 올바른 16자리 hex를 만들지 않았습니다.");
      }
      if (this.#tasks.has(id)) continue;
      const outputPath = join(this.storageDirectory, `${id}.log`);
      const manifestPath = join(this.storageDirectory, `${id}.json`);
      let outputDescriptor: number | undefined;
      try {
        outputDescriptor = openSync(outputPath, "wx+", 0o600);
        const manifestDescriptor = openSync(manifestPath, "wx", 0o600);
        closeSync(manifestDescriptor);
        return { id, outputPath, manifestPath, outputDescriptor };
      } catch (error) {
        if (outputDescriptor !== undefined) {
          closeSync(outputDescriptor);
          try {
            unlinkSync(outputPath);
          } catch {
            // 방금 만든 파일이 이미 사라졌으면 다음 ID를 시도한다.
          }
        }
        if (errnoCode(error) !== "EEXIST") {
          throw new StorageError("background task 저장 파일을 만들지 못했습니다.", { cause: error });
        }
      }
    }
    throw new StorageError("충돌하지 않는 background task ID를 만들지 못했습니다.");
  }

  #attach(task: BackgroundTaskRecord, child: ChildProcess): void {
    const collect = (value: Buffer | string): void => {
      const chunk = typeof value === "string" ? Buffer.from(value, "utf8") : value;
      this.#storeOutput(task, chunk);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.stdout?.once("error", (error) => this.#recordOutputError(task, error));
    child.stderr?.once("error", (error) => this.#recordOutputError(task, error));
    child.once("spawn", () => {
      if (task.child !== child || task.closed) return;
      task.pid = child.pid;
      if (task.timedOut) this.#beginTermination(task, "deadline");
      else if (task.stopRequested) this.#beginTermination(task, "user");
      else {
        if (task.status === "starting") task.status = "running";
        this.#tryPersist(task);
      }
    });
    child.once("error", (error) => {
      if (task.child !== child || task.closed) return;
      task.outputError ??= boundedError(`background task process 오류: ${errorMessage(error)}`);
      if (!child.pid) task.status = "failed";
      this.#tryPersist(task);
    });
    child.once("exit", (code, signal) => {
      if (task.child !== child || task.closed) return;
      task.exitCode = code;
      task.exitSignal = signal;
      if (!task.timedOut && !task.stopRequested) {
        task.status = code === 0 && signal === null ? "completed" : "failed";
      }
      this.#tryPersist(task);
    });
    child.once("close", (code, signal) => {
      if (task.child !== child || task.closed) return;
      task.exitCode = code;
      task.exitSignal = signal;
      if (task.timedOut) task.status = "timed_out";
      else if (task.stopRequested) task.status = "stopped";
      else task.status = code === 0 && signal === null ? "completed" : "failed";
      task.outputPending = false;
      task.terminationConfirmed = true;
      task.closed = true;
      task.child = undefined;
      task.pid = undefined;
      this.#clearTimers(task);
      this.#closeOutput(task);
      this.#tryPersist(task);
      for (const waiter of task.closeWaiters) waiter();
      task.closeWaiters.clear();
    });
  }

  #storeOutput(task: BackgroundTaskRecord, chunk: Buffer): void {
    if (chunk.byteLength === 0) return;
    const remaining = Number.MAX_SAFE_INTEGER - task.outputBytesSeen;
    if (chunk.byteLength > remaining) {
      task.outputBytesSeen = Number.MAX_SAFE_INTEGER;
      task.outputCounterSaturated = true;
    } else {
      task.outputBytesSeen += chunk.byteLength;
    }
    const descriptor = task.outputDescriptor;
    if (descriptor === undefined) return;
    try {
      if (chunk.byteLength >= MAX_OUTPUT_BYTES) {
        const retained = chunk.subarray(-MAX_OUTPUT_BYTES);
        const replacedEarlierOutput = task.outputBytesStored > 0;
        writeAll(descriptor, retained, LOG_HEADER_BYTES);
        ftruncateSync(descriptor, LOG_HEADER_BYTES + MAX_OUTPUT_BYTES);
        task.outputBytesStored = MAX_OUTPUT_BYTES;
        task.outputWriteOffset = 0;
        task.outputWrapped = task.outputWrapped || replacedEarlierOutput ||
          chunk.byteLength > MAX_OUTPUT_BYTES;
      } else {
        const offset = task.outputWriteOffset;
        const firstSize = Math.min(chunk.byteLength, MAX_OUTPUT_BYTES - offset);
        writeAll(descriptor, chunk.subarray(0, firstSize), LOG_HEADER_BYTES + offset);
        if (firstSize < chunk.byteLength) {
          writeAll(descriptor, chunk.subarray(firstSize), LOG_HEADER_BYTES);
        }
        if (task.outputBytesStored + chunk.byteLength > MAX_OUTPUT_BYTES) {
          task.outputWrapped = true;
        }
        task.outputBytesStored = Math.min(
          MAX_OUTPUT_BYTES,
          task.outputBytesStored + chunk.byteLength,
        );
        task.outputWriteOffset = (offset + chunk.byteLength) % MAX_OUTPUT_BYTES;
        if (task.outputWrapped) ftruncateSync(descriptor, LOG_HEADER_BYTES + MAX_OUTPUT_BYTES);
      }
      writeAll(descriptor, logHeader(task), 0);
    } catch (error) {
      task.outputError ??= boundedError(`background 출력 저장 실패: ${errorMessage(error)}`);
      this.#closeOutput(task);
      this.#tryPersist(task);
    }
  }

  #recordOutputError(task: BackgroundTaskRecord, error: unknown): void {
    task.outputError ??= boundedError(`background 출력 stream 오류: ${errorMessage(error)}`);
    this.#tryPersist(task);
  }

  #readTail(task: BackgroundTaskRecord, maximumBytes: number): Buffer {
    const descriptor = openVerifiedRegularFile(task.outputPath);
    try {
      const header = Buffer.alloc(LOG_HEADER_BYTES);
      if (readInto(descriptor, header, 0, header.byteLength, 0) !== header.byteLength) {
        throw new StorageError("background task 로그 header를 전부 읽지 못했습니다.");
      }
      const state = parseLogHeader(header);
      task.outputBytesSeen = Math.max(task.outputBytesSeen, state.seen);
      task.outputBytesStored = state.stored;
      task.outputWriteOffset = state.writeOffset;
      task.outputWrapped = state.wrapped;
      task.outputCounterSaturated ||= state.saturated;
      if (state.stored === 0) return Buffer.alloc(0);
      const count = Math.min(maximumBytes, state.stored);
      const start = state.wrapped
        ? (state.writeOffset - count + MAX_OUTPUT_BYTES) % MAX_OUTPUT_BYTES
        : state.stored - count;
      const output = Buffer.alloc(count);
      const firstSize = Math.min(count, MAX_OUTPUT_BYTES - start);
      let read = readInto(
        descriptor,
        output,
        0,
        firstSize,
        LOG_HEADER_BYTES + start,
      );
      if (read < count && state.wrapped) {
        read += readInto(
          descriptor,
          output,
          read,
          count - read,
          LOG_HEADER_BYTES,
        );
      }
      return output.subarray(0, read);
    } finally {
      closeSync(descriptor);
    }
  }

  #deadline(task: BackgroundTaskRecord): void {
    if (!statusIsActive(task)) return;
    task.timedOut = true;
    task.status = "timed_out";
    this.#tryPersist(task);
    this.#beginTermination(task, "deadline");
  }

  #beginTermination(task: BackgroundTaskRecord, reason: "user" | "deadline"): boolean {
    if (task.closed) return false;
    if (reason === "user") {
      task.stopRequested = true;
      task.status = "stopped";
    }
    this.#tryPersist(task);
    const child = task.child;
    if (!child || !child.pid || child.pid !== task.pid) return false;
    const sent = this.#sendSignal(task, "SIGTERM");
    if (!task.killTimer) {
      task.killTimer = setTimeout(() => {
        task.killTimer = undefined;
        if (task.closed) return;
        this.#sendSignal(task, "SIGKILL");
        task.forceTimer = setTimeout(() => {
          task.forceTimer = undefined;
          if (task.closed) return;
          task.status = "unknown";
          task.outputError ??= "background task 강제 종료 상태를 확인하지 못했습니다.";
          task.child?.stdout?.destroy();
          task.child?.stderr?.destroy();
          this.#tryPersist(task);
          for (const waiter of task.closeWaiters) waiter();
          task.closeWaiters.clear();
        }, KILL_GRACE_MS);
        task.forceTimer.unref();
      }, TERMINATE_GRACE_MS);
      task.killTimer.unref();
    }
    return sent;
  }

  #sendSignal(task: BackgroundTaskRecord, signal: NodeJS.Signals): boolean {
    const child = task.child;
    if (!child || !child.pid || child.pid !== task.pid || task.closed) return false;
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch {
        // 같은 manager가 만든 child 자체에만 fallback signal을 보낸다.
      }
    }
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }

  async #waitForClose(task: BackgroundTaskRecord, timeoutMs: number): Promise<void> {
    if (task.closed) return;
    await new Promise<void>((resolvePromise) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        task.closeWaiters.delete(finish);
        resolvePromise();
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref();
      task.closeWaiters.add(finish);
      if (task.closed) finish();
    });
  }

  #find(sessionId: string, rawTaskId: string): BackgroundTaskRecord {
    const taskId = rawTaskId.trim().toLowerCase();
    if (!TASK_ID_PREFIX.test(taskId)) {
      throw new ConfigurationError("background task ID 형식이 올바르지 않습니다.");
    }
    const exact = this.#tasks.get(taskId);
    if (exact?.sessionId === sessionId) return exact;
    const matches = [...this.#tasks.values()].filter(
      (task) => task.sessionId === sessionId && task.id.startsWith(taskId),
    );
    if (matches.length === 1) return matches[0] as BackgroundTaskRecord;
    if (matches.length === 0) {
      throw new ConfigurationError(`현재 세션이 소유한 background task를 찾을 수 없습니다: ${taskId}`);
    }
    throw new ConfigurationError(`background task ID prefix가 모호합니다: ${taskId}`);
  }

  #snapshot(task: BackgroundTaskRecord): JsonObject {
    const now = this.#now();
    const elapsed = Number.isFinite(now)
      ? Math.max(0, Math.round((now - task.startedMs) / 100) / 10)
      : 0;
    const deadlineRemaining = Number.isFinite(now)
      ? Math.max(0, Math.ceil((task.deadlineMs - now) / 1_000))
      : 0;
    return {
      task_id: task.id,
      session_id: task.sessionId,
      command: cleanText(task.command),
      status: task.status,
      exit_code: task.exitCode,
      exit_signal: task.exitSignal,
      started_at: task.startedAt,
      deadline_at: task.deadlineAt,
      elapsed_seconds: elapsed,
      deadline_remaining_seconds: deadlineRemaining,
      output_bytes_seen: task.outputBytesSeen,
      output_bytes_stored: task.outputBytesStored,
      output_limit_reached: task.outputWrapped || task.outputCounterSaturated,
      output_pending: task.outputPending,
      timed_out: task.timedOut,
      stop_requested: task.stopRequested,
      termination_confirmed: task.terminationConfirmed,
      execution_state: task.status === "stale" || task.status === "unknown"
        ? "unknown"
        : statusIsActive(task)
          ? "running"
          : "terminal",
      ...(task.status === "stale"
        ? { stale_reason: "이전 cat process의 child 소유권을 확인할 수 없어 PID를 종료하지 않습니다." }
        : {}),
      ...(task.outputError === undefined ? {} : { output_error: cleanText(task.outputError) }),
    };
  }

  #persist(task: BackgroundTaskRecord): void {
    const encoded = Buffer.from(`${JSON.stringify(taskManifest(task, this.workspace))}\n`, "utf8");
    if (encoded.byteLength > MAX_MANIFEST_BYTES) {
      throw new StorageError("background task manifest 크기 제한을 초과했습니다.");
    }
    const temporaryPath = join(
      this.storageDirectory,
      `.${task.id}.${randomBytes(6).toString("hex")}.tmp`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeAll(descriptor, encoded, 0);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, task.manifestPath);
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // 원래 저장 오류를 보존한다.
        }
      }
      try {
        unlinkSync(temporaryPath);
      } catch {
        // 생성되지 않았거나 이미 rename된 임시 파일이다.
      }
      throw new StorageError("background task manifest를 저장하지 못했습니다.", { cause: error });
    }
  }

  #tryPersist(task: BackgroundTaskRecord): void {
    try {
      this.#persist(task);
    } catch (error) {
      task.outputError ??= boundedError(`background task 상태 저장 실패: ${errorMessage(error)}`);
    }
  }

  #activeCount(): number {
    return [...this.#tasks.values()].filter(statusIsActive).length;
  }

  #pruneForCapacity(sessionId: string): void {
    const sessionTasks = [...this.#tasks.values()].filter((task) => task.sessionId === sessionId);
    const prune = (): boolean => {
      const candidate = [...this.#tasks.values()]
        .filter((task) => task.sessionId === sessionId && !statusIsActive(task))
        .sort((left, right) => left.startedMs - right.startedMs || left.id.localeCompare(right.id))[0];
      if (!candidate) return false;
      this.#discard(candidate);
      return true;
    };
    while (
      [...this.#tasks.values()].filter((task) => task.sessionId === sessionId).length >= MAX_SESSION_TASKS
    ) {
      if (!prune()) {
        throw new StorageError("background task 보존 상한에 도달해 새 작업을 시작할 수 없습니다.");
      }
    }
    if (this.#tasks.size >= MAX_MANAGED_TASKS) {
      throw new StorageError("전체 background task 보존 상한에 도달해 새 작업을 시작할 수 없습니다.");
    }
    if (sessionTasks.filter(statusIsActive).length >= MAX_RUNNING_TASKS) {
      throw new StorageError(`현재 세션의 동시 background task는 최대 ${MAX_RUNNING_TASKS}개입니다.`);
    }
  }

  #discard(task: BackgroundTaskRecord): void {
    if (statusIsActive(task)) {
      throw new StorageError("실행 중인 background task 기록은 삭제할 수 없습니다.");
    }
    this.#clearTimers(task);
    this.#closeOutput(task);
    for (const path of [task.outputPath, task.manifestPath]) {
      try {
        const info = lstatSync(path);
        if (info.isDirectory()) throw new StorageError("background task 기록 경로가 디렉터리로 바뀌었습니다.");
        unlinkSync(path);
      } catch (error) {
        const code = errnoCode(error);
        if (code !== "ENOENT") throw error;
      }
    }
    this.#tasks.delete(task.id);
  }

  #closeOutput(task: BackgroundTaskRecord): void {
    if (task.outputDescriptor === undefined) return;
    try {
      closeSync(task.outputDescriptor);
    } catch {
      // 앞선 출력 오류가 descriptor를 이미 닫았을 수 있다.
    }
    task.outputDescriptor = undefined;
  }

  #clearTimers(task: BackgroundTaskRecord): void {
    if (task.deadlineTimer) clearTimeout(task.deadlineTimer);
    if (task.killTimer) clearTimeout(task.killTimer);
    if (task.forceTimer) clearTimeout(task.forceTimer);
    task.deadlineTimer = undefined;
    task.killTimer = undefined;
    task.forceTimer = undefined;
  }
}

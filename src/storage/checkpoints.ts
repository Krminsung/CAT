import { createHash, randomUUID } from "node:crypto";
import { rmdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ConfigurationError, PermissionDeniedError, StorageError } from "../core/errors.js";
import type { RunIdentity } from "../core/execution.js";
import type {
  WorkspacePathGuard,
  WorkspacePathResolution,
} from "../security/workspace-path.js";
import {
  deleteWorkspaceFile,
  readWorkspaceFileBytes,
  refreshWritableTarget,
  WorkspaceFileOperationError,
  type WorkspaceResidualFile,
  writeWorkspaceFileAtomic,
} from "./workspace-file.js";

const MAX_CHECKPOINT_FILES = 32;
const MAX_CHECKPOINT_BACKUP_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_CHECKPOINTS = 100;

export interface CheckpointOwner extends RunIdentity {
  toolName: string;
}

export interface CheckpointTarget {
  resolution: WorkspacePathResolution;
  before: Uint8Array | undefined;
}

export interface CheckpointSummary {
  checkpointId: string;
  sessionId: string;
  runId: string;
  toolName: string;
  status: "pending" | "committed" | "rollback_failed" | "rewind_failed";
  paths: readonly string[];
}

export interface CheckpointRestoreResult {
  checkpointId: string;
  complete: boolean;
  restored: readonly string[];
  alreadyOriginal: readonly string[];
  failures: readonly string[];
  recordPreserved: boolean;
}

interface CheckpointFileState {
  requestedPath: string;
  displayPath: string;
  absolutePath: string;
  resolution: WorkspacePathResolution;
  beforeExists: boolean;
  before: Buffer | undefined;
  beforeDigest: string | undefined;
  beforeMode: number | undefined;
  expectedSet: boolean;
  afterExists: boolean;
  afterDigest: string | undefined;
}

interface CheckpointRecord {
  id: string;
  owner: CheckpointOwner;
  status: CheckpointSummary["status"];
  files: CheckpointFileState[];
  preparedDirectories: Set<string>;
  residualFiles: Map<string, string>;
  expectedVerified: boolean;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function matchesState(
  exists: boolean,
  currentDigest: string | undefined,
  expectedExists: boolean,
  expectedDigest: string | undefined,
): boolean {
  return exists === expectedExists && (!exists || currentDigest === expectedDigest);
}

function summary(record: CheckpointRecord, workspace: string): CheckpointSummary {
  return {
    checkpointId: record.id,
    sessionId: record.owner.sessionId,
    runId: record.owner.runId,
    toolName: record.owner.toolName,
    status: record.status,
    paths: record.files.map((file) => relative(workspace, file.absolutePath).replaceAll("\\", "/")),
  };
}

export class CheckpointManager {
  readonly #pending = new Map<string, CheckpointRecord>();
  readonly #completedBySession = new Map<string, CheckpointRecord[]>();
  readonly #failed = new Map<string, CheckpointRecord>();

  constructor(readonly guard: WorkspacePathGuard) {}

  async begin(owner: CheckpointOwner, targets: readonly CheckpointTarget[]): Promise<string> {
    if (!owner.sessionId || !owner.runId || !owner.toolName) {
      throw new ConfigurationError("Checkpoint owner 정보가 올바르지 않습니다.");
    }
    if (targets.length < 1 || targets.length > MAX_CHECKPOINT_FILES) {
      throw new ConfigurationError(`Checkpoint 파일 수는 1–${MAX_CHECKPOINT_FILES}개여야 합니다.`);
    }
    const states: CheckpointFileState[] = [];
    const seen = new Set<string>();
    let backupBytes = 0;
    for (const target of targets) {
      const current = await refreshWritableTarget(this.guard, target.resolution);
      if (seen.has(current.absolutePath)) {
        throw new ConfigurationError("한 checkpoint에서 같은 파일을 두 번 기록할 수 없습니다.");
      }
      seen.add(current.absolutePath);
      let before: Buffer | undefined;
      let beforeMode: number | undefined;
      if (current.exists) {
        const snapshot = await readWorkspaceFileBytes(current);
        before = Buffer.from(snapshot.bytes);
        beforeMode = snapshot.mode;
        if (!target.before || !before.equals(target.before)) {
          throw new PermissionDeniedError("Checkpoint 기록 전에 파일 내용이 변경되었습니다.");
        }
      } else if (target.before !== undefined) {
        throw new PermissionDeniedError("Checkpoint 기록 전에 새 파일 대상이 변경되었습니다.");
      }
      backupBytes += before?.byteLength ?? 0;
      if (backupBytes > MAX_CHECKPOINT_BACKUP_BYTES) {
        throw new ConfigurationError("Checkpoint backup 전체 크기 제한을 초과했습니다.");
      }
      states.push({
        requestedPath: current.requestedPath,
        displayPath: current.displayPath,
        absolutePath: current.absolutePath,
        resolution: current,
        beforeExists: current.exists,
        before,
        beforeDigest: before ? sha256(before) : undefined,
        beforeMode,
        expectedSet: false,
        afterExists: false,
        afterDigest: undefined,
      });
    }
    const id = randomUUID().replaceAll("-", "");
    this.#pending.set(id, {
      id,
      owner: { ...owner },
      status: "pending",
      files: states,
      preparedDirectories: new Set(),
      residualFiles: new Map(),
      expectedVerified: false,
    });
    return id;
  }

  setExpected(checkpointId: string, absolutePath: string, content: Uint8Array | undefined): void {
    const record = this.#pending.get(checkpointId);
    const state = record?.files.find((file) => file.absolutePath === absolutePath);
    if (!record || !state) throw new ConfigurationError("Checkpoint 대상 파일을 찾을 수 없습니다.");
    state.expectedSet = true;
    state.afterExists = content !== undefined;
    state.afterDigest = content === undefined ? undefined : sha256(content);
    record.expectedVerified = false;
  }

  recordPreparedDirectories(checkpointId: string, directories: readonly string[]): void {
    const record = this.#pending.get(checkpointId);
    if (!record) throw new ConfigurationError("진행 중인 checkpoint를 찾을 수 없습니다.");
    for (const path of directories) {
      const child = relative(this.guard.workspace, path);
      const belongsToTarget = record.files.some((state) => {
        const fromAnchor = relative(state.resolution.parentPath, path);
        const toTarget = relative(path, state.absolutePath);
        return fromAnchor !== "" &&
          fromAnchor !== ".." &&
          !fromAnchor.startsWith(`..${sep}`) &&
          !isAbsolute(fromAnchor) &&
          toTarget !== "" &&
          toTarget !== ".." &&
          !toTarget.startsWith(`..${sep}`) &&
          !isAbsolute(toTarget);
      });
      if (
        !isAbsolute(path) ||
        resolve(path) !== path ||
        child === ".." ||
        child.startsWith(`..${sep}`) ||
        isAbsolute(child) ||
        !belongsToTarget
      ) {
        throw new PermissionDeniedError("Checkpoint의 준비 디렉터리 정보가 올바르지 않습니다.");
      }
      record.preparedDirectories.add(path);
    }
  }

  recordResidualFiles(checkpointId: string, files: readonly WorkspaceResidualFile[]): void {
    const record = this.#pending.get(checkpointId);
    if (!record) throw new ConfigurationError("진행 중인 checkpoint를 찾을 수 없습니다.");
    for (const file of files) {
      const ownedName = record.files.some((state) => {
        if (!file.path.startsWith(state.absolutePath)) return false;
        const suffix = file.path.slice(state.absolutePath.length);
        return /^\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u
          .test(suffix);
      });
      const child = relative(this.guard.workspace, file.path);
      if (
        !isAbsolute(file.path) ||
        resolve(file.path) !== file.path ||
        !ownedName ||
        child === ".." ||
        child.startsWith(`..${sep}`) ||
        isAbsolute(child) ||
        !/^[a-f0-9]{64}$/u.test(file.digest)
      ) {
        throw new PermissionDeniedError("Checkpoint의 관리 임시 파일 정보가 올바르지 않습니다.");
      }
      record.residualFiles.set(file.path, file.digest);
    }
  }

  async verifyExpected(checkpointId: string): Promise<void> {
    const record = this.#pending.get(checkpointId);
    if (!record) throw new ConfigurationError("진행 중인 checkpoint를 찾을 수 없습니다.");
    for (const state of record.files) {
      if (!state.expectedSet) {
        throw new ConfigurationError("Checkpoint의 변경 후 상태가 완전하지 않습니다.");
      }
      const current = await this.#currentState(state);
      if (!matchesState(current.exists, current.digest, state.afterExists, state.afterDigest)) {
        throw new PermissionDeniedError(
          `변경 직후 checkpoint 상태가 일치하지 않습니다: ${state.displayPath}`,
        );
      }
    }
    record.expectedVerified = true;
  }

  commit(checkpointId: string): CheckpointSummary {
    const record = this.#pending.get(checkpointId);
    if (!record) throw new ConfigurationError("진행 중인 checkpoint를 찾을 수 없습니다.");
    if (record.files.some((file) => !file.expectedSet) || !record.expectedVerified) {
      throw new ConfigurationError("Checkpoint의 변경 후 상태가 검증되지 않았습니다.");
    }
    record.status = "committed";
    this.#pending.delete(checkpointId);
    const completed = this.#completedBySession.get(record.owner.sessionId) ?? [];
    completed.push(record);
    if (completed.length > MAX_SESSION_CHECKPOINTS) completed.splice(0, completed.length - MAX_SESSION_CHECKPOINTS);
    this.#completedBySession.set(record.owner.sessionId, completed);
    return summary(record, this.guard.workspace);
  }

  discardUnchanged(checkpointId: string): void {
    const record = this.#pending.get(checkpointId);
    if (!record) return;
    if (record.preparedDirectories.size > 0 || record.residualFiles.size > 0) {
      throw new StorageError("부작용이 있는 checkpoint 기록은 단순 폐기할 수 없습니다.");
    }
    this.#pending.delete(checkpointId);
  }

  latest(sessionId: string): CheckpointSummary | undefined {
    const record = this.#completedBySession.get(sessionId)?.at(-1);
    return record ? summary(record, this.guard.workspace) : undefined;
  }

  failed(checkpointId: string): CheckpointSummary | undefined {
    const record = this.#failed.get(checkpointId);
    return record ? summary(record, this.guard.workspace) : undefined;
  }

  clearSession(sessionId: string): void {
    if (!sessionId) {
      throw new ConfigurationError("정리할 checkpoint 세션 ID가 필요합니다.");
    }
    const pending = [...this.#pending.values()].some(
      (record) => record.owner.sessionId === sessionId,
    );
    const failed = [...this.#failed.values()].some(
      (record) => record.owner.sessionId === sessionId,
    );
    const rewindFailed = this.#completedBySession
      .get(sessionId)
      ?.some((record) => record.status === "rewind_failed") ?? false;
    if (pending || failed || rewindFailed) {
      throw new StorageError(
        "복구가 끝나지 않은 checkpoint가 있어 세션 상태를 정리하지 않았습니다.",
      );
    }
    this.#completedBySession.delete(sessionId);
  }

  async #currentState(state: CheckpointFileState): Promise<{
    resolution: WorkspacePathResolution;
    exists: boolean;
    digest: string | undefined;
  }> {
    const anchor = await stat(state.resolution.parentPath);
    if (
      !anchor.isDirectory() ||
      anchor.dev !== state.resolution.parentDevice ||
      (process.platform !== "win32" && anchor.ino !== state.resolution.parentInode)
    ) {
      throw new PermissionDeniedError("Checkpoint의 기존 상위 디렉터리가 변경되었습니다.");
    }
    const resolution = await this.guard.resolveWritable(state.requestedPath);
    if (resolution.absolutePath !== state.absolutePath) {
      throw new PermissionDeniedError("Checkpoint 파일 경로가 다른 대상으로 변경되었습니다.");
    }
    if (!resolution.exists) return { resolution, exists: false, digest: undefined };
    const snapshot = await readWorkspaceFileBytes(resolution);
    return { resolution, exists: true, digest: sha256(snapshot.bytes) };
  }

  async #restoreRecord(record: CheckpointRecord): Promise<CheckpointRestoreResult> {
    const restored: string[] = [];
    const alreadyOriginal: string[] = [];
    const failures: string[] = [];
    for (const state of [...record.files].reverse()) {
      try {
        if (!state.expectedSet) throw new StorageError("Checkpoint 변경 후 상태가 기록되지 않았습니다.");
        const current = await this.#currentState(state);
        if (matchesState(current.exists, current.digest, state.beforeExists, state.beforeDigest)) {
          alreadyOriginal.push(state.displayPath);
          continue;
        }
        if (!matchesState(current.exists, current.digest, state.afterExists, state.afterDigest)) {
          throw new PermissionDeniedError("Checkpoint 이후 다른 변경이 있어 덮어쓰지 않았습니다.");
        }
        if (state.beforeExists) {
          if (state.before === undefined) {
            throw new StorageError("Checkpoint의 변경 전 파일 내용이 유실되었습니다.");
          }
          const write = await writeWorkspaceFileAtomic(
            this.guard,
            current.resolution,
            state.before,
            state.afterDigest,
            state.beforeMode,
          );
          for (const directory of write.preparedDirectories) record.preparedDirectories.add(directory);
        } else {
          if (!state.afterDigest) {
            throw new StorageError("Checkpoint의 삭제 전 digest가 유실되었습니다.");
          }
          await deleteWorkspaceFile(this.guard, current.resolution, state.afterDigest);
        }
        const verified = await this.#currentState(state);
        if (!matchesState(verified.exists, verified.digest, state.beforeExists, state.beforeDigest)) {
          throw new StorageError("Checkpoint 복원 결과를 확인하지 못했습니다.");
        }
        restored.push(state.displayPath);
      } catch (error) {
        if (error instanceof WorkspaceFileOperationError) {
          for (const directory of error.preparedDirectories) record.preparedDirectories.add(directory);
          for (const file of error.residualFiles) {
            record.residualFiles.set(file.path, file.digest);
          }
        }
        const message = error instanceof Error ? error.message : "알 수 없는 복원 오류";
        failures.push(`${state.displayPath}: ${message}`);
      }
    }

    for (const [path, expectedDigest] of [...record.residualFiles]) {
      try {
        const requested = relative(this.guard.workspace, path).replaceAll("\\", "/");
        const resolution = await this.guard.resolveWritable(requested);
        if (!resolution.exists) {
          record.residualFiles.delete(path);
          continue;
        }
        if (resolution.absolutePath !== path) {
          throw new PermissionDeniedError("남은 임시 파일 경로가 다른 대상을 가리킵니다.");
        }
        const snapshot = await readWorkspaceFileBytes(resolution);
        if (sha256(snapshot.bytes) !== expectedDigest) {
          throw new PermissionDeniedError("남은 임시 파일 내용이 변경되어 제거하지 않았습니다.");
        }
        await deleteWorkspaceFile(this.guard, resolution, expectedDigest);
        record.residualFiles.delete(path);
      } catch (error) {
        const code = errnoCode(error);
        if (code === "ENOENT") {
          record.residualFiles.delete(path);
        } else {
          failures.push(`관리 임시 파일을 제거하지 못했습니다(${code ?? "unknown"}).`);
        }
      }
    }
    const directories = [...record.preparedDirectories].sort(
      (left, right) => right.split(sep).length - left.split(sep).length,
    );
    for (const directory of directories) {
      try {
        await rmdir(directory);
        record.preparedDirectories.delete(directory);
      } catch (error) {
        const code = errnoCode(error);
        if (code === "ENOENT") {
          record.preparedDirectories.delete(directory);
        } else {
          failures.push(`${relative(this.guard.workspace, directory)}: 생성 디렉터리를 제거하지 못했습니다(${code ?? "unknown"}).`);
        }
      }
    }
    return {
      checkpointId: record.id,
      complete: failures.length === 0,
      restored,
      alreadyOriginal,
      failures,
      recordPreserved: failures.length > 0,
    };
  }

  async rollback(checkpointId: string): Promise<CheckpointRestoreResult> {
    const record = this.#pending.get(checkpointId);
    if (!record) throw new ConfigurationError("Rollback할 checkpoint를 찾을 수 없습니다.");
    const result = await this.#restoreRecord(record);
    if (result.complete) {
      this.#pending.delete(checkpointId);
    } else {
      record.status = "rollback_failed";
      this.#pending.delete(checkpointId);
      this.#failed.set(checkpointId, record);
      if (this.#failed.size > 1_000) {
        const oldest = this.#failed.keys().next().value as string | undefined;
        if (oldest) this.#failed.delete(oldest);
      }
    }
    return result;
  }

  async rewind(sessionId: string): Promise<CheckpointRestoreResult> {
    const completed = this.#completedBySession.get(sessionId);
    const record = completed?.at(-1);
    if (!record) throw new ConfigurationError("되돌릴 파일 checkpoint가 없습니다.");
    const result = await this.#restoreRecord(record);
    if (result.complete) {
      const latest = completed?.at(-1);
      if (latest?.id !== record.id) {
        throw new StorageError("Checkpoint 순서가 변경되어 완료 처리하지 못했습니다.");
      }
      completed?.pop();
    } else {
      record.status = "rewind_failed";
    }
    return result;
  }
}

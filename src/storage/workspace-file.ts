import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import { ConfigurationError, PermissionDeniedError, StorageError } from "../core/errors.js";
import type {
  WorkspacePathGuard,
  WorkspacePathResolution,
} from "../security/workspace-path.js";

export const MAX_WORKSPACE_FILE_BYTES = 1_000_000;

export interface WorkspaceFileSnapshot {
  bytes: Buffer;
  mode: number;
}

export interface WorkspaceWriteResult {
  resolution: WorkspacePathResolution;
  preparedDirectories: readonly string[];
}

export interface WorkspaceResidualFile {
  path: string;
  digest: string;
}

export class WorkspaceFileOperationError extends StorageError {
  override name = "WorkspaceFileOperationError";

  constructor(
    message: string,
    readonly targetChanged: boolean,
    readonly preparedDirectories: readonly string[],
    readonly residualFiles: readonly WorkspaceResidualFile[],
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function sameIdentity(
  actual: Stats,
  device: number | undefined,
  inode: number | undefined,
): boolean {
  if (device === undefined || inode === undefined || actual.dev !== device) return false;
  return process.platform === "win32" && (actual.ino === 0 || inode === 0)
    ? true
    : actual.ino === inode;
}

async function assertAnchorUnchanged(expected: WorkspacePathResolution): Promise<void> {
  let anchor: Stats;
  try {
    anchor = await stat(expected.parentPath);
  } catch (error) {
    throw new PermissionDeniedError("쓰기 대상의 기존 상위 디렉터리가 변경되었습니다.", {
      cause: error,
    });
  }
  if (
    !anchor.isDirectory() ||
    !sameIdentity(anchor, expected.parentDevice, expected.parentInode)
  ) {
    throw new PermissionDeniedError("쓰기 대상의 기존 상위 디렉터리 identity가 변경되었습니다.");
  }
}

async function assertExpectedDigest(
  resolution: WorkspacePathResolution,
  expectedDigest: string | undefined,
): Promise<void> {
  if (expectedDigest === undefined) {
    if (resolution.exists) {
      throw new PermissionDeniedError("새 파일 대상이 검사 뒤 생성되었습니다.");
    }
    return;
  }
  if (!/^[a-f0-9]{64}$/u.test(expectedDigest) || !resolution.exists) {
    throw new PermissionDeniedError("기존 파일의 변경 전 상태가 올바르지 않습니다.");
  }
  const snapshot = await readWorkspaceFileBytes(resolution);
  const currentDigest = createHash("sha256").update(snapshot.bytes).digest("hex");
  if (currentDigest !== expectedDigest) {
    throw new PermissionDeniedError("검사 뒤 파일 내용이 변경되었습니다.");
  }
}

export async function refreshWritableTarget(
  guard: WorkspacePathGuard,
  expected: WorkspacePathResolution,
): Promise<WorkspacePathResolution> {
  await assertAnchorUnchanged(expected);
  const current = await guard.resolveWritable(expected.requestedPath);
  if (
    current.absolutePath !== expected.absolutePath ||
    current.exists !== expected.exists ||
    current.kind !== expected.kind ||
    (expected.exists && (
      current.device !== expected.device ||
      (process.platform !== "win32" && current.inode !== expected.inode)
    ))
  ) {
    throw new PermissionDeniedError("검사 뒤 쓰기 대상 파일이 변경되었습니다.");
  }
  return current;
}

export async function readWorkspaceFileBytes(
  resolution: WorkspacePathResolution,
): Promise<WorkspaceFileSnapshot> {
  if (!resolution.exists || resolution.kind !== "file") {
    throw new ConfigurationError("읽기 대상이 일반 파일이 아닙니다.");
  }
  const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
  const nonBlocking = fsConstants.O_NONBLOCK ?? 0;
  let handle: FileHandle | undefined;
  try {
    handle = await open(resolution.absolutePath, fsConstants.O_RDONLY | noFollow | nonBlocking);
    const initial = await handle.stat();
    if (!initial.isFile() || !sameIdentity(initial, resolution.device, resolution.inode)) {
      throw new PermissionDeniedError("검사 뒤 읽기 대상 파일이 변경되었습니다.");
    }
    if (initial.size > MAX_WORKSPACE_FILE_BYTES) {
      throw new ConfigurationError(`파일이 ${MAX_WORKSPACE_FILE_BYTES} bytes 제한을 초과했습니다.`);
    }
    const buffer = Buffer.alloc(MAX_WORKSPACE_FILE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const read = await handle.read(buffer, total, buffer.length - total, total);
      if (read.bytesRead === 0) break;
      total += read.bytesRead;
    }
    if (total > MAX_WORKSPACE_FILE_BYTES) {
      throw new ConfigurationError(`파일이 ${MAX_WORKSPACE_FILE_BYTES} bytes 제한을 초과했습니다.`);
    }
    const completed = await handle.stat();
    if (
      completed.size !== initial.size ||
      completed.mtimeMs !== initial.mtimeMs ||
      completed.ctimeMs !== initial.ctimeMs ||
      total !== initial.size
    ) {
      throw new PermissionDeniedError("파일을 읽는 동안 내용이 변경되었습니다.");
    }
    return { bytes: Buffer.from(buffer.subarray(0, total)), mode: initial.mode };
  } catch (error) {
    if (error instanceof ConfigurationError || error instanceof PermissionDeniedError) throw error;
    const code = errnoCode(error);
    throw new StorageError(
      code ? `파일을 읽지 못했습니다(${code}).` : "파일을 읽지 못했습니다.",
      { cause: error },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function plannedDirectories(
  workspace: string,
  targetParent: string,
  existingAnchor: string,
): string[] {
  const child = relative(existingAnchor, targetParent);
  if (child === "" || child === ".") return [];
  if (child === ".." || child.startsWith(`..${sep}`)) {
    throw new PermissionDeniedError("새 파일의 상위 경로가 검사한 기존 디렉터리 밖으로 변경되었습니다.");
  }
  const pieces = child.split(sep).filter(Boolean);
  const result: string[] = [];
  let current = existingAnchor;
  for (const piece of pieces) {
    current = `${current}${current.endsWith(sep) ? "" : sep}${piece}`;
    const workspaceChild = relative(workspace, current);
    if (workspaceChild === ".." || workspaceChild.startsWith(`..${sep}`)) {
      throw new PermissionDeniedError("Workspace 밖에 디렉터리를 만들 수 없습니다.");
    }
    result.push(current);
  }
  return result;
}

async function prepareParent(
  guard: WorkspacePathGuard,
  expected: WorkspacePathResolution,
): Promise<{ current: WorkspacePathResolution; preparedDirectories: string[] }> {
  const initial = await refreshWritableTarget(guard, expected);
  if (initial.exists) return { current: initial, preparedDirectories: [] };
  const targetParent = dirname(initial.absolutePath);
  const planned = plannedDirectories(
    guard.workspace,
    targetParent,
    expected.parentPath,
  );
  const preparedDirectories: string[] = [];
  try {
    for (const directory of planned) {
      try {
        await mkdir(directory, { mode: 0o755 });
        preparedDirectories.push(directory);
      } catch (error) {
        if (errnoCode(error) !== "EEXIST") throw error;
        const existing = await lstat(directory);
        if (!existing.isDirectory() || existing.isSymbolicLink()) {
          throw new PermissionDeniedError(
            "새 파일의 상위 경로가 안전한 디렉터리가 아닙니다.",
          );
        }
      }
    }
    await assertAnchorUnchanged(expected);
    const current = await guard.resolveWritable(expected.requestedPath);
    if (current.absolutePath !== expected.absolutePath || current.exists) {
      throw new PermissionDeniedError("상위 디렉터리를 준비하는 동안 쓰기 대상이 변경되었습니다.");
    }
    return { current, preparedDirectories };
  } catch (error) {
    throw new WorkspaceFileOperationError(
      error instanceof Error ? error.message : "파일 상위 디렉터리를 준비하지 못했습니다.",
      preparedDirectories.length > 0,
      preparedDirectories,
      [],
      { cause: error },
    );
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeWorkspaceFileAtomic(
  guard: WorkspacePathGuard,
  expected: WorkspacePathResolution,
  content: Uint8Array,
  expectedDigest: string | undefined,
  modeOverride?: number,
): Promise<WorkspaceWriteResult> {
  if (content.byteLength > MAX_WORKSPACE_FILE_BYTES) {
    throw new ConfigurationError(`파일 내용이 ${MAX_WORKSPACE_FILE_BYTES} bytes 제한을 초과했습니다.`);
  }
  let preparedDirectories: string[] = [];
  let current: WorkspacePathResolution;
  try {
    const prepared = await prepareParent(guard, expected);
    current = prepared.current;
    preparedDirectories = prepared.preparedDirectories;
  } catch (error) {
    if (error instanceof WorkspaceFileOperationError) throw error;
    throw new WorkspaceFileOperationError(
      error instanceof Error ? error.message : "파일 상위 경로를 준비하지 못했습니다.",
      preparedDirectories.length > 0,
      preparedDirectories,
      [],
      { cause: error },
    );
  }

  const parent = dirname(current.absolutePath);
  const temporary = `${current.absolutePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  let primaryError: unknown;
  let cleanupError: unknown;
  let temporaryCreated = false;
  let renamed = false;
  try {
    await assertExpectedDigest(current, expectedDigest);
    const existingMode = current.exists
      ? (await lstat(current.absolutePath)).mode
      : undefined;
    const selectedMode = modeOverride ?? existingMode ?? 0o600;
    handle = await open(temporary, "wx", selectedMode & 0o777);
    temporaryCreated = true;
    await handle.writeFile(content);
    await handle.sync();
    if (process.platform !== "win32") await handle.chmod(selectedMode & 0o777);
    await handle.close();
    handle = undefined;
    const verified = await refreshWritableTarget(guard, current);
    await assertExpectedDigest(verified, expectedDigest);
    await rename(temporary, current.absolutePath);
    renamed = true;
    await syncDirectory(parent);
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await handle?.close();
    } catch (error) {
      cleanupError = error;
    }
    if (temporaryCreated && !renamed) {
      try {
        await unlink(temporary);
      } catch (error) {
        if (errnoCode(error) !== "ENOENT") cleanupError ??= error;
      }
    }
  }
  if (primaryError !== undefined || cleanupError !== undefined) {
    const cause = primaryError ?? cleanupError;
    throw new WorkspaceFileOperationError(
      cause instanceof Error ? cause.message : "파일을 원자적으로 교체하지 못했습니다.",
      renamed || preparedDirectories.length > 0 || cleanupError !== undefined,
      preparedDirectories,
      cleanupError !== undefined && !renamed
        ? [{
            path: temporary,
            digest: createHash("sha256").update(content).digest("hex"),
          }]
        : [],
      { cause },
    );
  }
  let resolution: WorkspacePathResolution;
  try {
    resolution = await guard.resolveWritable(expected.requestedPath);
    if (!resolution.exists || resolution.absolutePath !== expected.absolutePath) {
      throw new PermissionDeniedError("파일 교체 뒤 대상 identity를 확인하지 못했습니다.");
    }
  } catch (error) {
    throw new WorkspaceFileOperationError(
      "파일은 교체됐지만 완료 상태를 확인하지 못했습니다.",
      true,
      preparedDirectories,
      [],
      { cause: error },
    );
  }
  return { resolution, preparedDirectories };
}

export async function deleteWorkspaceFile(
  guard: WorkspacePathGuard,
  expected: WorkspacePathResolution,
  expectedDigest: string,
): Promise<void> {
  const current = await refreshWritableTarget(guard, expected);
  if (!current.exists) throw new ConfigurationError("삭제할 파일이 존재하지 않습니다.");
  await assertExpectedDigest(current, expectedDigest);
  let changed = false;
  try {
    await unlink(current.absolutePath);
    changed = true;
    await syncDirectory(dirname(current.absolutePath));
  } catch (error) {
    throw new WorkspaceFileOperationError(
      error instanceof Error ? error.message : "파일을 삭제하지 못했습니다.",
      changed,
      [],
      [],
      { cause: error },
    );
  }
}

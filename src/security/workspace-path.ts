import { lstat, realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { ConfigurationError, PermissionDeniedError } from "../core/errors.js";
import type { StoragePaths } from "../storage/paths.js";
import { canonicalWorkspace } from "../storage/paths.js";
import {
  createSensitivePathPolicy,
  resolvePotentialPath,
  type SensitivePathPolicy,
} from "./sensitive-paths.js";

const MAX_PATH_BYTES = 4 * 1024;
const MAX_PATH_COMPONENTS = 1_024;

export type WorkspacePathKind = "file" | "directory" | "file_or_directory";

export interface WorkspacePathResolution {
  requestedPath: string;
  displayPath: string;
  absolutePath: string;
  exists: boolean;
  kind: "file" | "directory" | "missing";
  device?: number;
  inode?: number;
  parentPath: string;
  parentDevice: number;
  parentInode: number;
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function inside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

function normalizedDisplay(path: string): string {
  const value = path.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  return value || ".";
}

function managedParts(parts: readonly string[]): readonly string[] {
  return process.platform === "win32"
    ? parts.map((part) => part.toLowerCase())
    : parts;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function assertRelativePath(path: string): void {
  const parts = path.split(/[\\/]+/u);
  const comparedParts = managedParts(parts);
  if (
    !path ||
    path.includes("\0") ||
    /\p{Cc}/u.test(path) ||
    Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES ||
    parts.length > MAX_PATH_COMPONENTS
  ) {
    throw new ConfigurationError("Workspace 파일 경로가 올바르지 않습니다.");
  }
  if (posix.isAbsolute(path) || win32.isAbsolute(path)) {
    throw new PermissionDeniedError("Workspace 파일 도구에는 절대 경로를 사용할 수 없습니다.");
  }
  if (process.platform !== "win32" && path.includes("\\")) {
    throw new ConfigurationError("이 환경의 workspace 경로 구분자는 /를 사용해야 합니다.");
  }
  if (comparedParts.includes("..")) {
    throw new PermissionDeniedError("Workspace 파일 경로에 .. 구성요소를 사용할 수 없습니다.");
  }
  if (comparedParts.includes(".git")) {
    throw new PermissionDeniedError("Git 내부 관리 경로에는 일반 파일 도구로 접근할 수 없습니다.");
  }
  for (let index = 0; index < comparedParts.length - 1; index += 1) {
    if (
      (comparedParts[index] === ".cat" || comparedParts[index] === ".smileserv") &&
      comparedParts[index + 1] === "worktrees"
    ) {
      throw new PermissionDeniedError("관리되는 다른 worktree에는 일반 파일 도구로 접근할 수 없습니다.");
    }
  }
}

function assertInsideAndManaged(workspace: string, candidate: string): void {
  if (!inside(workspace, candidate)) {
    throw new PermissionDeniedError("Workspace 밖의 파일에는 접근할 수 없습니다.");
  }
  const parts = managedParts(relative(workspace, candidate).split(sep).filter(Boolean));
  if (parts.includes(".git")) {
    throw new PermissionDeniedError("Git 내부 관리 경로에는 일반 파일 도구로 접근할 수 없습니다.");
  }
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (
      (parts[index] === ".cat" || parts[index] === ".smileserv") &&
      parts[index + 1] === "worktrees"
    ) {
      throw new PermissionDeniedError("관리되는 다른 worktree에는 일반 파일 도구로 접근할 수 없습니다.");
    }
  }
}

async function existingParent(path: string): Promise<{ path: string; device: number; inode: number }> {
  let current = dirname(path);
  for (let depth = 0; depth <= MAX_PATH_COMPONENTS; depth += 1) {
    try {
      const canonical = await realpath(current);
      const info = await stat(canonical);
      if (!info.isDirectory()) {
        throw new ConfigurationError("파일을 만들 상위 경로가 디렉터리가 아닙니다.");
      }
      return { path: canonical, device: info.dev, inode: info.ino };
    } catch (error) {
      const code = errnoCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new ConfigurationError("파일 경로의 기존 상위 디렉터리를 확인할 수 없습니다.");
}

function sameIdentity(
  leftDevice: number | undefined,
  leftInode: number | undefined,
  rightDevice: number | undefined,
  rightInode: number | undefined,
): boolean {
  if (
    leftDevice === undefined ||
    leftInode === undefined ||
    rightDevice === undefined ||
    rightInode === undefined
  ) {
    return false;
  }
  if (leftDevice !== rightDevice) return false;
  if (process.platform === "win32" && (leftInode === 0 || rightInode === 0)) return true;
  return leftInode === rightInode;
}

export class WorkspacePathGuard {
  private constructor(
    readonly workspace: string,
    readonly sensitivePaths: SensitivePathPolicy,
  ) {}

  static async create(
    workspace: string,
    sensitivePaths: SensitivePathPolicy,
  ): Promise<WorkspacePathGuard> {
    return new WorkspacePathGuard(await canonicalWorkspace(workspace), sensitivePaths);
  }

  async resolveExisting(
    requestedPath: string,
    expectedKind: WorkspacePathKind = "file_or_directory",
  ): Promise<WorkspacePathResolution> {
    assertRelativePath(requestedPath);
    let absolutePath: string;
    try {
      absolutePath = await realpath(resolve(this.workspace, requestedPath));
    } catch (error) {
      const code = errnoCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new ConfigurationError(`경로가 존재하지 않습니다: ${normalizedDisplay(requestedPath)}`);
      }
      throw new ConfigurationError("Workspace 파일 경로를 확인할 수 없습니다.", { cause: error });
    }
    assertInsideAndManaged(this.workspace, absolutePath);
    await this.sensitivePaths.assertAllowed(requestedPath);
    await this.sensitivePaths.assertAllowed(absolutePath);

    const info = await stat(absolutePath);
    const kind = info.isFile() ? "file" : info.isDirectory() ? "directory" : undefined;
    if (!kind || (expectedKind !== "file_or_directory" && kind !== expectedKind)) {
      throw new ConfigurationError(
        expectedKind === "file"
          ? "요청한 경로가 일반 파일이 아닙니다."
          : expectedKind === "directory"
            ? "요청한 경로가 디렉터리가 아닙니다."
            : "요청한 경로는 일반 파일 또는 디렉터리여야 합니다.",
      );
    }
    if (kind === "file" && info.nlink > 1) {
      throw new PermissionDeniedError("Hard-link 파일은 민감 경로 alias 여부를 보장할 수 없어 접근하지 않습니다.");
    }
    const parent = await existingParent(absolutePath);
    return {
      requestedPath,
      displayPath: normalizedDisplay(requestedPath),
      absolutePath,
      exists: true,
      kind,
      device: info.dev,
      inode: info.ino,
      parentPath: parent.path,
      parentDevice: parent.device,
      parentInode: parent.inode,
    };
  }

  async resolveWritable(requestedPath: string): Promise<WorkspacePathResolution> {
    assertRelativePath(requestedPath);
    const lexicalPath = resolve(this.workspace, requestedPath);
    assertInsideAndManaged(this.workspace, lexicalPath);
    try {
      const lexicalTarget = await lstat(lexicalPath);
      if (lexicalTarget.isSymbolicLink()) {
        throw new PermissionDeniedError(
          "쓰기 대상의 마지막 경로에는 symbolic link를 사용할 수 없습니다.",
        );
      }
    } catch (error) {
      const code = errnoCode(error);
      if (
        error instanceof PermissionDeniedError ||
        (code !== "ENOENT" && code !== "ENOTDIR")
      ) {
        throw error;
      }
    }
    let absolutePath: string;
    try {
      absolutePath = await resolvePotentialPath(requestedPath, this.workspace);
    } catch (error) {
      if (error instanceof ConfigurationError || error instanceof PermissionDeniedError) throw error;
      throw new ConfigurationError("Workspace 쓰기 경로를 확인할 수 없습니다.", { cause: error });
    }
    assertInsideAndManaged(this.workspace, absolutePath);
    await this.sensitivePaths.assertAllowed(requestedPath);
    await this.sensitivePaths.assertAllowed(absolutePath);

    const parent = await existingParent(absolutePath);
    assertInsideAndManaged(this.workspace, parent.path);
    let info: Stats | undefined;
    try {
      info = await lstat(absolutePath);
    } catch (error) {
      const code = errnoCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    if (info?.isSymbolicLink()) {
      throw new PermissionDeniedError("쓰기 대상의 마지막 경로가 symbolic link로 바뀌었습니다.");
    }
    if (info && !info.isFile()) {
      throw new ConfigurationError("일반 파일이 아닌 경로에는 쓸 수 없습니다.");
    }
    if (info && info.nlink > 1) {
      throw new PermissionDeniedError("Hard-link 파일은 민감 경로 alias 여부를 보장할 수 없어 수정하지 않습니다.");
    }
    return {
      requestedPath,
      displayPath: normalizedDisplay(requestedPath),
      absolutePath,
      exists: info !== undefined,
      kind: info ? "file" : "missing",
      ...(info ? { device: info.dev, inode: info.ino } : {}),
      parentPath: parent.path,
      parentDevice: parent.device,
      parentInode: parent.inode,
    };
  }

  async revalidateExisting(
    expected: WorkspacePathResolution,
    expectedKind: WorkspacePathKind = "file_or_directory",
  ): Promise<WorkspacePathResolution> {
    const current = await this.resolveExisting(expected.requestedPath, expectedKind);
    if (
      !samePath(current.absolutePath, expected.absolutePath) ||
      current.kind !== expected.kind ||
      !sameIdentity(current.device, current.inode, expected.device, expected.inode)
    ) {
      throw new PermissionDeniedError("승인 또는 검사 뒤 파일 대상이 변경되었습니다.");
    }
    return current;
  }

  async revalidateWritable(expected: WorkspacePathResolution): Promise<WorkspacePathResolution> {
    const current = await this.resolveWritable(expected.requestedPath);
    const targetMatches = samePath(current.absolutePath, expected.absolutePath) &&
      current.exists === expected.exists &&
      current.kind === expected.kind &&
      (current.exists
        ? sameIdentity(current.device, current.inode, expected.device, expected.inode)
        : true);
    const parentMatches = samePath(current.parentPath, expected.parentPath) &&
      sameIdentity(
        current.parentDevice,
        current.parentInode,
        expected.parentDevice,
        expected.parentInode,
      );
    if (!targetMatches || !parentMatches) {
      throw new PermissionDeniedError("승인 또는 검사 뒤 쓰기 대상이 변경되었습니다.");
    }
    return current;
  }
}

export async function createWorkspacePathGuard(
  paths: StoragePaths,
  userHome: string = homedir(),
): Promise<WorkspacePathGuard> {
  return await WorkspacePathGuard.create(
    paths.workspace,
    createSensitivePathPolicy(paths, userHome),
  );
}

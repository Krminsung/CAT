import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { ConfigurationError, PermissionDeniedError } from "../core/errors.js";
import type { StoragePaths } from "../storage/paths.js";

const MAX_PATH_BYTES = 32 * 1024;
const MAX_PATH_COMPONENTS = 1_024;

interface FileIdentity {
  device: number;
  inode: number;
}

export interface SensitivePathMatch {
  requestedPath: string;
  resolvedPath: string;
  sensitive: boolean;
  kind?: "file" | "directory";
  label?: string;
}

interface ProtectedPath {
  path: string;
  label: string;
}

interface ProtectedStorageEntries {
  files: readonly ProtectedPath[];
  directories: readonly ProtectedPath[];
}

function protectedStorageEntries(
  paths: StoragePaths,
  userHome: string,
): ProtectedStorageEntries {
  if (!isAbsolute(userHome) || userHome.includes("\0")) {
    throw new ConfigurationError("사용자 홈 경로는 유효한 절대 경로여야 합니다.");
  }
  const legacyRoot = join(userHome, ".smileserv");
  return {
    files: [
      { path: paths.userSettings, label: "cat 사용자 설정" },
      { path: paths.credentialStore, label: "cat 자격 증명 저장소" },
      { path: paths.profileStore, label: "cat provider profile 저장소" },
      { path: paths.trustStore, label: "cat workspace trust 저장소" },
      { path: paths.approvalStore, label: "cat 프로젝트 승인 저장소" },
      { path: join(paths.catHome, "secrets.json"), label: "cat secret 저장소" },
      { path: join(legacyRoot, "credentials.json"), label: "기존 자격 증명 저장소" },
      { path: join(legacyRoot, "providers.json"), label: "기존 provider 저장소" },
    ],
    directories: [
      { path: paths.sessionStore, label: "cat 세션 저장소" },
      { path: join(paths.catHome, "tasks"), label: "cat background task 저장소" },
      { path: join(paths.catHome, "credentials"), label: "cat 자격 증명 디렉터리" },
      { path: join(paths.catHome, "profiles"), label: "cat provider profile 디렉터리" },
      { path: join(paths.catHome, "secrets"), label: "cat secret 디렉터리" },
      { path: join(legacyRoot, "credentials"), label: "기존 자격 증명 디렉터리" },
      { path: join(legacyRoot, "providers"), label: "기존 provider 디렉터리" },
      { path: join(legacyRoot, "secrets"), label: "기존 secret 디렉터리" },
    ],
  };
}

export function listSensitiveStoragePaths(
  paths: StoragePaths,
  userHome: string = homedir(),
): readonly string[] {
  const protectedPaths = protectedStorageEntries(paths, userHome);
  return [...protectedPaths.files, ...protectedPaths.directories].map((entry) => entry.path);
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function pathInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * 존재하지 않는 마지막 구성요소가 있어도 가장 가까운 기존 상위 경로의 symlink를
 * 해석한다. 호출자는 검사 뒤 원래 입력이 아니라 반환된 경로만 사용해야 한다.
 */
export async function resolvePotentialPath(
  requestedPath: string,
  basePath: string,
): Promise<string> {
  if (
    !requestedPath ||
    requestedPath.includes("\0") ||
    Buffer.byteLength(requestedPath, "utf8") > MAX_PATH_BYTES ||
    requestedPath.split(sep).length > MAX_PATH_COMPONENTS
  ) {
    throw new ConfigurationError("검사할 파일 경로가 올바르지 않습니다.");
  }
  if (!isAbsolute(basePath) || basePath.includes("\0")) {
    throw new ConfigurationError("민감 경로 검사 기준은 절대 경로여야 합니다.");
  }
  const joined = isAbsolute(requestedPath)
    ? requestedPath
    : `${basePath}${basePath.endsWith(sep) ? "" : sep}${requestedPath}`;
  let probe = joined;
  const missingSuffix: string[] = [];
  for (let depth = 0; depth <= MAX_PATH_COMPONENTS; depth += 1) {
    try {
      const existingPrefix = await realpath(probe);
      if (missingSuffix.some((part) => part === "." || part === "..")) {
        throw new ConfigurationError(
          "존재하지 않는 경로 뒤에는 . 또는 .. 구성요소를 사용할 수 없습니다.",
        );
      }
      return resolve(existingPrefix, ...missingSuffix);
    } catch (error) {
      const code = errnoCode(error);
      if (code === "ELOOP") {
        throw new ConfigurationError("파일 경로에 순환 symbolic link가 있습니다.", {
          cause: error,
        });
      }
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(probe);
      if (parent === probe) {
        throw new ConfigurationError("파일 경로의 기존 상위 경로를 확인할 수 없습니다.", {
          cause: error,
        });
      }
      missingSuffix.unshift(basename(probe));
      probe = parent;
    }
  }
  throw new ConfigurationError("파일 경로의 구성요소가 너무 많습니다.");
}

async function fileIdentity(path: string): Promise<FileIdentity | undefined> {
  try {
    const info = await stat(path);
    return { device: info.dev, inode: info.ino };
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

function sameFile(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  return left !== undefined && right !== undefined &&
    !(left.inode === 0 && right.inode === 0) &&
    left.device === right.device && left.inode === right.inode;
}

export class SensitivePathPolicy {
  readonly #basePath: string;
  readonly #files: readonly ProtectedPath[];
  readonly #directories: readonly ProtectedPath[];

  private constructor(
    basePath: string,
    files: readonly ProtectedPath[],
    directories: readonly ProtectedPath[],
  ) {
    if (!isAbsolute(basePath) || basePath.includes("\0")) {
      throw new ConfigurationError("민감 경로 검사 기준은 절대 경로여야 합니다.");
    }
    for (const entry of [...files, ...directories]) {
      if (!isAbsolute(entry.path) || entry.path.includes("\0")) {
        throw new ConfigurationError("보호할 경로는 유효한 절대 경로여야 합니다.");
      }
    }
    this.#basePath = resolve(basePath);
    this.#files = files.map((entry) => ({ ...entry, path: resolve(entry.path) }));
    this.#directories = directories.map((entry) => ({ ...entry, path: resolve(entry.path) }));
  }

  static fromStoragePaths(
    paths: StoragePaths,
    userHome: string = homedir(),
  ): SensitivePathPolicy {
    const protectedPaths = protectedStorageEntries(paths, userHome);
    return new SensitivePathPolicy(
      paths.workspace,
      protectedPaths.files,
      protectedPaths.directories,
    );
  }

  async classify(requestedPath: string): Promise<SensitivePathMatch> {
    const requestedAbsolute = resolve(this.#basePath, requestedPath);
    const resolvedPath = await resolvePotentialPath(requestedPath, this.#basePath);
    const candidateIdentity = await fileIdentity(resolvedPath);

    for (const protectedFile of this.#files) {
      const resolvedProtected = await resolvePotentialPath(protectedFile.path, this.#basePath);
      if (
        samePath(requestedAbsolute, protectedFile.path) ||
        samePath(resolvedPath, resolvedProtected) ||
        sameFile(candidateIdentity, await fileIdentity(resolvedProtected))
      ) {
        return {
          requestedPath,
          resolvedPath,
          sensitive: true,
          kind: "file",
          label: protectedFile.label,
        };
      }
    }

    for (const protectedDirectory of this.#directories) {
      const resolvedProtected = await resolvePotentialPath(
        protectedDirectory.path,
        this.#basePath,
      );
      if (
        pathInside(protectedDirectory.path, requestedAbsolute) ||
        pathInside(resolvedProtected, resolvedPath)
      ) {
        return {
          requestedPath,
          resolvedPath,
          sensitive: true,
          kind: "directory",
          label: protectedDirectory.label,
        };
      }
    }
    return { requestedPath, resolvedPath, sensitive: false };
  }

  async assertAllowed(requestedPath: string): Promise<string> {
    const match = await this.classify(requestedPath);
    if (match.sensitive) {
      throw new PermissionDeniedError(
        `${match.label ?? "보호된 자격 증명 경로"}은 일반 파일 도구로 접근할 수 없습니다.`,
      );
    }
    return match.resolvedPath;
  }
}

export function createSensitivePathPolicy(
  paths: StoragePaths,
  userHome: string = homedir(),
): SensitivePathPolicy {
  return SensitivePathPolicy.fromStoragePaths(paths, userHome);
}

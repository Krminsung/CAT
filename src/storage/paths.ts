import { lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ConfigurationError } from "../core/errors.js";

export interface StoragePaths {
  workspace: string;
  projectRoot: string;
  catHome: string;
  userSettings: string;
  credentialStore: string;
  profileStore: string;
  trustStore: string;
  projectSettings: string;
  projectLocalSettings: string;
  projectCommands: string;
  projectSkills: string;
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

export function resolveCatHome(
  environment: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
): string {
  const configured = environment.CAT_HOME?.trim();
  if (!configured) return join(userHome, ".cat");
  if (configured.includes("\0")) {
    throw new ConfigurationError("CAT_HOME에 NUL 문자를 포함할 수 없습니다.");
  }
  if (!isAbsolute(configured)) {
    throw new ConfigurationError("CAT_HOME은 절대 경로여야 합니다.");
  }
  return resolve(configured);
}

export async function canonicalWorkspace(path: string): Promise<string> {
  if (!path || path.includes("\0")) {
    throw new ConfigurationError("작업공간 경로가 올바르지 않습니다.");
  }
  let canonical: string;
  try {
    canonical = await realpath(resolve(path));
    if (!(await stat(canonical)).isDirectory()) {
      throw new ConfigurationError("작업공간 경로가 디렉터리가 아닙니다.");
    }
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError("작업공간 경로를 확인할 수 없습니다.", {
      cause: error,
    });
  }
  return canonical;
}

export async function findProjectRoot(workspace: string): Promise<string> {
  const start = await canonicalWorkspace(workspace);
  let current = start;
  while (true) {
    try {
      await lstat(join(current, ".git"));
      return current;
    } catch (error) {
      const code = errnoCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new ConfigurationError("Git 프로젝트 기준 경로를 확인할 수 없습니다.", {
          cause: error,
        });
      }
    }
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

export async function resolveStoragePaths(
  workspace: string,
  environment: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
): Promise<StoragePaths> {
  const canonical = await canonicalWorkspace(workspace);
  const projectRoot = await findProjectRoot(canonical);
  const catHome = resolveCatHome(environment, userHome);
  const projectCat = join(projectRoot, ".cat");
  return {
    workspace: canonical,
    projectRoot,
    catHome,
    userSettings: join(catHome, "settings.json"),
    credentialStore: join(catHome, "credentials.json"),
    profileStore: join(catHome, "profiles.json"),
    trustStore: join(catHome, "trusted-workspaces.json"),
    projectSettings: join(projectCat, "settings.json"),
    projectLocalSettings: join(projectCat, "settings.local.json"),
    projectCommands: join(projectCat, "commands"),
    projectSkills: join(projectCat, "skills"),
  };
}

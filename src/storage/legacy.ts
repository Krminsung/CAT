import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ConfigurationError } from "../core/errors.js";

export interface LegacyDataPresence {
  root: string;
  detected: boolean;
  entries: readonly string[];
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

export async function detectLegacyData(
  userHome: string = homedir(),
): Promise<LegacyDataPresence> {
  if (!isAbsolute(userHome) || userHome.includes("\0")) {
    throw new ConfigurationError("기존 데이터 탐색 기준은 유효한 절대 경로여야 합니다.");
  }
  const root = join(resolve(userHome), ".smileserv");
  const candidates = [
    "credentials.json",
    "providers.json",
    "settings.json",
    "trusted-workspaces.json",
    "sessions",
  ];
  const entries: string[] = [];
  for (const name of candidates) {
    try {
      await lstat(join(root, name));
      entries.push(name);
    } catch (error) {
      const code = errnoCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }
  return { root, detected: entries.length > 0, entries };
}

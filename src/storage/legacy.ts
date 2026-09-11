import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ConfigurationError, StorageError } from "../core/errors.js";
import type { JsonObject } from "../core/json.js";
import { readJsonObject } from "./json-file.js";
import { readJsonlPage, type JsonlPage } from "./jsonl.js";

const LEGACY_JSON_BYTES = 64 * 1024;
const LEGACY_SETTINGS_BYTES = 1024 * 1024;
const LEGACY_JSONL_LINE_BYTES = 4 * 1024 * 1024;
const LEGACY_JSONL_SCAN_BYTES = 16 * 1024 * 1024;
const LEGACY_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export const LEGACY_DATA_ENTRY_NAMES = Object.freeze([
  "credentials.json",
  "providers.json",
  "settings.json",
  "trusted-workspaces.json",
  "sessions.jsonl",
  "transcripts",
] as const);

export type LegacyDataEntryName = (typeof LEGACY_DATA_ENTRY_NAMES)[number];

export interface LegacyDataPresence {
  readonly root: string;
  readonly detected: boolean;
  readonly entries: readonly LegacyDataEntryName[];
}

export interface LegacyDataSource extends LegacyDataPresence {
  readonly detected: true;
  readonly fingerprint: string;
  readonly device: string;
  readonly inode: string;
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

function assertOwned(info: Stats, label: string): void {
  const expected = currentUserId();
  if (expected !== undefined && info.uid !== expected) {
    throw new StorageError(`${label}이 현재 사용자 소유가 아닙니다.`);
  }
}

function assertPrivateMode(info: Stats, label: string): void {
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new StorageError(`${label} 권한은 현재 사용자에게만 허용되어야 합니다.`);
  }
}

function normalizedRoot(value: string, label: string): string {
  if (
    !isAbsolute(value) ||
    value.includes("\0") ||
    /[\u0001-\u001f\u007f]/u.test(value) ||
    [...value].length > 4_096
  ) {
    throw new ConfigurationError(`${label}은 유효한 절대 경로여야 합니다.`);
  }
  return resolve(value);
}

async function rootInfo(
  root: string,
  missingAllowed: boolean,
): Promise<{ readonly root: string; readonly info?: Stats }> {
  const requested = normalizedRoot(root, "기존 데이터 경로");
  let initial: Stats;
  try {
    initial = await lstat(requested);
  } catch (error) {
    if (missingAllowed && (errnoCode(error) === "ENOENT" || errnoCode(error) === "ENOTDIR")) {
      return Object.freeze({ root: requested });
    }
    throw new StorageError("기존 데이터 경로를 확인할 수 없습니다.", { cause: error });
  }
  if (initial.isSymbolicLink() || !initial.isDirectory()) {
    throw new StorageError("기존 데이터 경로는 심볼릭 링크가 아닌 실제 디렉터리여야 합니다.");
  }
  assertOwned(initial, "기존 데이터 디렉터리");
  const canonical = await realpath(requested);
  const opened = await lstat(canonical);
  if (
    opened.isSymbolicLink() ||
    !opened.isDirectory() ||
    opened.dev !== initial.dev ||
    opened.ino !== initial.ino
  ) {
    throw new StorageError("기존 데이터 디렉터리가 확인 중 변경되었습니다.");
  }
  assertOwned(opened, "기존 데이터 디렉터리");
  return Object.freeze({ root: canonical, info: opened });
}

async function entriesAt(root: string): Promise<readonly LegacyDataEntryName[]> {
  const entries: LegacyDataEntryName[] = [];
  for (const name of LEGACY_DATA_ENTRY_NAMES) {
    try {
      await lstat(join(root, name));
      entries.push(name);
    } catch (error) {
      const code = errnoCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }
  return Object.freeze(entries);
}

export async function detectLegacyData(
  userHome: string = homedir(),
): Promise<LegacyDataPresence> {
  const home = normalizedRoot(userHome, "기존 데이터 탐색 기준");
  const inspected = await rootInfo(join(home, ".smileserv"), true);
  if (!inspected.info) {
    return Object.freeze({ root: inspected.root, detected: false, entries: Object.freeze([]) });
  }
  const entries = await entriesAt(inspected.root);
  return Object.freeze({
    root: inspected.root,
    detected: entries.length > 0,
    entries,
  });
}

export async function openLegacyDataSource(root: string): Promise<LegacyDataSource> {
  const inspected = await rootInfo(root, false);
  const info = inspected.info;
  if (!info) throw new StorageError("기존 데이터 디렉터리를 찾을 수 없습니다.");
  assertPrivateMode(info, "기존 데이터 디렉터리");
  const entries = await entriesAt(inspected.root);
  if (entries.length === 0) {
    throw new ConfigurationError("가져올 수 있는 Smile Code 데이터 파일을 찾지 못했습니다.");
  }
  const fingerprint = createHash("sha256")
    .update(`${inspected.root}\0${String(info.dev)}\0${String(info.ino)}`, "utf8")
    .digest("hex");
  return Object.freeze({
    root: inspected.root,
    detected: true,
    entries,
    fingerprint,
    device: String(info.dev),
    inode: String(info.ino),
  });
}

export async function assertLegacyDataSourceCurrent(
  source: LegacyDataSource,
): Promise<void> {
  const inspected = await rootInfo(source.root, false);
  const info = inspected.info;
  if (
    !info ||
    inspected.root !== source.root ||
    String(info.dev) !== source.device ||
    String(info.ino) !== source.inode
  ) {
    throw new StorageError("기존 데이터 디렉터리가 가져오기 중 변경되었습니다.");
  }
  assertPrivateMode(info, "기존 데이터 디렉터리");
}

export async function readLegacySettings(
  source: LegacyDataSource,
): Promise<JsonObject | undefined> {
  await assertLegacyDataSourceCurrent(source);
  return await readJsonObject(join(source.root, "settings.json"), {
    label: "기존 Smile Code 사용자 설정",
    maxBytes: LEGACY_SETTINGS_BYTES,
    maxDepth: 40,
    maxNodes: 40_000,
    requireOwner: true,
  });
}

export async function readLegacyCredentials(
  source: LegacyDataSource,
): Promise<JsonObject | undefined> {
  await assertLegacyDataSourceCurrent(source);
  return await readJsonObject(join(source.root, "credentials.json"), {
    label: "기존 Smile Code credential",
    maxBytes: LEGACY_JSON_BYTES,
    maxDepth: 12,
    maxNodes: 4_096,
    requireOwner: true,
    requirePrivateMode: true,
  });
}

export async function readLegacyProviderCredentials(
  source: LegacyDataSource,
): Promise<JsonObject | undefined> {
  await assertLegacyDataSourceCurrent(source);
  return await readJsonObject(join(source.root, "providers.json"), {
    label: "기존 Smile Code provider credential",
    maxBytes: LEGACY_JSON_BYTES,
    maxDepth: 20,
    maxNodes: 8_192,
    requireOwner: true,
    requirePrivateMode: true,
  });
}

export async function readLegacySessionIndexPage(
  source: LegacyDataSource,
  options: { readonly cursor?: string; readonly limit?: number } = {},
): Promise<JsonlPage<JsonObject>> {
  await assertLegacyDataSourceCurrent(source);
  return await readJsonlPage(join(source.root, "sessions.jsonl"), {
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    label: "기존 Smile Code 세션 index",
    maxLineBytes: LEGACY_JSONL_LINE_BYTES,
    maxScanBytes: LEGACY_JSONL_SCAN_BYTES,
    maxDepth: 20,
    maxNodes: 8_192,
    requireOwner: true,
    requirePrivateMode: true,
  });
}

async function assertTranscriptDirectory(source: LegacyDataSource): Promise<boolean> {
  const directory = join(source.root, "transcripts");
  let info: Stats;
  try {
    info = await lstat(directory);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new StorageError("기존 transcript 디렉터리를 확인할 수 없습니다.", { cause: error });
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new StorageError("기존 transcript 경로는 실제 디렉터리여야 합니다.");
  }
  assertOwned(info, "기존 transcript 디렉터리");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new StorageError("기존 transcript 디렉터리 권한은 현재 사용자에게만 허용되어야 합니다.");
  }
  return true;
}

export async function readLegacyTranscriptPage(
  source: LegacyDataSource,
  sessionId: string,
  options: { readonly cursor?: string; readonly limit?: number } = {},
): Promise<JsonlPage<JsonObject>> {
  if (!LEGACY_SESSION_ID.test(sessionId)) {
    throw new ConfigurationError("기존 transcript 세션 ID 형식이 올바르지 않습니다.");
  }
  await assertLegacyDataSourceCurrent(source);
  if (!await assertTranscriptDirectory(source)) {
    return Object.freeze({
      records: Object.freeze([]),
      warnings: Object.freeze([]),
      omittedWarnings: 0,
      snapshotBytes: 0,
    });
  }
  return await readJsonlPage(join(source.root, "transcripts", `${sessionId}.jsonl`), {
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    label: `기존 Smile Code 세션 ${sessionId} transcript`,
    maxLineBytes: LEGACY_JSONL_LINE_BYTES,
    maxScanBytes: LEGACY_JSONL_SCAN_BYTES,
    maxDepth: 32,
    maxNodes: 38_000,
    requireOwner: true,
    requirePrivateMode: true,
  });
}

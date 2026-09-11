import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CancelledError,
  ConfigurationError,
  PermissionDeniedError,
  StorageError,
} from "../core/errors.js";
import type { JsonObject, JsonValue } from "../core/json.js";
import { captureChildProcess } from "../process/child-process.js";
import { buildChildEnvironment } from "../security/environment.js";
import { readJsonObject, writeJsonObjectAtomic } from "../storage/json-file.js";
import { canonicalWorkspace } from "../storage/paths.js";

const WORKTREE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const WORKTREE_STATES = new Set<ManagedWorktreeState>([
  "creating",
  "active",
  "removing",
  "unknown",
]);
const REGISTRY_SCHEMA_VERSION = 1;
const MAX_REGISTRY_BYTES = 512 * 1024;
const MAX_REGISTRY_ENTRIES = 128;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const MAX_GIT_PATH_BYTES = 32 * 1024;
const MAX_REF_BYTES = 1_024;
const GIT_TIMEOUT_MS = 30_000;

export type ManagedWorktreeState = "creating" | "active" | "removing" | "unknown";

export type ManagedWorktreePresence =
  | "ready"
  | "missing"
  | "orphaned_path"
  | "prunable";

export interface ManagedWorktreeSnapshot {
  readonly name: string;
  readonly path: string;
  readonly createdBranch: string;
  readonly currentBranch: string | null;
  readonly head: string | null;
  readonly baseRef: string;
  readonly createdAt: string;
  readonly state: ManagedWorktreeState;
  readonly presence: ManagedWorktreePresence;
  readonly identityMatches: boolean;
  readonly locked: boolean;
  readonly lockedReason: string | null;
  readonly prunable: boolean;
  readonly current: boolean;
}

export interface CreateManagedWorktreeRequest {
  readonly name?: string;
  readonly baseRef?: string;
  readonly signal?: AbortSignal;
}

export interface RemoveManagedWorktreeResult {
  readonly name: string;
  readonly path: string;
  readonly retainedBranch: string;
  readonly worktreeRemoved: boolean;
  readonly registryOnly: boolean;
}

export interface GitWorktreeManagerOptions {
  readonly workspace: string;
  readonly storageRoot: string;
  readonly callerCwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}

interface RepositoryIdentity {
  readonly commonDirectory: string;
  readonly device: number;
  readonly inode: number;
}

interface RegistryEntry {
  readonly name: string;
  readonly path: string;
  readonly createdBranch: string;
  readonly baseRef: string;
  readonly createdAt: string;
  readonly state: ManagedWorktreeState;
  readonly device: number | null;
  readonly inode: number | null;
}

interface WorktreeRegistry {
  readonly repository: RepositoryIdentity;
  readonly entries: readonly RegistryEntry[];
}

interface GitWorktreeRecord {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked: boolean;
  readonly lockedReason: string | null;
  readonly prunable: boolean;
}

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

function sameIdentity(
  leftDevice: number,
  leftInode: number,
  rightDevice: number,
  rightInode: number,
): boolean {
  if (leftDevice !== rightDevice) return false;
  if (process.platform === "win32" && (leftInode === 0 || rightInode === 0)) return true;
  return leftInode === rightInode;
}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StorageError(`${label} filesystem identity가 안전한 정수가 아닙니다.`);
  }
}

function isoTimestamp(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) {
    throw new ConfigurationError(`${label} 시각이 올바르지 않습니다.`);
  }
  return new Date(value).toISOString();
}

async function resolvePotentialDirectory(value: string): Promise<string> {
  let current = resolve(value);
  const suffix: string[] = [];
  for (let depth = 0; depth <= 1_024; depth += 1) {
    try {
      return resolve(await realpath(current), ...suffix);
    } catch (error) {
      const code = errnoCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) break;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
  throw new StorageError("managed worktree 저장소의 기존 상위 경로를 확인하지 못했습니다.");
}

function cleanDiagnostic(value: string): string {
  const cleaned = value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const bytes = Buffer.from(cleaned, "utf8");
  if (bytes.byteLength <= 4_096) return cleaned;
  let end = 4_093;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}…`;
}

function safePath(value: string, label: string): string {
  if (
    !value ||
    !isAbsolute(value) ||
    value.includes("\0") ||
    /[\p{Cc}\p{Cf}]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_GIT_PATH_BYTES
  ) {
    throw new ConfigurationError(`${label} 경로 형식 또는 크기가 올바르지 않습니다.`);
  }
  return resolve(value);
}

export function normalizeWorktreeName(value: string): string {
  const name = value.trim().toLowerCase();
  if (
    !WORKTREE_NAME.test(name) ||
    name === "." ||
    name === ".." ||
    name.endsWith(".") ||
    name.endsWith(".lock") ||
    name.includes("..") ||
    name.includes("@{")
  ) {
    throw new ConfigurationError(
      "worktree 이름은 소문자·숫자로 시작하고 . _ - 만 포함하는 1–64자여야 합니다.",
    );
  }
  return name;
}

function generatedWorktreeName(now: number): string {
  isoTimestamp(now, "worktree 생성");
  const date = new Date(now);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return normalizeWorktreeName(
    `session-${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}-` +
    randomBytes(3).toString("hex"),
  );
}

function safeRef(value: string, label: string): string {
  const selected = value.trim();
  if (
    !selected ||
    selected.startsWith("-") ||
    selected.includes("\0") ||
    /[\p{Cc}\p{Cf}]/u.test(selected) ||
    Buffer.byteLength(selected, "utf8") > MAX_REF_BYTES
  ) {
    throw new ConfigurationError(`${label} Git ref 형식 또는 크기가 올바르지 않습니다.`);
  }
  return selected;
}

function object(value: JsonValue | undefined, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StorageError(`${label}은 객체여야 합니다.`);
  }
  return value;
}

function text(value: JsonValue | undefined, label: string, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    /[\p{Cc}\p{Cf}]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new StorageError(`${label} 문자열 형식 또는 크기가 올바르지 않습니다.`);
  }
  return value;
}

function integer(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new StorageError(`${label}은 음수가 아닌 안전한 정수여야 합니다.`);
  }
  return value;
}

function nullableInteger(value: JsonValue | undefined, label: string): number | null {
  return value === null ? null : integer(value, label);
}

function timestamp(value: JsonValue | undefined, label: string): string {
  const selected = text(value, label, 64);
  const milliseconds = Date.parse(selected);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== selected) {
    throw new StorageError(`${label} 시각 형식이 올바르지 않습니다.`);
  }
  return selected;
}

function state(value: JsonValue | undefined, label: string): ManagedWorktreeState {
  if (typeof value !== "string" || !WORKTREE_STATES.has(value as ManagedWorktreeState)) {
    throw new StorageError(`${label} 상태가 올바르지 않습니다.`);
  }
  return value as ManagedWorktreeState;
}

function repositoryFromJson(value: JsonValue | undefined): RepositoryIdentity {
  const raw = object(value, "worktree registry repository");
  return {
    commonDirectory: safePath(
      text(raw.commonDirectory, "worktree registry commonDirectory", MAX_GIT_PATH_BYTES),
      "worktree registry commonDirectory",
    ),
    device: integer(raw.device, "worktree registry repository device"),
    inode: integer(raw.inode, "worktree registry repository inode"),
  };
}

function entryFromJson(value: JsonValue, directory: string, index: number): RegistryEntry {
  const raw = object(value, `worktree registry entry ${index}`);
  const name = normalizeWorktreeName(text(raw.name, `worktree entry ${index} name`, 64));
  const expectedPath = join(directory, "trees", name);
  const path = safePath(
    text(raw.path, `worktree entry ${index} path`, MAX_GIT_PATH_BYTES),
    `worktree entry ${index}`,
  );
  if (!samePath(path, expectedPath)) {
    throw new StorageError(`worktree registry entry ${index}가 관리 경로 밖을 가리킵니다.`);
  }
  const createdBranch = text(raw.createdBranch, `worktree entry ${index} branch`, MAX_REF_BYTES);
  if (createdBranch !== `cat/worktree/${name}`) {
    throw new StorageError(`worktree registry entry ${index} branch가 이름과 일치하지 않습니다.`);
  }
  const device = nullableInteger(raw.device, `worktree entry ${index} device`);
  const inode = nullableInteger(raw.inode, `worktree entry ${index} inode`);
  if ((device === null) !== (inode === null)) {
    throw new StorageError(`worktree registry entry ${index} identity가 불완전합니다.`);
  }
  return {
    name,
    path,
    createdBranch,
    baseRef: safeRef(text(raw.baseRef, `worktree entry ${index} base`, MAX_REF_BYTES), "저장된 base"),
    createdAt: timestamp(raw.createdAt, `worktree entry ${index} createdAt`),
    state: state(raw.state, `worktree entry ${index}`),
    device,
    inode,
  };
}

function registryJson(registry: WorktreeRegistry): JsonObject {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    repository: {
      commonDirectory: registry.repository.commonDirectory,
      device: registry.repository.device,
      inode: registry.repository.inode,
    },
    entries: registry.entries.map((entry) => ({
      name: entry.name,
      path: entry.path,
      createdBranch: entry.createdBranch,
      baseRef: entry.baseRef,
      createdAt: entry.createdAt,
      state: entry.state,
      device: entry.device,
      inode: entry.inode,
    })),
  };
}

function gitArguments(args: readonly string[], hooksPath?: string): readonly string[] {
  return [
    "--no-pager",
    "-c",
    "color.ui=false",
    "-c",
    "core.fsmonitor=false",
    ...(hooksPath === undefined ? [] : ["-c", `core.hooksPath=${hooksPath}`]),
    ...args,
  ];
}

async function runGit(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
  acceptedExitCodes: readonly number[] = [0],
  hooksPath?: string,
): Promise<GitResult> {
  const completed = await captureChildProcess("git", gitArguments(args, hooksPath), {
    cwd,
    environment,
    timeoutMs: GIT_TIMEOUT_MS,
    maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
    signal,
  });
  if (completed.cancelled) {
    throw new CancelledError(
      completed.started
        ? "Git worktree 명령을 취소했습니다. 이미 생긴 변경은 목록에서 확인하세요."
        : "Git worktree 명령을 시작하기 전에 취소했습니다.",
    );
  }
  if (completed.timedOut || completed.outputLimitReached) {
    throw new StorageError(
      completed.timedOut
        ? "Git worktree 명령이 30초 제한을 초과했습니다. 결과 상태를 목록에서 확인하세요."
        : "Git worktree 명령 출력이 1MiB 제한을 초과했습니다. 결과 상태를 목록에서 확인하세요.",
    );
  }
  if (completed.spawnErrorMessage !== undefined) {
    throw new ConfigurationError(
      completed.spawnErrorCode === "ENOENT"
        ? "git 실행 파일을 찾을 수 없습니다."
        : `git을 시작하지 못했습니다: ${cleanDiagnostic(completed.spawnErrorMessage)}`,
    );
  }
  const exitCode = completed.exitCode;
  if (exitCode === null || !acceptedExitCodes.includes(exitCode)) {
    const detail = cleanDiagnostic(completed.stderr || completed.stdout);
    throw new StorageError(
      `Git worktree 명령이 종료 코드 ${exitCode ?? "unknown"}로 실패했습니다${detail ? `: ${detail}` : "."}`,
    );
  }
  return { stdout: completed.stdout, stderr: completed.stderr, exitCode };
}

async function discoverRepository(
  workspace: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<RepositoryIdentity> {
  const inside = await runGit(
    workspace,
    ["rev-parse", "--is-inside-work-tree"],
    environment,
    signal,
  );
  if (inside.stdout.trim() !== "true") {
    throw new ConfigurationError("Git working tree 안에서만 managed worktree를 사용할 수 있습니다.");
  }
  const common = await runGit(
    workspace,
    ["rev-parse", "--git-common-dir"],
    environment,
    signal,
  );
  const raw = common.stdout.replace(/\r?\n$/u, "");
  if (!raw || /[\r\n\0]/u.test(raw)) {
    throw new StorageError("Git common directory 응답 형식이 올바르지 않습니다.");
  }
  const candidate = isAbsolute(raw) ? raw : resolve(workspace, raw);
  const commonDirectory = await realpath(candidate);
  const info = await stat(commonDirectory);
  if (!info.isDirectory()) throw new StorageError("Git common directory가 디렉터리가 아닙니다.");
  assertSafeInteger(info.dev, "Git common directory device");
  assertSafeInteger(info.ino, "Git common directory inode");
  return { commonDirectory, device: info.dev, inode: info.ino };
}

function parseWorktreePorcelain(value: string): readonly GitWorktreeRecord[] {
  const records: GitWorktreeRecord[] = [];
  let current: {
    path: string;
    head: string | null;
    branch: string | null;
    detached: boolean;
    bare: boolean;
    locked: boolean;
    lockedReason: string | null;
    prunable: boolean;
  } | undefined;
  const finish = (): void => {
    if (!current) return;
    records.push(Object.freeze({ ...current }));
    if (records.length > 256) {
      throw new StorageError("Git worktree 목록이 256개 상한을 초과했습니다.");
    }
    current = undefined;
  };
  for (const field of value.split("\0")) {
    if (!field) continue;
    if (field.startsWith("worktree ")) {
      finish();
      current = {
        path: safePath(field.slice("worktree ".length), "Git worktree"),
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        lockedReason: null,
        prunable: false,
      };
      continue;
    }
    if (!current) throw new StorageError("Git worktree porcelain field 순서가 올바르지 않습니다.");
    if (field.startsWith("HEAD ")) {
      const head = field.slice(5);
      if (!/^[a-f0-9]{40,64}$/u.test(head)) {
        throw new StorageError("Git worktree HEAD 형식이 올바르지 않습니다.");
      }
      current.head = head;
    } else if (field.startsWith("branch ")) {
      const branch = text(field.slice(7), "Git worktree branch", MAX_REF_BYTES);
      current.branch = branch.startsWith("refs/heads/") ? branch.slice(11) : branch;
    } else if (field === "detached") {
      current.detached = true;
    } else if (field === "bare") {
      current.bare = true;
    } else if (field === "locked" || field.startsWith("locked ")) {
      current.locked = true;
      current.lockedReason = field.length === 6 ? null : cleanDiagnostic(field.slice(7));
    } else if (field === "prunable" || field.startsWith("prunable ")) {
      current.prunable = true;
    }
  }
  finish();
  return Object.freeze(records);
}

class RegistryLock {
  #released = false;

  constructor(
    readonly path: string,
    readonly handle: FileHandle,
  ) {}

  async release(): Promise<boolean> {
    if (this.#released) return false;
    this.#released = true;
    let owned = false;
    try {
      const held = await this.handle.stat();
      const current = await lstat(this.path);
      owned = held.isFile() && current.isFile() && !current.isSymbolicLink() &&
        sameIdentity(held.dev, held.ino, current.dev, current.ino);
      if (owned && process.platform !== "win32") await unlink(this.path);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    } finally {
      await this.handle.close();
    }
    if (owned && process.platform === "win32") {
      try {
        await unlink(this.path);
      } catch (error) {
        if (errnoCode(error) !== "ENOENT") throw error;
        return false;
      }
    }
    return owned;
  }
}

export class GitWorktreeManager {
  readonly workspace: string;
  readonly storageDirectory: string;
  readonly #repository: RepositoryIdentity;
  readonly #callerCwd: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #now: () => number;
  readonly #registryPath: string;
  readonly #lockPath: string;
  readonly #treeDirectory: string;
  readonly #hooksDirectory: string;

  private constructor(options: {
    readonly workspace: string;
    readonly storageDirectory: string;
    readonly repository: RepositoryIdentity;
    readonly callerCwd: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly now: () => number;
  }) {
    this.workspace = options.workspace;
    this.storageDirectory = options.storageDirectory;
    this.#repository = options.repository;
    this.#callerCwd = options.callerCwd;
    this.#environment = options.environment;
    this.#now = options.now;
    this.#registryPath = join(this.storageDirectory, "registry.json");
    this.#lockPath = join(this.storageDirectory, "registry.lock");
    this.#treeDirectory = join(this.storageDirectory, "trees");
    this.#hooksDirectory = join(this.storageDirectory, "disabled-hooks");
  }

  static async open(options: GitWorktreeManagerOptions): Promise<GitWorktreeManager> {
    if (
      !isAbsolute(options.storageRoot) ||
      options.storageRoot.includes("\0") ||
      Buffer.byteLength(options.storageRoot, "utf8") > MAX_GIT_PATH_BYTES
    ) {
      throw new ConfigurationError("managed worktree 저장 경로가 올바르지 않습니다.");
    }
    const workspace = await canonicalWorkspace(options.workspace);
    const callerCwd = await canonicalWorkspace(options.callerCwd ?? process.cwd());
    const environment = buildChildEnvironment({
      ...(options.environment === undefined ? {} : { source: options.environment }),
      additions: {
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
        GIT_PAGER: "cat",
        PAGER: "cat",
        LC_ALL: "C",
        LANG: "C",
      },
    });
    const signal = new AbortController().signal;
    const repository = await discoverRepository(workspace, environment, signal);
    const repositoryKey = createHash("sha256")
      .update(repository.commonDirectory, "utf8")
      .update("\0")
      .update(String(repository.device))
      .update("\0")
      .update(String(repository.inode))
      .digest("hex");
    const storageRoot = await resolvePotentialDirectory(options.storageRoot);
    const listed = await runGit(
      workspace,
      ["worktree", "list", "--porcelain", "-z"],
      environment,
      signal,
    );
    for (const worktree of parseWorktreePorcelain(listed.stdout)) {
      if (isInside(worktree.path, storageRoot)) {
        throw new ConfigurationError("managed worktree 저장소는 기존 Git worktree 밖에 있어야 합니다.");
      }
    }
    await mkdir(storageRoot, { recursive: true, mode: 0o700 });
    const canonicalStorageRoot = await realpath(storageRoot);
    if (!samePath(canonicalStorageRoot, storageRoot)) {
      throw new PermissionDeniedError("managed worktree 저장소 canonical 경로가 준비 중 변경되었습니다.");
    }
    const rootInfo = await lstat(storageRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new StorageError("managed worktree 저장소가 실제 디렉터리가 아닙니다.");
    }
    const requestedDirectory = join(canonicalStorageRoot, repositoryKey);
    await mkdir(join(requestedDirectory, "trees"), { recursive: true, mode: 0o700 });
    await mkdir(join(requestedDirectory, "disabled-hooks"), { recursive: true, mode: 0o700 });
    for (const path of [storageRoot, requestedDirectory, join(requestedDirectory, "trees"), join(requestedDirectory, "disabled-hooks")]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new StorageError("managed worktree 내부 경로가 실제 디렉터리가 아닙니다.");
      }
      if (process.platform !== "win32") await chmod(path, 0o700);
    }
    const storageDirectory = await realpath(requestedDirectory);
    return new GitWorktreeManager({
      workspace,
      storageDirectory,
      repository,
      callerCwd,
      environment,
      now: options.now ?? Date.now,
    });
  }

  async list(signal: AbortSignal = new AbortController().signal): Promise<readonly ManagedWorktreeSnapshot[]> {
    await this.#assertRepositoryUnchanged(signal);
    const registry = await this.#readRegistry();
    const records = await this.#gitWorktrees(signal);
    const byPath = new Map(records.map((record) => [this.#pathKey(record.path), record] as const));
    const output: ManagedWorktreeSnapshot[] = [];
    for (const entry of registry.entries) {
      const git = byPath.get(this.#pathKey(entry.path));
      const info = await this.#targetInfo(entry.path);
      const identityMatches = info !== undefined && entry.device !== null && entry.inode !== null &&
        sameIdentity(entry.device, entry.inode, info.dev, info.ino);
      const presence: ManagedWorktreePresence = git
        ? info
          ? "ready"
          : "prunable"
        : info
          ? "orphaned_path"
          : "missing";
      output.push(Object.freeze({
        name: entry.name,
        path: entry.path,
        createdBranch: entry.createdBranch,
        currentBranch: git?.branch ?? null,
        head: git?.head ?? null,
        baseRef: entry.baseRef,
        createdAt: entry.createdAt,
        state: entry.state,
        presence,
        identityMatches,
        locked: git?.locked ?? false,
        lockedReason: git?.lockedReason ?? null,
        prunable: git?.prunable ?? false,
        current: isInside(entry.path, this.workspace) || isInside(entry.path, this.#callerCwd),
      }));
    }
    return Object.freeze(output);
  }

  async current(signal: AbortSignal = new AbortController().signal): Promise<ManagedWorktreeSnapshot | undefined> {
    return (await this.list(signal)).find((entry) => entry.current);
  }

  async create(request: CreateManagedWorktreeRequest = {}): Promise<ManagedWorktreeSnapshot> {
    const signal = request.signal ?? new AbortController().signal;
    const now = this.#now();
    const createdAt = isoTimestamp(now, "worktree 생성");
    const name = request.name === undefined || !request.name.trim()
      ? generatedWorktreeName(now)
      : normalizeWorktreeName(request.name);
    return await this.#withRegistryLock(async () => {
      await this.#assertRepositoryUnchanged(signal);
      const registry = await this.#readRegistry();
      if (registry.entries.some((entry) => entry.name === name)) {
        throw new ConfigurationError(`이미 관리 중인 worktree 이름입니다: ${name}`);
      }
      if (registry.entries.length >= MAX_REGISTRY_ENTRIES) {
        throw new StorageError(`managed worktree는 저장소마다 최대 ${MAX_REGISTRY_ENTRIES}개입니다.`);
      }
      const target = join(this.#treeDirectory, name);
      if (!samePath(resolve(target), target) || !isInside(this.#treeDirectory, target)) {
        throw new PermissionDeniedError("worktree 대상이 관리 경로를 벗어났습니다.");
      }
      if (await this.#targetInfo(target) !== undefined) {
        throw new ConfigurationError(`worktree 경로가 이미 존재합니다: ${target}`);
      }
      const records = await this.#gitWorktrees(signal);
      if (records.some((entry) => samePath(entry.path, target))) {
        throw new ConfigurationError(`Git에 이미 등록된 worktree 경로입니다: ${target}`);
      }
      const branch = `cat/worktree/${name}`;
      const branchCheck = await this.#git(
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        signal,
        [0, 1],
      );
      if (branchCheck.exitCode === 0) {
        throw new ConfigurationError(`worktree branch가 이미 존재합니다: ${branch}`);
      }
      const baseRef = request.baseRef === undefined
        ? await this.#defaultBase(signal)
        : safeRef(request.baseRef, "worktree base");
      await this.#git(["rev-parse", "--verify", `${baseRef}^{commit}`], signal);
      let entries: RegistryEntry[] = [
        ...registry.entries,
        {
          name,
          path: target,
          createdBranch: branch,
          baseRef,
          createdAt,
          state: "creating",
          device: null,
          inode: null,
        },
      ];
      await this.#writeRegistry(entries);
      try {
        await this.#assertRepositoryUnchanged(signal);
        await this.#git(["worktree", "add", "-b", branch, target, baseRef], signal);
        const info = await this.#targetInfo(target);
        if (!info) throw new StorageError("생성된 worktree 디렉터리를 확인할 수 없습니다.");
        const canonical = await realpath(target);
        if (!samePath(canonical, target)) {
          throw new PermissionDeniedError("생성된 worktree가 예상한 canonical 경로와 다릅니다.");
        }
        const current = (await this.#gitWorktrees(signal)).find((entry) => samePath(entry.path, target));
        if (!current || current.bare || current.branch !== branch) {
          throw new StorageError("생성된 worktree의 Git 등록 또는 branch를 확인할 수 없습니다.");
        }
        entries = entries.map((entry) => entry.name === name
          ? { ...entry, state: "active" as const, device: info.dev, inode: info.ino }
          : entry);
        await this.#writeRegistry(entries);
        return Object.freeze({
          name,
          path: target,
          createdBranch: branch,
          currentBranch: current.branch,
          head: current.head,
          baseRef,
          createdAt,
          state: "active",
          presence: "ready",
          identityMatches: true,
          locked: current.locked,
          lockedReason: current.lockedReason,
          prunable: current.prunable,
          current: false,
        });
      } catch (error) {
        const unknown = entries.map((entry) => entry.name === name
          ? { ...entry, state: "unknown" as const }
          : entry);
        try {
          await this.#writeRegistry(unknown);
        } catch (registryError) {
          throw new StorageError("worktree 생성 결과와 registry 상태를 모두 확정하지 못했습니다.", {
            cause: new AggregateError([error, registryError]),
          });
        }
        throw error;
      }
    });
  }

  async remove(
    requestedName: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<RemoveManagedWorktreeResult> {
    const name = normalizeWorktreeName(requestedName);
    return await this.#withRegistryLock(async () => {
      await this.#assertRepositoryUnchanged(signal);
      const registry = await this.#readRegistry();
      const entry = registry.entries.find((candidate) => candidate.name === name);
      if (!entry) throw new ConfigurationError(`관리 중인 worktree를 찾을 수 없습니다: ${name}`);
      if (isInside(entry.path, this.workspace) || isInside(entry.path, this.#callerCwd)) {
        throw new PermissionDeniedError("현재 process의 cwd인 worktree는 스스로 제거할 수 없습니다.");
      }
      const records = await this.#gitWorktrees(signal);
      const git = records.find((candidate) => samePath(candidate.path, entry.path));
      const info = await this.#targetInfo(entry.path);
      if (!git) {
        if (info) {
          throw new PermissionDeniedError(
            "registry 경로에 Git이 관리하지 않는 디렉터리가 있어 자동 삭제하지 않습니다.",
          );
        }
        await this.#writeRegistry(registry.entries.filter((candidate) => candidate.name !== name));
        return Object.freeze({
          name,
          path: entry.path,
          retainedBranch: entry.createdBranch,
          worktreeRemoved: false,
          registryOnly: true,
        });
      }
      if (!info) {
        throw new PermissionDeniedError(
          "Git metadata만 남은 prunable worktree는 자동 prune하지 않습니다.",
        );
      }
      if (entry.device === null || entry.inode === null) {
        throw new PermissionDeniedError(
          "생성 시 filesystem identity를 확정하지 못한 worktree는 자동 제거하지 않습니다.",
        );
      }
      const entryDevice = entry.device;
      const entryInode = entry.inode;
      if (git.bare || git.locked || git.prunable) {
        throw new PermissionDeniedError(
          git.locked
            ? `잠긴 worktree는 제거하지 않습니다${git.lockedReason ? `: ${git.lockedReason}` : "."}`
            : "bare 또는 prunable worktree는 managed remove 대상으로 사용하지 않습니다.",
        );
      }
      const canonical = await realpath(entry.path);
      if (!samePath(canonical, entry.path)) {
        throw new PermissionDeniedError("worktree 제거 대상의 canonical 경로가 변경되었습니다.");
      }
      if (!sameIdentity(entryDevice, entryInode, info.dev, info.ino)) {
        throw new PermissionDeniedError("worktree 제거 대상의 filesystem identity가 변경되었습니다.");
      }
      const dirty = await this.#gitAt(entry.path, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
        "--ignore-submodules=none",
        "--no-renames",
      ], signal);
      if (dirty.stdout.length > 0) {
        throw new PermissionDeniedError(
          "tracked, untracked 또는 ignored 변경이 있는 worktree는 제거하지 않습니다. 파일을 직접 정리한 뒤 다시 시도하세요.",
        );
      }
      await this.#assertRepositoryUnchanged(signal);
      const currentInfo = await this.#targetInfo(entry.path);
      const currentGit = (await this.#gitWorktrees(signal)).find(
        (candidate) => samePath(candidate.path, entry.path),
      );
      if (
        !currentInfo ||
        !currentGit ||
        currentGit.bare ||
        currentGit.locked ||
        currentGit.prunable ||
        !sameIdentity(info.dev, info.ino, currentInfo.dev, currentInfo.ino) ||
        !sameIdentity(entryDevice, entryInode, currentInfo.dev, currentInfo.ino)
      ) {
        throw new PermissionDeniedError("dirty 검사 뒤 worktree identity 또는 Git 상태가 변경되었습니다.");
      }
      let entries: RegistryEntry[] = registry.entries.map((candidate) => candidate.name === name
        ? { ...candidate, state: "removing" as const }
        : candidate);
      await this.#writeRegistry(entries);
      try {
        await this.#git(["worktree", "remove", entry.path], signal);
        if (await this.#targetInfo(entry.path) !== undefined) {
          throw new StorageError("Git 종료 뒤 worktree 디렉터리가 남아 있어 삭제 완료를 확정하지 못했습니다.");
        }
        if ((await this.#gitWorktrees(signal)).some((candidate) => samePath(candidate.path, entry.path))) {
          throw new StorageError("Git 종료 뒤 worktree metadata가 남아 있어 삭제 완료를 확정하지 못했습니다.");
        }
        entries = entries.filter((candidate) => candidate.name !== name);
        await this.#writeRegistry(entries);
        return Object.freeze({
          name,
          path: entry.path,
          retainedBranch: currentGit.branch ?? entry.createdBranch,
          worktreeRemoved: true,
          registryOnly: false,
        });
      } catch (error) {
        const unknown = entries.map((candidate) => candidate.name === name
          ? { ...candidate, state: "unknown" as const }
          : candidate);
        try {
          await this.#writeRegistry(unknown);
        } catch (registryError) {
          throw new StorageError("worktree 제거 결과와 registry 상태를 모두 확정하지 못했습니다.", {
            cause: new AggregateError([error, registryError]),
          });
        }
        throw error;
      }
    });
  }

  async #defaultBase(signal: AbortSignal): Promise<string> {
    const result = await this.#git(
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      signal,
      [0, 1],
    );
    return result.exitCode === 0 ? safeRef(result.stdout.trim(), "origin 기본 branch") : "HEAD";
  }

  async #git(
    args: readonly string[],
    signal: AbortSignal,
    acceptedExitCodes: readonly number[] = [0],
  ): Promise<GitResult> {
    return await runGit(
      this.workspace,
      args,
      this.#environment,
      signal,
      acceptedExitCodes,
      this.#hooksDirectory,
    );
  }

  async #gitAt(
    cwd: string,
    args: readonly string[],
    signal: AbortSignal,
  ): Promise<GitResult> {
    return await runGit(
      cwd,
      args,
      this.#environment,
      signal,
      [0],
      this.#hooksDirectory,
    );
  }

  async #gitWorktrees(signal: AbortSignal): Promise<readonly GitWorktreeRecord[]> {
    const result = await this.#git(["worktree", "list", "--porcelain", "-z"], signal);
    return parseWorktreePorcelain(result.stdout);
  }

  async #assertRepositoryUnchanged(signal: AbortSignal): Promise<void> {
    const current = await discoverRepository(this.workspace, this.#environment, signal);
    if (
      !samePath(current.commonDirectory, this.#repository.commonDirectory) ||
      !sameIdentity(current.device, current.inode, this.#repository.device, this.#repository.inode)
    ) {
      throw new PermissionDeniedError("Git repository identity가 worktree 작업 전에 변경되었습니다.");
    }
  }

  async #targetInfo(path: string): Promise<Stats | undefined> {
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new PermissionDeniedError("managed worktree 대상이 실제 디렉터리가 아닙니다.");
      }
      assertSafeInteger(info.dev, "managed worktree device");
      assertSafeInteger(info.ino, "managed worktree inode");
      return info;
    } catch (error) {
      if (errnoCode(error) === "ENOENT" || errnoCode(error) === "ENOTDIR") return undefined;
      throw error;
    }
  }

  #pathKey(path: string): string {
    return process.platform === "win32" ? path.toLowerCase() : path;
  }

  async #readRegistry(): Promise<WorktreeRegistry> {
    const document = await readJsonObject(this.#registryPath, {
      label: "managed worktree registry",
      maxBytes: MAX_REGISTRY_BYTES,
      maxDepth: 8,
      maxNodes: 4_096,
      requireOwner: true,
      requirePrivateMode: true,
    });
    if (!document) return { repository: this.#repository, entries: Object.freeze([]) };
    if (document.schemaVersion !== REGISTRY_SCHEMA_VERSION || !Array.isArray(document.entries)) {
      throw new StorageError("managed worktree registry schema가 올바르지 않습니다.");
    }
    if (document.entries.length > MAX_REGISTRY_ENTRIES) {
      throw new StorageError("managed worktree registry 항목 수가 상한을 초과했습니다.");
    }
    const repository = repositoryFromJson(document.repository);
    if (
      !samePath(repository.commonDirectory, this.#repository.commonDirectory) ||
      !sameIdentity(repository.device, repository.inode, this.#repository.device, this.#repository.inode)
    ) {
      throw new PermissionDeniedError("managed worktree registry가 다른 Git repository를 가리킵니다.");
    }
    const names = new Set<string>();
    const paths = new Set<string>();
    const entries = document.entries.map((value, index) => {
      const entry = entryFromJson(value, this.storageDirectory, index);
      const key = this.#pathKey(entry.path);
      if (names.has(entry.name) || paths.has(key)) {
        throw new StorageError("managed worktree registry에 중복 이름 또는 경로가 있습니다.");
      }
      names.add(entry.name);
      paths.add(key);
      return entry;
    });
    return { repository, entries: Object.freeze(entries) };
  }

  async #writeRegistry(entries: readonly RegistryEntry[]): Promise<void> {
    if (entries.length > MAX_REGISTRY_ENTRIES) {
      throw new StorageError("managed worktree registry 항목 수가 상한을 초과했습니다.");
    }
    const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name));
    await writeJsonObjectAtomic(
      this.#registryPath,
      registryJson({ repository: this.#repository, entries: sorted }),
      {
        label: "managed worktree registry",
        maxBytes: MAX_REGISTRY_BYTES,
        directoryMode: 0o700,
        fileMode: 0o600,
        requireOwner: true,
      },
    );
  }

  async #acquireRegistryLock(): Promise<RegistryLock> {
    const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
    let handle: FileHandle;
    try {
      handle = await open(
        this.#lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | noFollow,
        0o600,
      );
    } catch (error) {
      if (errnoCode(error) === "EEXIST") {
        throw new StorageError(
          "다른 worktree 관리 작업이 진행 중이거나 이전 lock이 남아 있습니다. PID만 보고 자동 삭제하지 않습니다.",
        );
      }
      throw new StorageError("managed worktree registry lock을 만들지 못했습니다.", { cause: error });
    }
    try {
      const lock = new RegistryLock(this.#lockPath, handle);
      const record = `${JSON.stringify({
        schemaVersion: 1,
        token: randomUUID(),
        pid: process.pid,
        createdAt: isoTimestamp(this.#now(), "worktree registry lock"),
      })}\n`;
      await handle.writeFile(record, "utf8");
      await handle.sync();
      if (process.platform !== "win32") await handle.chmod(0o600);
      return lock;
    } catch (error) {
      const lock = new RegistryLock(this.#lockPath, handle);
      const released = await lock.release().catch((releaseError) => {
        throw new StorageError("registry lock 기록과 안전한 정리가 모두 실패했습니다.", {
          cause: new AggregateError([error, releaseError]),
        });
      });
      if (!released) {
        throw new StorageError("registry lock 기록 실패 뒤 lock 소유권을 확인하지 못했습니다.", {
          cause: error instanceof Error ? error : undefined,
        });
      }
      throw new StorageError("managed worktree registry lock을 기록하지 못했습니다.", { cause: error });
    }
  }

  async #withRegistryLock<Result>(operation: () => Promise<Result>): Promise<Result> {
    const lock = await this.#acquireRegistryLock();
    let outcome:
      | { readonly ok: true; readonly value: Result }
      | { readonly ok: false; readonly error: unknown };
    try {
      outcome = { ok: true, value: await operation() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    let released = false;
    try {
      released = await lock.release();
    } catch (error) {
      if (!outcome.ok) {
        throw new StorageError("worktree 작업과 registry lock 해제가 모두 실패했습니다.", {
          cause: new AggregateError([outcome.error, error]),
        });
      }
      throw new StorageError("worktree 작업 뒤 registry lock을 해제하지 못했습니다.", { cause: error });
    }
    if (!released) {
      if (!outcome.ok) {
        throw new StorageError("worktree 작업 실패 뒤 registry lock 소유권도 확인하지 못했습니다.", {
          cause: outcome.error instanceof Error ? outcome.error : undefined,
        });
      }
      throw new StorageError("worktree 작업 뒤 registry lock 소유권을 확인하지 못했습니다.");
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
}

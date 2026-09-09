import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, relative } from "node:path";
import { ConfigurationError, PermissionDeniedError } from "../core/errors.js";
import type { JsonObject, JsonValue } from "../core/json.js";
import type { ToolExecutionResult } from "../core/tools.js";
import type {
  WorkspacePathGuard,
  WorkspacePathResolution,
} from "../security/workspace-path.js";

export const MAX_WORKSPACE_FILE_BYTES = 1_000_000;
export const MAX_READ_CONTENT_BYTES = 8_000;
export const DEFAULT_TOOL_OUTPUT_BYTES = 64_000;
const MAX_WALK_ENTRIES = 50_000;
const MAX_WALK_FILES = 10_000;

export interface WorkspaceFileContent {
  text: string;
  bytes: Buffer;
  digest: string;
}

export interface WorkspaceFileCandidate {
  displayPath: string;
  absolutePath: string;
  relativeToRoot: string;
  resolution: WorkspacePathResolution;
  directRegularFile: boolean;
}

export interface WalkResult {
  files: readonly WorkspaceFileCandidate[];
  truncated: boolean;
  visitedEntries: number;
}

interface Observation {
  digest: string | undefined;
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class FileObservationStore {
  readonly #sessions = new Map<string, Map<string, Observation>>();

  #session(sessionId: string): Map<string, Observation> {
    let observations = this.#sessions.get(sessionId);
    if (!observations) {
      observations = new Map();
      this.#sessions.set(sessionId, observations);
    }
    return observations;
  }

  observe(sessionId: string, absolutePath: string, digest: string | undefined): void {
    const observations = this.#session(sessionId);
    if (observations.size >= 10_000 && !observations.has(absolutePath)) {
      const oldest = observations.keys().next().value as string | undefined;
      if (oldest) observations.delete(oldest);
    }
    observations.set(absolutePath, { digest });
  }

  expected(sessionId: string, absolutePath: string): string | undefined | null {
    const observation = this.#session(sessionId).get(absolutePath);
    return observation ? observation.digest : null;
  }

  assertUnchanged(sessionId: string, absolutePath: string, currentDigest: string | undefined): void {
    const expected = this.expected(sessionId, absolutePath);
    if (expected !== null && expected !== currentDigest) {
      throw new PermissionDeniedError(
        "마지막으로 확인한 뒤 파일이 변경되었습니다. read_file로 다시 읽고 변경 사항을 반영하세요.",
      );
    }
  }

  clearSession(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }
}

export async function readWorkspaceUtf8File(
  resolution: WorkspacePathResolution,
): Promise<WorkspaceFileContent> {
  if (!resolution.exists || resolution.kind !== "file") {
    throw new ConfigurationError("읽기 대상이 일반 파일이 아닙니다.");
  }
  const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
  const nonBlocking = fsConstants.O_NONBLOCK ?? 0;
  let handle: FileHandle | undefined;
  try {
    handle = await open(resolution.absolutePath, fsConstants.O_RDONLY | noFollow | nonBlocking);
    const initial = await handle.stat();
    if (
      !initial.isFile() ||
      initial.dev !== resolution.device ||
      (process.platform !== "win32" && initial.ino !== resolution.inode)
    ) {
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
    const bytes = Buffer.from(buffer.subarray(0, total));
    if (bytes.includes(0)) throw new ConfigurationError("바이너리 파일은 읽을 수 없습니다.");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new ConfigurationError("UTF-8 텍스트 파일만 읽을 수 있습니다.", { cause: error });
    }
    return { text, bytes, digest: digestBytes(bytes) };
  } catch (error) {
    if (error instanceof ConfigurationError || error instanceof PermissionDeniedError) throw error;
    const code = errnoCode(error);
    throw new ConfigurationError(
      code ? `파일을 읽지 못했습니다(${code}).` : "파일을 읽지 못했습니다.",
      { cause: error },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function splitLines(value: string, keepEnds = false): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let end = index + 1;
    if (code === 0x0d && value.charCodeAt(index + 1) === 0x0a) end += 1;
    else if (![0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029].includes(code)) continue;
    lines.push(value.slice(start, keepEnds ? end : index));
    start = end;
    index = end - 1;
  }
  if (start < value.length) lines.push(value.slice(start));
  return lines;
}

function unicodeCompare(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const difference = (leftPoints[index]?.codePointAt(0) ?? 0) -
      (rightPoints[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

export function globExpression(glob: string): RegExp {
  if (!glob || [...glob].length > 512 || /\p{Cc}/u.test(glob)) {
    throw new ConfigurationError("파일 glob 형식이 올바르지 않습니다.");
  }
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index] ?? "";
    if (character === "*") {
      while (glob[index + 1] === "*") index += 1;
      pattern += ".*";
      continue;
    }
    if (character === "?") {
      pattern += ".";
      continue;
    }
    if (character !== "[") {
      pattern += character.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&");
      continue;
    }
    let end = index + 1;
    if (glob[end] === "!") end += 1;
    if (glob[end] === "]") end += 1;
    while (end < glob.length && glob[end] !== "]") end += 1;
    if (end >= glob.length) {
      pattern += "\\[";
      continue;
    }
    let body = glob.slice(index + 1, end);
    const negated = body.startsWith("!");
    if (negated) body = body.slice(1);
    body = body.replace(/\\/gu, "\\\\").replace(/\^/gu, "\\^");
    pattern += `[${negated ? "^" : ""}${body}]`;
    index = end;
  }
  try {
    return new RegExp(`^${pattern}$`, "u");
  } catch (error) {
    throw new ConfigurationError("파일 glob 정규식이 올바르지 않습니다.", { cause: error });
  }
}

function pathForGuard(workspace: string, absolutePath: string): string {
  return relative(workspace, absolutePath).replaceAll("\\", "/") || ".";
}

function inaccessible(error: unknown): boolean {
  return error instanceof PermissionDeniedError || error instanceof ConfigurationError;
}

export async function walkWorkspaceFiles(
  guard: WorkspacePathGuard,
  root: WorkspacePathResolution,
  glob: string,
  signal: AbortSignal,
  maximumFiles = MAX_WALK_FILES,
): Promise<WalkResult> {
  const expression = glob === "*" ? undefined : globExpression(glob);
  if (root.kind === "file") {
    const name = root.displayPath.split("/").at(-1) ?? root.displayPath;
    if (expression && !expression.test(name)) return { files: [], truncated: false, visitedEntries: 1 };
    return {
      files: [{
        displayPath: root.displayPath,
        absolutePath: root.absolutePath,
        relativeToRoot: name,
        resolution: root,
        directRegularFile: !(await lstat(resolveDisplayPath(guard.workspace, root.displayPath))).isSymbolicLink(),
      }],
      truncated: false,
      visitedEntries: 1,
    };
  }

  const pending: Array<{ absolutePath: string; relativeToRoot: string }> = [
    { absolutePath: root.absolutePath, relativeToRoot: "" },
  ];
  const files: WorkspaceFileCandidate[] = [];
  let visitedEntries = 0;
  let truncated = false;
  while (pending.length > 0) {
    if (signal.aborted) throw new PermissionDeniedError("파일 탐색이 취소되었습니다.");
    const current = pending.shift();
    if (!current) break;
    const directory = await opendir(current.absolutePath);
    const entries = [];
    for await (const entry of directory) entries.push(entry);
    entries.sort((left, right) => unicodeCompare(left.name, right.name));
    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > MAX_WALK_ENTRIES || files.length >= maximumFiles) {
        truncated = true;
        break;
      }
      if (entry.name === ".git") continue;
      const relativeToRoot = current.relativeToRoot
        ? `${current.relativeToRoot}/${entry.name}`
        : entry.name;
      if (
        relativeToRoot === ".cat/worktrees" ||
        relativeToRoot.startsWith(".cat/worktrees/") ||
        relativeToRoot === ".smileserv/worktrees" ||
        relativeToRoot.startsWith(".smileserv/worktrees/")
      ) {
        continue;
      }
      const rawPath = join(current.absolutePath, entry.name);
      const requested = pathForGuard(guard.workspace, rawPath);
      if (entry.isDirectory()) {
        try {
          const resolved = await guard.resolveExisting(requested, "directory");
          if (resolved.absolutePath === rawPath) {
            pending.push({ absolutePath: resolved.absolutePath, relativeToRoot });
          }
        } catch (error) {
          if (!inaccessible(error)) throw error;
        }
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (expression && !expression.test(relativeToRoot)) continue;
      try {
        const resolved = await guard.resolveExisting(requested, "file");
        files.push({
          displayPath: requested,
          absolutePath: resolved.absolutePath,
          relativeToRoot,
          resolution: resolved,
          directRegularFile: entry.isFile(),
        });
      } catch (error) {
        if (!inaccessible(error)) throw error;
      }
    }
    if (truncated) break;
  }
  files.sort((left, right) => unicodeCompare(left.displayPath, right.displayPath));
  return { files, truncated, visitedEntries };
}

function resolveDisplayPath(workspace: string, displayPath: string): string {
  return join(workspace, ...displayPath.split("/"));
}

export function stringArgument(input: JsonObject, name: string): string {
  const value = input[name];
  if (typeof value !== "string") throw new ConfigurationError(`${name} 문자열 인자가 필요합니다.`);
  return value;
}

export function integerArgument(
  input: JsonObject,
  name: string,
  fallback: number,
): number {
  const value = input[name];
  return value === undefined ? fallback : Number(value);
}

export function toolSuccess(
  content: JsonValue,
  truncated = false,
  omittedBytes?: number,
): ToolExecutionResult {
  return {
    status: "success",
    output: {
      content,
      truncated,
      ...(omittedBytes !== undefined ? { omittedBytes } : {}),
    },
  };
}

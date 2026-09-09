import { fileURLToPath } from "node:url";
import { PermissionDeniedError } from "../core/errors.js";
import type { JsonObject, JsonValue } from "../core/json.js";
import type { ToolExecutionContext, ToolExecutionResult } from "../core/index.js";
import { buildChildEnvironment } from "../security/environment.js";
import type {
  WorkspacePathGuard,
  WorkspacePathResolution,
} from "../security/workspace-path.js";
import { captureChildProcess } from "../process/child-process.js";
import {
  DEFAULT_TOOL_OUTPUT_BYTES,
  FileObservationStore,
  MAX_READ_CONTENT_BYTES,
  globExpression,
  integerArgument,
  readWorkspaceUtf8File,
  splitLines,
  stringArgument,
  toolSuccess,
  walkWorkspaceFiles,
  type WorkspaceFileCandidate,
} from "./file-common.js";
import type { ToolPreflightResult } from "./runtime.js";
import { ToolRegistry } from "./runtime.js";

const MAX_RESULTS = 500;
const MAX_SEARCH_PATTERN_CODE_POINTS = 4_096;
const SEARCH_DEADLINE_MS = 30_000;
const SEARCH_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;
const RG_BATCH_FILES = 100;
const RG_BATCH_ARGUMENT_BYTES = 64 * 1024;
const MAX_STRUCTURED_MATCH_BYTES = 40_000;
const MAX_LIST_JSON_BYTES = 48_000;

export interface WorkspaceReadToolOptions {
  guard: WorkspacePathGuard;
  observations?: FileObservationStore;
}

interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
  text_truncated: boolean;
}

interface SearchResult {
  matches: SearchMatch[];
  truncated: boolean;
  limitReason?: string;
  engine: "ripgrep" | "bounded-fallback" | "ripgrep+bounded-fallback";
}

function objectSchema(properties: JsonObject, required: readonly string[]): JsonObject {
  return {
    type: "object",
    properties,
    required: [...required],
    additionalProperties: false,
  };
}

function stringSchema(description: string, maximum = 32_768): JsonObject {
  return { type: "string", description, minLength: 1, maxLength: maximum };
}

function readableScopeTarget(resolved: WorkspacePathResolution): JsonObject {
  return {
    path: resolved.absolutePath,
    kind: resolved.kind,
    device: resolved.device === undefined ? null : String(resolved.device),
    inode: resolved.inode === undefined ? null : String(resolved.inode),
    parent_path: resolved.parentPath,
    parent_device: String(resolved.parentDevice),
    parent_inode: String(resolved.parentInode),
    access: "read",
  };
}

async function pathPreflight(
  guard: WorkspacePathGuard,
  requested: string,
  kind: "file" | "directory" | "file_or_directory",
  summary: string,
): Promise<ToolPreflightResult> {
  const resolved = await guard.resolveExisting(requested, kind);
  return {
    summary,
    approvalScope: {
      kind: "path",
      target: readableScopeTarget(resolved),
    },
  };
}

async function revalidatePath(
  guard: WorkspacePathGuard,
  requested: string,
  kind: "file" | "directory" | "file_or_directory",
  preflight: ToolPreflightResult,
): Promise<void> {
  const resolved = await guard.resolveExisting(requested, kind);
  if (
    JSON.stringify(readableScopeTarget(resolved)) !==
    JSON.stringify(preflight.approvalScope.target)
  ) {
    throw new PermissionDeniedError("승인 또는 검사 뒤 읽기 대상이 변경되었습니다.");
  }
}

function appendCharacterBounded(
  target: string[],
  characters: readonly string[],
  byteBudget: number,
): { usedCharacters: number; usedBytes: number } {
  let usedCharacters = 0;
  let usedBytes = 0;
  for (const character of characters) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + bytes > byteBudget) break;
    target.push(character);
    usedCharacters += 1;
    usedBytes += bytes;
  }
  return { usedCharacters, usedBytes };
}

function boundedRead(
  content: string,
  startLine: number,
  startColumn: number,
  maxLines: number,
): JsonObject {
  const lines = splitLines(content, true);
  if (startLine <= lines.length) {
    const firstLineLength = [...(lines[startLine - 1] ?? "")].length;
    if (startColumn > firstLineLength + 1) {
      throw new Error("start_column이 해당 행의 문자 길이를 초과했습니다.");
    }
  }
  const output: string[] = [];
  let remainingBytes = MAX_READ_CONTENT_BYTES;
  let endLine = startLine - 1;
  let nextLine = startLine;
  let nextColumn = startColumn;
  let partialLine = false;
  let selectedLines = 0;

  for (
    let lineNumber = startLine;
    lineNumber <= lines.length && selectedLines < maxLines;
    lineNumber += 1
  ) {
    if (remainingBytes === 0) break;
    const lineColumn = lineNumber === startLine ? startColumn : 1;
    const characters = [...(lines[lineNumber - 1] ?? "")].slice(lineColumn - 1);
    const appended = appendCharacterBounded(output, characters, remainingBytes);
    remainingBytes -= appended.usedBytes;
    endLine = lineNumber;
    selectedLines += 1;
    if (appended.usedCharacters < characters.length) {
      partialLine = true;
      nextLine = lineNumber;
      nextColumn = lineColumn + appended.usedCharacters;
      break;
    }
    nextLine = lineNumber + 1;
    nextColumn = 1;
  }
  const more = nextLine <= lines.length;
  return {
    start_line: startLine,
    start_column: startColumn,
    end_line: endLine,
    total_lines: lines.length,
    content: output.join(""),
    truncated: more,
    output_truncated: partialLine,
    partial_line: partialLine,
    next_start_line: more ? nextLine : null,
    next_start_column: more ? nextColumn : null,
  };
}

function codePointColumn(line: string, byteOffset: number): number {
  const bytes = Buffer.from(line, "utf8");
  const prefix = new TextDecoder("utf-8").decode(bytes.subarray(0, Math.max(0, byteOffset)));
  return [...prefix].length + 1;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRipgrepOutput(
  output: string,
  displayByAbsolute: ReadonlyMap<string, string>,
  maximum: number,
): { matches: SearchMatch[]; overflow: boolean } {
  const matches: SearchMatch[] = [];
  let overflow = false;
  for (const line of output.split("\n")) {
    if (!line) continue;
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!record(message) || message.type !== "match" || !record(message.data)) continue;
    const data = message.data;
    const pathObject = record(data.path) ? data.path : undefined;
    const linesObject = record(data.lines) ? data.lines : undefined;
    const absolutePath = typeof pathObject?.text === "string" ? pathObject.text : undefined;
    const text = typeof linesObject?.text === "string" ? linesObject.text.replace(/[\r\n]+$/u, "") : undefined;
    const lineNumber = typeof data.line_number === "number" ? data.line_number : undefined;
    const firstSubmatch = Array.isArray(data.submatches) && record(data.submatches[0])
      ? data.submatches[0]
      : undefined;
    const start = typeof firstSubmatch?.start === "number" ? firstSubmatch.start : 0;
    if (!absolutePath || text === undefined || !Number.isSafeInteger(lineNumber)) continue;
    const displayPath = displayByAbsolute.get(absolutePath);
    if (!displayPath) continue;
    if (matches.length >= maximum) {
      overflow = true;
      break;
    }
    matches.push({
      path: displayPath,
      line: Number(lineNumber),
      column: codePointColumn(typeof linesObject?.text === "string" ? linesObject.text : text, start),
      text,
      text_truncated: false,
    });
  }
  return { matches, overflow };
}

function boundStringList(values: readonly string[], maximumBytes: number): {
  values: string[];
  truncated: boolean;
} {
  const selected: string[] = [];
  let bytes = 2;
  for (const value of values) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || bytes + Buffer.byteLength(serialized, "utf8") + 1 > maximumBytes) {
      return { values: selected, truncated: true };
    }
    selected.push(value);
    bytes += Buffer.byteLength(serialized, "utf8") + 1;
  }
  return { values: selected, truncated: false };
}

function boundMatches(values: readonly SearchMatch[]): {
  matches: SearchMatch[];
  truncated: boolean;
} {
  const selected: SearchMatch[] = [];
  let bytes = 2;
  for (const value of values) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || bytes + Buffer.byteLength(serialized, "utf8") + 1 > MAX_STRUCTURED_MATCH_BYTES) {
      return { matches: selected, truncated: true };
    }
    selected.push(value);
    bytes += Buffer.byteLength(serialized, "utf8") + 1;
  }
  return { matches: selected, truncated: false };
}

function rgBatches(files: readonly WorkspaceFileCandidate[]): WorkspaceFileCandidate[][] {
  const batches: WorkspaceFileCandidate[][] = [];
  let batch: WorkspaceFileCandidate[] = [];
  let bytes = 0;
  for (const file of files) {
    const pathBytes = Buffer.byteLength(file.absolutePath, "utf8") + 1;
    if (batch.length > 0 && (batch.length >= RG_BATCH_FILES || bytes + pathBytes > RG_BATCH_ARGUMENT_BYTES)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(file);
    bytes += pathBytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

async function searchWithRipgrep(
  pattern: string,
  files: readonly WorkspaceFileCandidate[],
  maximum: number,
  guard: WorkspacePathGuard,
  context: ToolExecutionContext,
): Promise<SearchResult | undefined> {
  const matches: SearchMatch[] = [];
  let truncated = false;
  let limitReason: string | undefined;
  const deadlineAt = Date.now() + SEARCH_DEADLINE_MS;
  for (const batch of rgBatches(files)) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      truncated = true;
      limitReason = "timed_out";
      break;
    }
    for (const file of batch) {
      await guard.revalidateExisting(file.resolution, "file");
    }
    const displayByAbsolute = new Map<string, string>(
      batch.map((file) => [file.absolutePath, file.displayPath] as const),
    );
    const captured = await captureChildProcess(
      "rg",
      [
        "--json",
        "--line-number",
        "--column",
        "--color=never",
        "--no-config",
        "--no-messages",
        "--max-count",
        String(maximum + 1),
        "--",
        pattern,
        ...batch.map((file) => file.absolutePath),
      ],
      {
        cwd: context.workspace,
        environment: buildChildEnvironment(),
        timeoutMs: remaining,
        maxOutputBytes: SEARCH_PROCESS_OUTPUT_BYTES,
        signal: context.signal,
      },
    );
    if (captured.spawnErrorCode === "ENOENT") return undefined;
    if (captured.spawnErrorMessage) {
      throw new Error(
        captured.spawnErrorCode
          ? `rg 검색 프로세스를 시작하지 못했습니다(${captured.spawnErrorCode}).`
          : "rg 검색 프로세스를 시작하지 못했습니다.",
      );
    }
    if (captured.cancelled) throw new Error("검색이 취소되었습니다.");
    if (captured.exitCode !== 0 && captured.exitCode !== 1 && !captured.timedOut && !captured.outputLimitReached) {
      const detail = captured.stderr.trim().slice(0, 2_000);
      throw new Error(detail ? `검색 정규식 또는 rg 실행이 올바르지 않습니다: ${detail}` : "rg 검색에 실패했습니다.");
    }
    const parsed = parseRipgrepOutput(captured.stdout, displayByAbsolute, maximum - matches.length);
    matches.push(...parsed.matches);
    if (parsed.overflow || captured.outputLimitReached || captured.timedOut) {
      truncated = true;
      limitReason = captured.timedOut
        ? "timed_out"
        : captured.outputLimitReached
          ? "output_bytes"
          : "max_results";
      break;
    }
  }
  return {
    matches,
    truncated,
    ...(limitReason ? { limitReason } : {}),
    engine: "ripgrep",
  };
}

async function searchFallback(
  pattern: string,
  files: readonly WorkspaceFileCandidate[],
  maximum: number,
  guard: WorkspacePathGuard,
  context: ToolExecutionContext,
): Promise<SearchResult> {
  const matches: SearchMatch[] = [];
  let truncated = false;
  let limitReason: string | undefined;
  const deadlineAt = Date.now() + SEARCH_DEADLINE_MS;
  const worker = fileURLToPath(new URL("../process/regex-search-worker.js", import.meta.url));
  for (const batch of rgBatches(files)) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      truncated = true;
      limitReason = "timed_out";
      break;
    }
    for (const file of batch) {
      await guard.revalidateExisting(file.resolution, "file");
    }
    const candidateArguments = batch.flatMap((file) => {
      if (file.resolution.device === undefined || file.resolution.inode === undefined) {
        throw new Error("fallback 검색 파일 identity가 유실되었습니다.");
      }
      return [
        file.absolutePath,
        String(file.resolution.device),
        String(file.resolution.inode),
      ];
    });
    const captured = await captureChildProcess(
      process.execPath,
      [
        worker,
        pattern,
        String(Math.min(501, maximum - matches.length + 1)),
        ...candidateArguments,
      ],
      {
        cwd: context.workspace,
        environment: buildChildEnvironment(),
        timeoutMs: remaining,
        maxOutputBytes: SEARCH_PROCESS_OUTPUT_BYTES,
        signal: context.signal,
      },
    );
    if (captured.spawnErrorMessage) {
      throw new Error(
        captured.spawnErrorCode
          ? `내부 검색 프로세스를 시작하지 못했습니다(${captured.spawnErrorCode}).`
          : "내부 검색 프로세스를 시작하지 못했습니다.",
      );
    }
    if (captured.cancelled) throw new Error("검색이 취소되었습니다.");
    if (captured.exitCode !== 0 && !captured.timedOut && !captured.outputLimitReached) {
      const detail = captured.stderr.trim().slice(0, 2_000);
      throw new Error(detail || "내부 fallback 검색에 실패했습니다.");
    }
    for (const line of captured.stdout.split("\n")) {
      if (!line) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (!record(raw)) continue;
      const path = typeof raw.path === "string" ? raw.path : undefined;
      const file = path ? batch.find((candidate) => candidate.absolutePath === path) : undefined;
      if (
        !file ||
        typeof raw.line !== "number" ||
        typeof raw.column !== "number" ||
        typeof raw.text !== "string"
      ) {
        continue;
      }
      if (matches.length >= maximum) {
        truncated = true;
        limitReason = "max_results";
        break;
      }
      const textTruncated = raw.line_truncated === true;
      matches.push({
        path: file.displayPath,
        line: raw.line,
        column: raw.column,
        text: raw.text,
        text_truncated: textTruncated,
      });
      if (textTruncated) {
        truncated = true;
        limitReason ??= "line_bytes";
      }
    }
    if (truncated || captured.timedOut || captured.outputLimitReached) {
      truncated = true;
      limitReason = captured.timedOut ? "timed_out" : captured.outputLimitReached ? "output_bytes" : limitReason;
      break;
    }
  }
  return {
    matches,
    truncated,
    ...(limitReason ? { limitReason } : {}),
    engine: "bounded-fallback",
  };
}

async function searchFiles(
  pattern: string,
  candidates: readonly WorkspaceFileCandidate[],
  maximum: number,
  guard: WorkspacePathGuard,
  context: ToolExecutionContext,
): Promise<SearchResult> {
  const direct = candidates.filter((file) => file.directRegularFile);
  const indirect = candidates.filter((file) => !file.directRegularFile);
  const ripgrep = direct.length > 0
    ? await searchWithRipgrep(pattern, direct, maximum, guard, context)
    : { matches: [], truncated: false, engine: "ripgrep" as const };
  if (!ripgrep) return await searchFallback(pattern, candidates, maximum, guard, context);
  if (ripgrep.truncated || indirect.length === 0) return ripgrep;
  const fallback = await searchFallback(
    pattern,
    indirect,
    maximum - ripgrep.matches.length,
    guard,
    context,
  );
  return {
    matches: [...ripgrep.matches, ...fallback.matches],
    truncated: fallback.truncated,
    ...(fallback.limitReason ? { limitReason: fallback.limitReason } : {}),
    engine: "ripgrep+bounded-fallback",
  };
}

export function registerWorkspaceReadTools(
  registry: ToolRegistry,
  options: WorkspaceReadToolOptions,
): FileObservationStore {
  const observations = options.observations ?? new FileObservationStore();
  const guard = options.guard;

  registry.register({
    definition: {
      name: "list_files",
      description: "List a bounded set of files inside one workspace directory using a glob.",
      inputSchema: objectSchema(
        {
          path: stringSchema("Workspace-relative directory, usually '.'"),
          glob: stringSchema("File glob such as '*' or '**/*.ts'", 512),
          max_results: { type: "integer", minimum: 1, maximum: MAX_RESULTS },
        },
        ["path", "glob", "max_results"],
      ),
      category: "read",
      permission: { kind: "workspace", access: "read" },
      outputLimitBytes: DEFAULT_TOOL_OUTPUT_BYTES,
      handler: async (input, context) => {
        const requested = stringArgument(input, "path");
        const root = await guard.resolveExisting(requested, "directory");
        const maximum = integerArgument(input, "max_results", MAX_RESULTS);
        const walked = await walkWorkspaceFiles(
          guard,
          root,
          stringArgument(input, "glob"),
          context.signal,
          maximum + 1,
        );
        const overflow = walked.files.length > maximum;
        const listed = boundStringList(
          walked.files.slice(0, maximum).map((file) => file.displayPath),
          MAX_LIST_JSON_BYTES,
        );
        const files = listed.values;
        return toolSuccess(
          {
            path: root.displayPath,
            files,
            count: files.length,
            truncated: walked.truncated || overflow || listed.truncated,
            visited_entries: walked.visitedEntries,
          },
          walked.truncated || overflow || listed.truncated,
        );
      },
    },
    preflight: async (input) => await pathPreflight(
      guard,
      stringArgument(input, "path"),
      "directory",
      `작업공간 파일 목록: ${stringArgument(input, "path")}`,
    ),
    revalidate: async (input, _context, preflight) => await revalidatePath(
      guard,
      stringArgument(input, "path"),
      "directory",
      preflight,
    ),
  });

  registry.register({
    definition: {
      name: "read_file",
      description: "Read a bounded UTF-8 file range and continue long lines with line and character coordinates.",
      inputSchema: objectSchema(
        {
          path: stringSchema("Workspace-relative file path"),
          start_line: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          start_column: {
            type: "integer",
            minimum: 1,
            maximum: Number.MAX_SAFE_INTEGER,
            description: "1-based Unicode character column in the first selected line",
          },
          max_lines: { type: "integer", minimum: 1, maximum: 1_000 },
        },
        ["path", "start_line", "start_column", "max_lines"],
      ),
      category: "read",
      permission: { kind: "workspace", access: "read" },
      outputLimitBytes: DEFAULT_TOOL_OUTPUT_BYTES,
      handler: async (input, context) => {
        const requested = stringArgument(input, "path");
        const resolved = await guard.resolveExisting(requested, "file");
        const file = await readWorkspaceUtf8File(resolved);
        observations.observe(context.sessionId, resolved.absolutePath, file.digest);
        const selected = boundedRead(
          file.text,
          integerArgument(input, "start_line", 1),
          integerArgument(input, "start_column", 1),
          integerArgument(input, "max_lines", 500),
        );
        return toolSuccess(
          {
            path: resolved.displayPath,
            bytes: file.bytes.byteLength,
            ...selected,
          },
          selected.truncated === true,
        );
      },
    },
    preflight: async (input) => await pathPreflight(
      guard,
      stringArgument(input, "path"),
      "file",
      `파일 읽기: ${stringArgument(input, "path")}`,
    ),
    revalidate: async (input, _context, preflight) => await revalidatePath(
      guard,
      stringArgument(input, "path"),
      "file",
      preflight,
    ),
  });

  registry.register({
    definition: {
      name: "search_text",
      description: "Search bounded workspace text with a regular expression and a safe ripgrep fallback.",
      inputSchema: objectSchema(
        {
          pattern: stringSchema("Regular expression to find", MAX_SEARCH_PATTERN_CODE_POINTS),
          path: stringSchema("Workspace-relative file or directory"),
          glob: stringSchema("File glob such as '*.ts' or '*'", 512),
          max_results: { type: "integer", minimum: 1, maximum: MAX_RESULTS },
        },
        ["pattern", "path", "glob", "max_results"],
      ),
      category: "read",
      permission: { kind: "workspace", access: "read" },
      outputLimitBytes: DEFAULT_TOOL_OUTPUT_BYTES,
      handler: async (input, context): Promise<ToolExecutionResult> => {
        const requested = stringArgument(input, "path");
        const root = await guard.resolveExisting(requested, "file_or_directory");
        const glob = stringArgument(input, "glob");
        void globExpression(glob);
        const walked = await walkWorkspaceFiles(guard, root, glob, context.signal);
        const maximum = integerArgument(input, "max_results", MAX_RESULTS);
        const result = await searchFiles(
          stringArgument(input, "pattern"),
          walked.files,
          maximum,
          guard,
          context,
        );
        const bounded = boundMatches(result.matches);
        const truncated = result.truncated || walked.truncated || bounded.truncated;
        const content: JsonObject = {
          path: root.displayPath,
          matches: bounded.matches as unknown as JsonValue,
          count: bounded.matches.length,
          truncated,
          engine: result.engine,
          ...(bounded.truncated
            ? { limit_reason: "output_bytes" }
            : result.limitReason
              ? { limit_reason: result.limitReason }
              : {}),
          ...(walked.truncated ? { candidate_scan_truncated: true } : {}),
        };
        return toolSuccess(content, truncated);
      },
    },
    preflight: async (input) => await pathPreflight(
      guard,
      stringArgument(input, "path"),
      "file_or_directory",
      `텍스트 검색: ${stringArgument(input, "path")}`,
    ),
    revalidate: async (input, _context, preflight) => await revalidatePath(
      guard,
      stringArgument(input, "path"),
      "file_or_directory",
      preflight,
    ),
  });

  return observations;
}

import { open, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ConfigurationError } from "../core/errors.js";
import type { StoragePaths } from "../storage/paths.js";

export const DEFAULT_INSTRUCTION_MAX_BYTES = 32 * 1024;
export const MAX_INSTRUCTION_INCLUDE_DEPTH = 5;
export const MAX_INSTRUCTION_FILES = 32;

const MAX_CONFIGURED_INSTRUCTION_BYTES = 1024 * 1024;
const INSTRUCTION_NAMES = Object.freeze(["AGENTS.override.md", "AGENTS.md"] as const);
const DEFAULT_FALLBACK_NAMES = Object.freeze(["SMILESERV.md", "CAGENT.md"] as const);
const ALLOWED_INCLUDE_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

export type InstructionScope = "global" | "project";

export interface InstructionSource {
  readonly path: string;
  readonly scope: InstructionScope;
  readonly primary: boolean;
}

export interface InstructionNotice {
  readonly code:
    | "duplicate_include"
    | "include_depth"
    | "include_files"
    | "include_missing"
    | "include_outside_scope"
    | "include_type"
    | "include_invalid"
    | "content_truncated";
  readonly message: string;
  readonly source?: string;
}

export interface InstructionSection {
  readonly scope: InstructionScope;
  readonly source: string;
  readonly content: string;
}

export interface LoadedInstructions {
  readonly files: readonly InstructionSource[];
  readonly sections: readonly InstructionSection[];
  readonly content: string;
  readonly notices: readonly InstructionNotice[];
  readonly projectSkipped: boolean;
  readonly truncated: boolean;
}

export interface LoadInstructionsOptions {
  readonly paths: Pick<StoragePaths, "catHome" | "projectRoot" | "workspace">;
  readonly projectTrusted: boolean;
  readonly maxBytes?: number;
  readonly fallbackFilenames?: readonly string[];
}

interface ReadDocument {
  readonly path: string;
  readonly text: string;
  readonly truncated: boolean;
}

interface SelectedDocument extends ReadDocument {
  readonly scope: InstructionScope;
  readonly boundary: string;
}

interface ExpansionState {
  remaining: number;
  truncated: boolean;
  readonly seen: Set<string>;
  readonly files: InstructionSource[];
  readonly notices: InstructionNotice[];
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

function displayPath(path: string, paths: LoadInstructionsOptions["paths"]): string {
  if (isInside(paths.projectRoot, path)) {
    const child = relative(paths.projectRoot, path).split(sep).join("/");
    return child || ".";
  }
  if (isInside(paths.catHome, path)) {
    const child = relative(paths.catHome, path).split(sep).join("/");
    return child ? `$CAT_HOME/${child}` : "$CAT_HOME";
  }
  return path;
}

function normalizedMaximum(value: number | undefined): number {
  const selected = value ?? DEFAULT_INSTRUCTION_MAX_BYTES;
  if (
    !Number.isSafeInteger(selected) ||
    selected < 1_024 ||
    selected > MAX_CONFIGURED_INSTRUCTION_BYTES
  ) {
    throw new ConfigurationError(
      `프로젝트 지침 크기는 1024–${MAX_CONFIGURED_INSTRUCTION_BYTES} bytes 범위여야 합니다.`,
    );
  }
  return selected;
}

function fallbackNames(values: readonly string[] | undefined): readonly string[] {
  const selected = values ?? DEFAULT_FALLBACK_NAMES;
  if (selected.length > 256) {
    throw new ConfigurationError("프로젝트 지침 fallback 파일 이름이 너무 많습니다.");
  }
  const names: string[] = [];
  for (const raw of selected) {
    if (
      typeof raw !== "string" ||
      !raw ||
      basename(raw) !== raw ||
      raw === "." ||
      raw === ".." ||
      raw.includes("/") ||
      raw.includes("\\") ||
      raw.includes("\0") ||
      Buffer.byteLength(raw, "utf8") > 256
    ) {
      throw new ConfigurationError("프로젝트 지침 fallback에는 안전한 파일 이름만 사용할 수 있습니다.");
    }
    if (!(INSTRUCTION_NAMES as readonly string[]).includes(raw) && !names.includes(raw)) {
      names.push(raw);
    }
  }
  return Object.freeze(names);
}

function decodePrefix(bytes: Buffer): string {
  for (let trim = 0; trim <= Math.min(3, bytes.byteLength); trim += 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, bytes.byteLength - trim),
      );
    } catch {
      // A bounded read can stop in the middle of one UTF-8 scalar.
    }
  }
  throw new ConfigurationError("프로젝트 지침 파일이 유효한 UTF-8이 아닙니다.");
}

async function canonicalRoot(path: string, label: string): Promise<string> {
  if (!path || path.includes("\0") || !isAbsolute(path)) {
    throw new ConfigurationError(`${label} 경로가 올바르지 않습니다.`);
  }
  try {
    return await realpath(path);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return resolve(path);
    throw new ConfigurationError(`${label} 경로를 확인할 수 없습니다.`, { cause: error });
  }
}

async function readDocument(
  candidate: string,
  boundary: string,
  maximumBytes: number,
): Promise<ReadDocument | undefined> {
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new ConfigurationError(`프로젝트 지침 경로를 확인할 수 없습니다: ${candidate}`, {
      cause: error,
    });
  }
  if (!isInside(boundary, canonical)) {
    throw new ConfigurationError(`프로젝트 지침 symlink가 허용 범위를 벗어났습니다: ${candidate}`);
  }
  const handle = await open(canonical, "r");
  try {
    const information = await handle.stat();
    if (!information.isFile()) return undefined;
    const readLimit = Math.min(maximumBytes, Math.max(0, Number(information.size)));
    const buffer = Buffer.alloc(readLimit);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const bytes = buffer.subarray(0, offset);
    if (bytes.includes(0)) {
      throw new ConfigurationError(`프로젝트 지침에는 NUL 문자를 포함할 수 없습니다: ${candidate}`);
    }
    const text = decodePrefix(bytes);
    if (!text.trim()) return undefined;
    return Object.freeze({
      path: canonical,
      text,
      truncated: information.size > offset,
    });
  } finally {
    await handle.close();
  }
}

async function firstDocument(
  directory: string,
  boundary: string,
  names: readonly string[],
  maximumBytes: number,
): Promise<ReadDocument | undefined> {
  for (const name of names) {
    const document = await readDocument(join(directory, name), boundary, maximumBytes);
    if (document !== undefined) return document;
  }
  return undefined;
}

function projectDirectories(projectRoot: string, workspace: string): readonly string[] {
  if (!isInside(projectRoot, workspace)) {
    throw new ConfigurationError("Workspace가 project root 밖에 있습니다.");
  }
  const directories: string[] = [];
  let current = workspace;
  while (true) {
    directories.push(current);
    if (current === projectRoot) break;
    const parent = dirname(current);
    if (parent === current || !isInside(projectRoot, parent)) {
      throw new ConfigurationError("프로젝트 지침 탐색이 project root에 도달하지 못했습니다.");
    }
    current = parent;
  }
  return Object.freeze(directories.reverse());
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return value;
  let end = Math.max(0, maximumBytes);
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function addNotice(
  state: ExpansionState,
  notice: InstructionNotice,
): void {
  state.notices.push(Object.freeze(notice));
}

function includeTarget(line: string): string | undefined {
  const match = line.match(/^\s*@([^\s]+)\s*(?:\r\n|\r|\n)?$/u);
  const value = match?.[1]?.replace(/[.,:;!?)\]}\"]+$/u, "");
  return value || undefined;
}

async function expandDocument(
  document: ReadDocument,
  selected: SelectedDocument,
  paths: LoadInstructionsOptions["paths"],
  state: ExpansionState,
  depth: number,
  primary: boolean,
): Promise<string> {
  const source = displayPath(document.path, paths);
  if (state.seen.has(document.path)) {
    addNotice(state, {
      code: "duplicate_include",
      message: `이미 읽은 지침 파일을 다시 포함하지 않았습니다: ${source}`,
      source,
    });
    return "";
  }
  if (state.files.length >= MAX_INSTRUCTION_FILES) {
    state.truncated = true;
    addNotice(state, {
      code: "include_files",
      message: `지침 파일 수가 ${MAX_INSTRUCTION_FILES}개 제한에 도달했습니다.`,
      source,
    });
    return "";
  }
  state.seen.add(document.path);
  state.files.push(Object.freeze({ path: document.path, scope: selected.scope, primary }));
  if (document.truncated) {
    state.truncated = true;
    addNotice(state, {
      code: "content_truncated",
      message: `지침 파일을 전체 byte 제한까지만 읽었습니다: ${source}`,
      source,
    });
  }

  let output = "";
  const lines = document.text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/gu) ?? [];
  for (const line of lines) {
    if (!line || state.remaining <= 0) break;
    const targetText = includeTarget(line);
    if (targetText !== undefined) {
      if (depth >= MAX_INSTRUCTION_INCLUDE_DEPTH) {
        state.truncated = true;
        addNotice(state, {
          code: "include_depth",
          message: `@include 깊이가 ${MAX_INSTRUCTION_INCLUDE_DEPTH}단계 제한에 도달했습니다.`,
          source,
        });
        continue;
      }
      if (targetText.includes("\0") || Buffer.byteLength(targetText, "utf8") > 4_096) {
        addNotice(state, {
          code: "include_invalid",
          message: "형식 또는 크기가 올바르지 않은 @include를 읽지 않았습니다.",
          source,
        });
        continue;
      }
      const candidate = resolve(dirname(document.path), targetText);
      if (!isInside(selected.boundary, candidate)) {
        addNotice(state, {
          code: "include_outside_scope",
          message: `허용 범위 밖의 @include를 읽지 않았습니다: ${targetText}`,
          source,
        });
        continue;
      }
      if (!ALLOWED_INCLUDE_EXTENSIONS.has(extname(candidate).toLowerCase())) {
        addNotice(state, {
          code: "include_type",
          message: `지원하지 않는 @include 파일 형식입니다: ${targetText}`,
          source,
        });
        continue;
      }
      let included: ReadDocument | undefined;
      try {
        included = await readDocument(candidate, selected.boundary, state.remaining);
      } catch (error) {
        if (error instanceof ConfigurationError && error.message.includes("허용 범위")) {
          addNotice(state, {
            code: "include_outside_scope",
            message: `허용 범위 밖의 @include를 읽지 않았습니다: ${targetText}`,
            source,
          });
          continue;
        }
        throw error;
      }
      if (included === undefined) {
        addNotice(state, {
          code: "include_missing",
          message: `읽을 수 있는 @include 파일이 없습니다: ${targetText}`,
          source,
        });
        continue;
      }
      const expanded = await expandDocument(
        included,
        selected,
        paths,
        state,
        depth + 1,
        false,
      );
      output += expanded;
      if (/\r?\n$/u.test(line) && expanded && !/\n$/u.test(expanded) && state.remaining > 0) {
        output += "\n";
        state.remaining -= 1;
      }
      continue;
    }
    const fragment = truncateUtf8(line, state.remaining);
    output += fragment;
    const used = Buffer.byteLength(fragment, "utf8");
    state.remaining -= used;
    if (used < Buffer.byteLength(line, "utf8")) {
      state.truncated = true;
      addNotice(state, {
        code: "content_truncated",
        message: "프로젝트 지침 전체 byte 제한에 도달했습니다.",
        source,
      });
      break;
    }
  }
  return output;
}

function renderSections(sections: readonly InstructionSection[], maximumBytes: number): {
  readonly content: string;
  readonly truncated: boolean;
} {
  const value = sections
    .map((section) =>
      `## ${section.scope === "global" ? "Global" : "Project"} instructions from ${section.source}\n\n${section.content}`
    )
    .join("\n\n");
  const content = truncateUtf8(value, maximumBytes);
  return Object.freeze({
    content,
    truncated: Buffer.byteLength(content, "utf8") < Buffer.byteLength(value, "utf8"),
  });
}

/**
 * Loads user-owned global instructions and, only after explicit workspace trust,
 * one prioritized instruction document per directory from project root to cwd.
 * Returned project text remains untrusted input and never carries permission.
 */
export async function loadInstructions(
  options: LoadInstructionsOptions,
): Promise<LoadedInstructions> {
  if (typeof options.projectTrusted !== "boolean") {
    throw new ConfigurationError("프로젝트 지침의 workspace trust 상태가 필요합니다.");
  }
  const maximumBytes = normalizedMaximum(options.maxBytes);
  const fallbacks = fallbackNames(options.fallbackFilenames);
  const names = Object.freeze([...INSTRUCTION_NAMES, ...fallbacks]);
  const projectRoot = await canonicalRoot(options.paths.projectRoot, "Project root");
  const workspace = await canonicalRoot(options.paths.workspace, "Workspace");
  const catHome = await canonicalRoot(options.paths.catHome, "CAT_HOME");
  if (!isInside(projectRoot, workspace)) {
    throw new ConfigurationError("Workspace가 project root 밖에 있습니다.");
  }

  const selected: SelectedDocument[] = [];
  const global = await firstDocument(catHome, catHome, names, maximumBytes);
  if (global) selected.push(Object.freeze({ ...global, scope: "global", boundary: catHome }));
  if (options.projectTrusted) {
    for (const directory of projectDirectories(projectRoot, workspace)) {
      const document = await firstDocument(directory, projectRoot, names, maximumBytes);
      if (document) {
        selected.push(Object.freeze({
          ...document,
          scope: "project",
          boundary: projectRoot,
        }));
      }
    }
  }

  const state: ExpansionState = {
    remaining: maximumBytes,
    truncated: false,
    seen: new Set(),
    files: [],
    notices: [],
  };
  const sections: InstructionSection[] = [];
  for (const document of selected) {
    if (state.remaining <= 0 || state.files.length >= MAX_INSTRUCTION_FILES) {
      state.truncated = true;
      break;
    }
    const content = await expandDocument(document, document, options.paths, state, 0, true);
    if (!content.trim()) continue;
    sections.push(Object.freeze({
      scope: document.scope,
      source: displayPath(document.path, options.paths),
      content,
    }));
  }
  const rendered = renderSections(sections, maximumBytes);
  if (rendered.truncated && !state.notices.some((notice) => notice.code === "content_truncated")) {
    addNotice(state, {
      code: "content_truncated",
      message: "지침 출처 표기를 포함한 전체 context가 byte 제한에 도달했습니다.",
    });
  }
  return Object.freeze({
    files: Object.freeze([...state.files]),
    sections: Object.freeze([...sections]),
    content: rendered.content,
    notices: Object.freeze([...state.notices]),
    projectSkipped: !options.projectTrusted,
    truncated: state.truncated || rendered.truncated,
  });
}

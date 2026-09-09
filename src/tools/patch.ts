import { ConfigurationError } from "../core/errors.js";
import { splitLines } from "./file-common.js";

const MAX_PATCH_SECTIONS = 32;
const MAX_PATCH_LINES = 100_000;
const MAX_DIFF_BYTES = 32_000;

export interface WorkspacePatchSection {
  format: "custom" | "unified";
  action: "add" | "update" | "delete";
  path: string;
  body: readonly string[];
}

export interface BoundedDiff {
  text: string;
  truncated: boolean;
  omittedBytes: number;
}

interface PatchHunk {
  oldStart?: number;
  oldCount?: number;
  newStart?: number;
  newCount?: number;
  lines: string[];
}

function fail(message: string): never {
  throw new ConfigurationError(message);
}

function patchLines(patch: string): string[] {
  if (patch.includes("\0")) fail("패치에는 NUL 문자를 포함할 수 없습니다.");
  const lines = patch.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  while (lines.at(-1) === "") lines.pop();
  if (lines.length > MAX_PATCH_LINES) fail("패치 행 수 제한을 초과했습니다.");
  if (
    !/^\*\*\* Begin Patch(?: \*\*\*)?$/u.test(lines[0] ?? "") ||
    !/^\*\*\* End Patch(?: \*\*\*)?$/u.test(lines.at(-1) ?? "")
  ) {
    fail("패치는 *** Begin Patch로 시작하고 *** End Patch로 끝나야 합니다.");
  }
  return lines;
}

function cleanUnifiedPath(header: string, prefix: "--- " | "+++ "): string {
  const path = header.slice(prefix.length).split("\t", 1)[0]?.trim() ?? "";
  if (!path) fail("표준 unified diff의 파일 경로가 비어 있습니다.");
  if (path === "/dev/null") return path;
  return path.replace(/^[ab]\//u, "");
}

function parseUnified(lines: readonly string[], first: number): WorkspacePatchSection[] {
  const sections: WorkspacePatchSection[] = [];
  let index = first;
  while (index < lines.length - 1) {
    while (index < lines.length - 1 && !(lines[index] ?? "").trim()) index += 1;
    if (index >= lines.length - 1) break;
    const oldHeader = lines[index] ?? "";
    const newHeader = lines[index + 1] ?? "";
    if (!oldHeader.startsWith("--- ") || !newHeader.startsWith("+++ ")) {
      fail(`표준 unified diff의 ---/+++ 파일 헤더가 필요합니다: ${oldHeader}`);
    }
    const oldPath = cleanUnifiedPath(oldHeader, "--- ");
    const newPath = cleanUnifiedPath(newHeader, "+++ ");
    if (oldPath === "/dev/null" && newPath === "/dev/null") {
      fail("표준 unified diff의 이전 경로와 새 경로가 모두 /dev/null일 수 없습니다.");
    }
    index += 2;
    const body: string[] = [];
    while (
      index < lines.length - 1 &&
      !((lines[index] ?? "").startsWith("--- ") && (lines[index + 1] ?? "").startsWith("+++ "))
    ) {
      const line = lines[index] ?? "";
      if (line !== "\\ No newline at end of file") body.push(line);
      index += 1;
    }
    const action = oldPath === "/dev/null"
      ? "add"
      : newPath === "/dev/null"
        ? "delete"
        : "update";
    const path = action === "delete" ? oldPath : newPath;
    if (action === "update" && oldPath !== newPath) {
      fail("파일 이동 unified diff는 지원하지 않습니다. 삭제와 추가를 사용하세요.");
    }
    if (body.length === 0) fail(`패치에 변경 hunk가 없습니다: ${path}`);
    sections.push({ format: "unified", action, path, body });
    if (sections.length > MAX_PATCH_SECTIONS) fail("한 패치의 파일 수 제한을 초과했습니다.");
  }
  return sections;
}

function parseCustom(lines: readonly string[], first: number): WorkspacePatchSection[] {
  const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/u;
  const sections: WorkspacePatchSection[] = [];
  let index = first;
  while (index < lines.length - 1) {
    while (index < lines.length - 1 && !(lines[index] ?? "").trim()) index += 1;
    if (index >= lines.length - 1) break;
    const match = (lines[index] ?? "").match(header);
    if (!match?.[1] || !match[2]?.trim()) {
      fail(`알 수 없는 패치 파일 헤더입니다: ${lines[index] ?? ""}`);
    }
    index += 1;
    const body: string[] = [];
    while (index < lines.length - 1 && !header.test(lines[index] ?? "")) {
      body.push(lines[index] ?? "");
      index += 1;
    }
    const action = match[1].toLowerCase() as WorkspacePatchSection["action"];
    if (action === "delete" && body.length > 0) {
      fail(`삭제 패치에는 본문을 넣을 수 없습니다: ${match[2].trim()}`);
    }
    sections.push({
      format: "custom",
      action,
      path: match[2].trim(),
      body,
    });
    if (sections.length > MAX_PATCH_SECTIONS) fail("한 패치의 파일 수 제한을 초과했습니다.");
  }
  return sections;
}

export function parseWorkspacePatch(patch: string): WorkspacePatchSection[] {
  const lines = patchLines(patch);
  let first = 1;
  while (first < lines.length - 1 && !(lines[first] ?? "").trim()) first += 1;
  const sections = (lines[first] ?? "").startsWith("*** ")
    ? parseCustom(lines, first)
    : parseUnified(lines, first);
  if (sections.length === 0) fail("패치에 파일 변경이 없습니다.");
  for (const section of sections) validateSectionSyntax(section);
  return sections;
}

function parseHunkHeader(line: string): Omit<PatchHunk, "lines"> | undefined {
  if (line === "@@") return {};
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/u);
  if (!match) return undefined;
  const oldStart = Number(match[1]);
  const oldCount = Number(match[2] ?? "1");
  const newStart = Number(match[3]);
  const newCount = Number(match[4] ?? "1");
  if (
    !Number.isSafeInteger(oldStart) ||
    !Number.isSafeInteger(oldCount) ||
    !Number.isSafeInteger(newStart) ||
    !Number.isSafeInteger(newCount)
  ) {
    fail("패치 hunk의 행 범위가 너무 큽니다.");
  }
  if (
    oldStart < 0 ||
    newStart < 0 ||
    oldCount < 0 ||
    newCount < 0 ||
    (oldCount > 0 && oldStart === 0) ||
    (newCount > 0 && newStart === 0)
  ) {
    fail("패치 hunk의 행 범위가 올바르지 않습니다.");
  }
  return { oldStart, oldCount, newStart, newCount };
}

function hunks(body: readonly string[], path: string, requireHeader: boolean): PatchHunk[] {
  const result: PatchHunk[] = [];
  let current: PatchHunk | undefined;
  for (const line of body) {
    if (line.startsWith("@@")) {
      const header = parseHunkHeader(line) ?? (requireHeader ? undefined : {});
      if (!header) fail(`패치 hunk 헤더가 올바르지 않습니다: ${path}`);
      if (current) result.push(current);
      current = { ...header, lines: [] };
      continue;
    }
    if (requireHeader && !current) {
      fail(`표준 unified diff에는 @@ hunk 헤더가 필요합니다: ${path}`);
    }
    current ??= { lines: [] };
    if (!line || ![" ", "+", "-"].includes(line[0] ?? "")) {
      fail(`패치 행은 공백, +, - 중 하나로 시작해야 합니다: ${path}`);
    }
    current.lines.push(line);
  }
  if (current) result.push(current);
  if (result.length === 0 || result.every((hunk) => hunk.lines.length === 0)) {
    fail(`패치에 변경 내용이 없습니다: ${path}`);
  }
  for (const hunk of result) {
    const oldCount = hunk.lines.filter((line) => line[0] !== "+").length;
    const newCount = hunk.lines.filter((line) => line[0] !== "-").length;
    if (hunk.oldCount !== undefined && hunk.oldCount !== oldCount) {
      fail(`패치 hunk의 이전 행 수가 본문과 일치하지 않습니다: ${path}`);
    }
    if (hunk.newCount !== undefined && hunk.newCount !== newCount) {
      fail(`패치 hunk의 새 행 수가 본문과 일치하지 않습니다: ${path}`);
    }
    if (!hunk.lines.some((line) => line[0] === "+" || line[0] === "-")) {
      fail(`패치 hunk에 실제 변경 행이 없습니다: ${path}`);
    }
  }
  return result;
}

function validateSectionSyntax(section: WorkspacePatchSection): void {
  if (section.action === "delete" && section.format === "custom") return;
  if (section.action === "add" && section.format === "custom") {
    if (section.body.some((line) => !line.startsWith("+"))) {
      fail(`추가 파일의 모든 행은 +로 시작해야 합니다: ${section.path}`);
    }
    return;
  }
  void hunks(section.body, section.path, section.format === "unified");
}

function findHunk(source: readonly string[], needle: readonly string[], start: number): number {
  if (needle.length === 0) return Math.min(Math.max(start, 0), source.length);
  const positions: number[] = [];
  for (let index = 0; index <= source.length - needle.length; index += 1) {
    if (needle.every((line, offset) => source[index + offset] === line)) positions.push(index);
  }
  if (positions.length === 0) return -1;
  const afterCursor = positions.filter((position) => position >= start);
  if (afterCursor.length === 1) return afterCursor[0] ?? -1;
  if (afterCursor.length > 1) return -2;
  return positions.length === 1 ? positions[0] ?? -1 : -2;
}

export function addedFileContent(section: WorkspacePatchSection): string {
  if (section.action !== "add") fail("추가 패치 section이 아닙니다.");
  if (section.format === "custom") {
    return section.body.length > 0
      ? `${section.body.map((line) => line.slice(1)).join("\n")}\n`
      : "";
  }
  return applyPatchToText(section, "");
}

export function applyPatchToText(section: WorkspacePatchSection, original: string): string {
  if (section.action === "add" && section.format === "custom") return addedFileContent(section);
  if (section.action === "delete" && section.format === "custom") return "";
  const source = splitLines(original);
  const trailingNewline = /(?:\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029])$/u.test(original);
  let cursor = 0;
  let offset = 0;
  for (const hunk of hunks(section.body, section.path, section.format === "unified")) {
    const before = hunk.lines.filter((line) => line[0] !== "+").map((line) => line.slice(1));
    const after = hunk.lines.filter((line) => line[0] !== "-").map((line) => line.slice(1));
    const stated = hunk.oldStart === undefined
      ? undefined
      : Math.max(0, hunk.oldStart - (hunk.oldCount === 0 ? 0 : 1) + offset);
    const position = stated !== undefined &&
      stated <= source.length &&
      before.every((line, index) => source[stated + index] === line)
      ? stated
      : findHunk(source, before, cursor);
    if (position === -2) fail(`패치 문맥이 여러 곳과 일치해 적용 대상을 고를 수 없습니다: ${section.path}`);
    if (position < 0) fail(`패치 문맥이 파일과 일치하지 않습니다: ${section.path}`);
    if (position < cursor) fail(`패치 hunk 순서가 앞선 변경과 겹칩니다: ${section.path}`);
    source.splice(position, before.length, ...after);
    cursor = position + after.length;
    offset += after.length - before.length;
  }
  const result = source.join("\n");
  if (!result) return "";
  if (section.action === "add") return `${result}\n`;
  return trailingNewline ? `${result}\n` : result;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function diffRange(start: number, count: number): string {
  if (count === 1) return String(start + 1);
  return `${count === 0 ? start : start + 1},${count}`;
}

export function unifiedDiff(
  path: string,
  before: string,
  after: string,
  created = false,
  deleted = false,
): BoundedDiff {
  if (before === after) {
    if (!created && !deleted) return { text: "", truncated: false, omittedBytes: 0 };
    return {
      text: `--- ${created ? "/dev/null" : `a/${path}`}\n+++ ${deleted ? "/dev/null" : `b/${path}`}\n`,
      truncated: false,
      omittedBytes: 0,
    };
  }
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  ) {
    suffix += 1;
  }
  const contextBefore = Math.min(3, prefix);
  const contextAfter = Math.min(3, suffix);
  const oldStart = prefix - contextBefore;
  const newStart = prefix - contextBefore;
  const oldChangedEnd = oldLines.length - suffix;
  const newChangedEnd = newLines.length - suffix;
  const oldEnd = oldChangedEnd + contextAfter;
  const newEnd = newChangedEnd + contextAfter;
  let output = `--- ${created ? "/dev/null" : `a/${path}`}\n+++ ${deleted ? "/dev/null" : `b/${path}`}\n`;
  output += `@@ -${diffRange(oldStart, oldEnd - oldStart)} +${diffRange(newStart, newEnd - newStart)} @@\n`;
  for (const line of oldLines.slice(oldStart, prefix)) output += ` ${line}\n`;
  for (const line of oldLines.slice(prefix, oldChangedEnd)) output += `-${line}\n`;
  for (const line of newLines.slice(prefix, newChangedEnd)) output += `+${line}\n`;
  for (const line of oldLines.slice(oldChangedEnd, oldEnd)) output += ` ${line}\n`;

  const totalBytes = Buffer.byteLength(output, "utf8");
  if (totalBytes <= MAX_DIFF_BYTES) return { text: output, truncated: false, omittedBytes: 0 };
  const marker = "\n... diff byte 제한으로 일부 내용을 생략했습니다 ...\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const headBytes = Math.max(0, Math.floor((MAX_DIFF_BYTES - markerBytes) / 2));
  const tailBuffer = Buffer.from(output, "utf8");
  const tail = tailBuffer.subarray(Math.max(0, tailBuffer.length - headBytes)).toString("utf8").replace(/^�+/u, "");
  const text = `${utf8Prefix(output, headBytes)}${marker}${tail}`;
  return {
    text,
    truncated: true,
    omittedBytes: Math.max(0, totalBytes - Buffer.byteLength(text, "utf8")),
  };
}

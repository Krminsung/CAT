import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

const MAX_FILE_BYTES = 1_000_000;
const MAX_LINE_OUTPUT_BYTES = 4_000;

function splitLines(value: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let end = index + 1;
    if (code === 0x0d && value.charCodeAt(index + 1) === 0x0a) end += 1;
    else if (![0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029].includes(code)) continue;
    lines.push(value.slice(start, index));
    start = end;
    index = end - 1;
  }
  if (start < value.length) lines.push(value.slice(start));
  return lines;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

async function readText(path: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
    handle = await open(path, fsConstants.O_RDONLY | noFollow | (fsConstants.O_NONBLOCK ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const chunk = await handle.read(buffer, total, buffer.length - total, total);
      if (chunk.bytesRead === 0) break;
      total += chunk.bytesRead;
    }
    const completed = await handle.stat();
    if (
      total > MAX_FILE_BYTES ||
      total !== info.size ||
      completed.size !== info.size ||
      completed.mtimeMs !== info.mtimeMs ||
      completed.ctimeMs !== info.ctimeMs
    ) return undefined;
    const bytes = buffer.subarray(0, total);
    if (bytes.includes(0)) return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const pattern = process.argv[2];
  const maximumText = process.argv[3];
  if (!pattern || !maximumText || !/^\d+$/u.test(maximumText)) {
    process.stderr.write("fallback 검색 인자가 올바르지 않습니다.\n");
    process.exitCode = 2;
    return;
  }
  const maximum = Number(maximumText);
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 501) {
    process.stderr.write("fallback 검색 결과 제한이 올바르지 않습니다.\n");
    process.exitCode = 2;
    return;
  }
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, "u");
  } catch {
    process.stderr.write("fallback 검색 정규식이 올바르지 않습니다.\n");
    process.exitCode = 2;
    return;
  }

  let count = 0;
  for (const path of process.argv.slice(4)) {
    const content = await readText(path);
    if (content === undefined) continue;
    for (const [index, line] of splitLines(content).entries()) {
      expression.lastIndex = 0;
      const match = expression.exec(line);
      if (!match) continue;
      const visibleLine = utf8Prefix(line, MAX_LINE_OUTPUT_BYTES);
      process.stdout.write(`${JSON.stringify({
        path,
        line: index + 1,
        column: [...line.slice(0, match.index)].length + 1,
        text: visibleLine,
        line_truncated: visibleLine !== line,
      })}\n`);
      count += 1;
      if (count >= maximum) return;
    }
  }
}

await main();

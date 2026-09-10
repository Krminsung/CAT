import { stripTerminalSequences } from "@earendil-works/pi-tui";

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const LINE_BREAKS = /[\n\r\u0085\u2028\u2029]+/gu;
const DEFAULT_MAXIMUM_BYTES = 64 * 1024;
const MAXIMUM_OUTPUT_BYTES = 1024 * 1024;
const REDACTION_CONTEXT_BYTES = 16 * 1024;
const MAXIMUM_INPUT_BYTES = MAXIMUM_OUTPUT_BYTES + REDACTION_CONTEXT_BYTES;
const TRUNCATION_MARKER = "… [잘림]";

export interface TerminalTextRedactor {
  redact(text: string): string;
}

export interface SanitizeTerminalTextOptions {
  readonly maximumBytes?: number;
  readonly redactor?: TerminalTextRedactor;
  readonly singleLine?: boolean;
}

export interface SanitizedTerminalText {
  readonly text: string;
  readonly truncated: boolean;
}

function strippedTerminalText(value: string): string {
  let stripped: string;
  try {
    stripped = stripTerminalSequences(value);
  } catch {
    stripped = "[터미널 텍스트 정리 실패]";
  }
  return stripped
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\t", "    ")
    .replace(CONTROL_CHARACTERS, "");
}

function normalizeMaximumBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAXIMUM_BYTES;
  if (!Number.isSafeInteger(value) || value < 1) return DEFAULT_MAXIMUM_BYTES;
  return Math.min(value, MAXIMUM_OUTPUT_BYTES);
}

function utf8Prefix(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function boundedText(
  value: string,
  maximumBytes: number,
  forceMarker: boolean,
): SanitizedTerminalText {
  const valueBytes = Buffer.byteLength(value, "utf8");
  if (!forceMarker && valueBytes <= maximumBytes) {
    return { text: value, truncated: false };
  }
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  if (maximumBytes <= markerBytes) {
    return { text: utf8Prefix(TRUNCATION_MARKER, maximumBytes), truncated: true };
  }
  return {
    text: `${utf8Prefix(value, maximumBytes - markerBytes)}${TRUNCATION_MARKER}`,
    truncated: true,
  };
}

export function sanitizeTerminalText(
  value: string,
  options: SanitizeTerminalTextOptions = {},
): SanitizedTerminalText {
  const maximumBytes = normalizeMaximumBytes(options.maximumBytes);
  const sourceLimit = Math.min(
    MAXIMUM_INPUT_BYTES,
    maximumBytes + REDACTION_CONTEXT_BYTES,
  );
  const raw = utf8Prefix(value, sourceLimit);
  const rawWasTruncated = Buffer.byteLength(value, "utf8") > sourceLimit;
  const stripped = strippedTerminalText(raw);
  const normalized = rawWasTruncated
    ? utf8Prefix(
        stripped,
        Math.max(0, Buffer.byteLength(stripped, "utf8") - REDACTION_CONTEXT_BYTES),
      )
    : stripped;

  let redacted: string;
  try {
    redacted = options.redactor?.redact(normalized) ?? normalized;
  } catch {
    redacted = "[표시할 수 없는 텍스트]";
  }

  const safeRedacted = strippedTerminalText(redacted);
  const display = options.singleLine === true
    ? safeRedacted.replace(LINE_BREAKS, " ")
    : safeRedacted;
  return boundedText(display, maximumBytes, rawWasTruncated);
}

export function safeTerminalText(
  value: string,
  options: SanitizeTerminalTextOptions = {},
): string {
  return sanitizeTerminalText(value, options).text;
}

export function safeTerminalLine(
  value: string,
  options: Omit<SanitizeTerminalTextOptions, "singleLine"> = {},
): string {
  return safeTerminalText(value, { ...options, singleLine: true });
}

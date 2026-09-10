import {
  CURSOR_MARKER,
  Text,
  decodeKittyPrintable,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { safeTerminalLine, safeTerminalText, type TerminalTextRedactor } from "./terminal-text.js";

const BRACKETED_PASTE_START = "\u001B[200~";
const BRACKETED_PASTE_END = "\u001B[201~";
export const MAX_SECRET_INPUT_BYTES = 8 * 1024;
export const MIN_SECRET_INPUT_BYTES = 8;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface SecretInputPanelOptions {
  readonly label: string;
  readonly message?: string;
  readonly redactor: TerminalTextRedactor;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function normalizedSecretFragment(value: string, maximumBytes: number): string {
  const bounded = utf8Prefix(value, MAX_SECRET_INPUT_BYTES * 2);
  const withoutPasteMarkers = bounded
    .replaceAll(BRACKETED_PASTE_START, "")
    .replaceAll(BRACKETED_PASTE_END, "");
  let stripped: string;
  try {
    stripped = stripTerminalSequences(withoutPasteMarkers);
  } catch {
    return "";
  }
  const printable = stripped
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, "");
  return utf8Prefix(printable, maximumBytes);
}

function removeLastGrapheme(value: string): string {
  const segments = [...graphemeSegmenter.segment(value)];
  return segments.length > 0 ? value.slice(0, segments.at(-1)?.index ?? 0) : "";
}

function graphemeCount(value: string): number {
  let count = 0;
  for (const _segment of graphemeSegmenter.segment(value)) count += 1;
  return count;
}

export class SecretInputPanel implements Component, Focusable {
  readonly #label: string;
  readonly #message: Text | undefined;
  #value = "";
  #disabled = false;

  focused = false;
  onSubmit: ((value: string) => void) | undefined;
  onCancel: (() => void) | undefined;
  onChange: (() => void) | undefined;
  onInvalid: ((message: string) => void) | undefined;

  constructor(options: SecretInputPanelOptions) {
    this.#label = safeTerminalLine(options.label, {
      maximumBytes: 2 * 1024,
      redactor: options.redactor,
    });
    const message = options.message === undefined
      ? ""
      : safeTerminalText(options.message, {
          maximumBytes: 8 * 1024,
          redactor: options.redactor,
        });
    this.#message = message ? new Text(message, 0, 0) : undefined;
  }

  get byteLength(): number {
    return Buffer.byteLength(this.#value, "utf8");
  }

  handleInput(data: string): void {
    if (this.#disabled) return;
    if (matchesKey(data, "enter")) {
      if (!this.#value) return;
      if (this.byteLength < MIN_SECRET_INPUT_BYTES) {
        this.onInvalid?.(`비밀값은 최소 ${MIN_SECRET_INPUT_BYTES} bytes여야 합니다.`);
        return;
      }
      const secret = this.#value;
      this.#value = "";
      this.#disabled = true;
      this.onChange?.();
      this.onSubmit?.(secret);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.#disabled = true;
      this.clear();
      this.onCancel?.();
      return;
    }
    if (matchesKey(data, "ctrl+d") && !this.#value) {
      this.#disabled = true;
      this.onCancel?.();
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.#value = removeLastGrapheme(this.#value);
      this.onChange?.();
      return;
    }
    if (matchesKey(data, "ctrl+u")) {
      this.clear();
      return;
    }

    const decoded = decodeKittyPrintable(data);
    const candidate = decoded ?? (data.charCodeAt(0) >= 32 || data.includes(BRACKETED_PASTE_START)
      ? data
      : "");
    if (!candidate) return;
    const remaining = Math.max(0, MAX_SECRET_INPUT_BYTES - this.byteLength);
    const fragment = normalizedSecretFragment(candidate, remaining);
    if (!fragment) return;
    this.#value += fragment;
    this.onChange?.();
  }

  handleMouse(_event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return { handled: true, focus: true };
  }

  invalidate(): void {
    this.#message?.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(1_000, Math.floor(width)));
    const lines = [...(this.#message?.render(safeWidth) ?? [])];
    const prefix = truncateToWidth(`🔒 ${this.#label}: `, safeWidth, "…");
    const available = Math.max(0, safeWidth - visibleWidth(prefix));
    const total = graphemeCount(this.#value);
    const visibleSecrets = Math.max(0, available - (total > available ? 1 : 0));
    const mask = total > available
      ? `…${"•".repeat(visibleSecrets)}`
      : "•".repeat(Math.min(total, available));
    lines.push(`${prefix}${mask}${this.focused ? CURSOR_MARKER : ""}`);
    lines.push(truncateToWidth("Enter로 저장 · Esc 또는 Ctrl+C로 취소", safeWidth, "…"));
    return lines;
  }

  clear(): void {
    this.#value = "";
    this.onChange?.();
  }

  dispose(): void {
    this.#disabled = true;
    this.#value = "";
    this.onSubmit = undefined;
    this.onCancel = undefined;
    this.onChange = undefined;
    this.onInvalid = undefined;
  }
}

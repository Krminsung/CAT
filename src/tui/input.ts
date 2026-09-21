import {
  Editor,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type EditorOptions,
  type EditorTheme,
  type TUI,
  type TuiInputListener,
  type TuiInputListenerResult,
} from "@earendil-works/pi-tui";

import type { PermissionMode } from "../security/permissions.js";
import { sanitizeTerminalText } from "./terminal-text.js";

const BRACKETED_PASTE_START = "\u001B[200~";
const BRACKETED_PASTE_END = "\u001B[201~";
const MAX_INPUT_EVENT_BYTES = 64 * 1024;
export const MAX_EDITOR_INPUT_BYTES = 512 * 1024;
const MAX_HISTORY_ENTRIES = 100;
const MAX_HISTORY_BYTES = 256 * 1024;
const PERMISSION_MODES = new Set<PermissionMode>(["ask", "auto-edit", "full-auto", "plan"]);

const PERMISSION_LABELS: Readonly<Record<PermissionMode, string>> = {
  ask: "요청마다 확인",
  "auto-edit": "파일 변경 자동",
  "full-auto": "전체 자동",
  plan: "계획 전용",
};

export interface TerminalInputActions {
  readonly submit: (text: string) => Promise<void>;
  readonly cancelRun: () => void | Promise<void>;
  readonly changePermissionMode: (current: PermissionMode) => PermissionMode;
  readonly showDetails: () => void | Promise<void>;
  readonly showSessions: () => void | Promise<void>;
  readonly exit?: () => void;
}

export interface TerminalInputConfiguration extends TerminalInputActions {
  readonly initialPermissionMode?: PermissionMode;
  readonly initialHistory?: readonly string[];
}

export interface TerminalInputHost {
  readonly editor: BoundedEditor;
  addInputListener(listener: TuiInputListener): () => void;
  close(): void;
  notice(message: string): void;
  render(): void;
  reportFailure(error: unknown): void;
  busyChanged?(busy: boolean): void;
  cancellationRequested?(): void;
}

interface BoundedInputEvent {
  readonly data?: string;
  readonly truncated: boolean;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function boundedEditableText(value: string, maximumBytes: number): string {
  return utf8Prefix(
    value
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n")
      .replaceAll("\t", "    ")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, ""),
    maximumBytes,
  );
}

function sanitizedPasteText(
  value: string,
  maximumBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  const raw = utf8Prefix(value, MAX_EDITOR_INPUT_BYTES * 2);
  const rawWasTruncated = raw !== value;
  let stripped: string;
  try {
    stripped = stripTerminalSequences(raw);
  } catch {
    return { text: "", truncated: true };
  }
  const normalized = stripped
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\t", "    ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "");
  const text = utf8Prefix(normalized, maximumBytes);
  return { text, truncated: rawWasTruncated || text !== normalized };
}

function boundInputEvent(data: string, availableBytes: number): BoundedInputEvent {
  const pasteStart = data.indexOf(BRACKETED_PASTE_START);
  if (pasteStart >= 0) {
    const contentStart = pasteStart + BRACKETED_PASTE_START.length;
    const pasteEnd = data.indexOf(BRACKETED_PASTE_END, contentStart);
    if (pasteEnd < 0 || availableBytes <= 0) return { truncated: true };
    const content = data.slice(contentStart, pasteEnd);
    const sanitized = sanitizedPasteText(
      content,
      Math.min(availableBytes, MAX_EDITOR_INPUT_BYTES),
    );
    return {
      data: `${BRACKETED_PASTE_START}${sanitized.text}${BRACKETED_PASTE_END}`,
      truncated: sanitized.truncated || pasteStart > 0 || pasteEnd + BRACKETED_PASTE_END.length < data.length,
    };
  }
  if (Buffer.byteLength(data, "utf8") > MAX_INPUT_EVENT_BYTES) {
    return { truncated: true };
  }
  return { data, truncated: false };
}

export class BoundedEditor extends Editor {
  constructor(
    tui: TUI,
    theme: EditorTheme,
    options: EditorOptions | undefined,
    private readonly limitReached: () => void,
  ) {
    super(tui, theme, options);
  }

  override render(width: number): string[] {
    const rows = super.render(width);
    if (rows[0] && /^─+$/u.test(stripTerminalSequences(rows[0]))) {
      const label = truncateToWidth(this.disableSubmit ? "── 작업 진행 중 " : "── 나의 입력 ", width, "");
      rows[0] = label + "─".repeat(Math.max(0, width - visibleWidth(label)));
    }
    return rows;
  }

  override handleInput(data: string): void {
    const before = this.getExpandedText();
    const beforeBytes = Buffer.byteLength(before, "utf8");
    const bounded = boundInputEvent(data, MAX_EDITOR_INPUT_BYTES - beforeBytes);
    if (bounded.data === undefined) {
      this.limitReached();
      return;
    }
    super.handleInput(bounded.data);
    if (bounded.truncated) this.limitReached();
    if (Buffer.byteLength(this.getExpandedText(), "utf8") > MAX_EDITOR_INPUT_BYTES) {
      super.setText(before);
      this.limitReached();
    }
  }

  override setText(text: string): void {
    const bounded = boundedEditableText(text, MAX_EDITOR_INPUT_BYTES);
    super.setText(bounded);
    if (bounded !== text) this.limitReached();
  }

  override insertTextAtCursor(text: string): void {
    const before = this.getExpandedText();
    const remaining = Math.max(0, MAX_EDITOR_INPUT_BYTES - Buffer.byteLength(before, "utf8"));
    const bounded = boundedEditableText(text, remaining);
    if (bounded) super.insertTextAtCursor(bounded);
    if (bounded !== text) this.limitReached();
  }
}

function normalizedHistoryEntry(value: string): string | undefined {
  const sanitized = sanitizeTerminalText(value, { maximumBytes: MAX_EDITOR_INPUT_BYTES });
  const text = sanitized.text.trim();
  return text ? text : undefined;
}

export class TerminalInputController {
  readonly #host: TerminalInputHost;
  readonly #actions: TerminalInputActions;
  readonly #removeInputListener: () => void;
  readonly #history: string[] = [];

  #historyBytes = 0;
  #permissionMode: PermissionMode;
  #busy = false;
  #cancelRequested = false;
  #modalInput = false;
  #disposed = false;

  constructor(host: TerminalInputHost, configuration: TerminalInputConfiguration) {
    this.#host = host;
    this.#actions = configuration;
    const initialPermissionMode = configuration.initialPermissionMode ?? "ask";
    if (!PERMISSION_MODES.has(initialPermissionMode)) {
      throw new Error("초기 권한 모드가 올바르지 않습니다.");
    }
    this.#permissionMode = initialPermissionMode;
    for (const entry of configuration.initialHistory?.slice(-MAX_HISTORY_ENTRIES) ?? []) {
      this.#remember(entry);
    }
    this.#host.editor.onSubmit = (text) => this.#acceptSubmission(text);
    this.#host.editor.disableSubmit = false;
    const listener: TuiInputListener = (data) => this.#handleGlobalInput(data);
    this.#removeInputListener = this.#host.addInputListener(listener);
  }

  get busy(): boolean {
    return this.#busy;
  }

  get permissionMode(): PermissionMode {
    return this.#permissionMode;
  }

  setBusy(busy: boolean): void {
    if (this.#disposed) return;
    this.#busy = busy;
    if (!busy) this.#cancelRequested = false;
    this.#host.editor.disableSubmit = busy;
    this.#host.busyChanged?.(busy);
    this.#host.render();
  }

  setPermissionMode(mode: PermissionMode): void {
    if (this.#disposed || !PERMISSION_MODES.has(mode)) return;
    this.#permissionMode = mode;
    this.#host.notice(`권한 모드: ${PERMISSION_LABELS[mode]}`);
  }

  setModalInput(active: boolean): void {
    if (this.#disposed) return;
    this.#modalInput = active;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#removeInputListener();
    delete this.#host.editor.onSubmit;
    this.#host.editor.disableSubmit = true;
    this.#history.length = 0;
    this.#historyBytes = 0;
  }

  #handleGlobalInput(data: string): TuiInputListenerResult {
    if (this.#disposed || this.#modalInput) return undefined;
    if (matchesKey(data, "ctrl+c")) {
      if (this.#busy) {
        this.#requestCancellation();
      } else {
        this.#host.editor.setText("");
        this.#host.notice("입력을 지웠습니다. 빈 입력에서 Ctrl+D 또는 /exit로 종료합니다.");
      }
      return { consume: true };
    }
    if (this.#busy) return { consume: true };

    if (matchesKey(data, "shift+tab") || matchesKey(data, "alt+m")) {
      try {
        const next = this.#actions.changePermissionMode(this.#permissionMode);
        if (!PERMISSION_MODES.has(next)) throw new Error("권한 전환 결과가 올바르지 않습니다.");
        this.#permissionMode = next;
        this.#host.notice(`권한 모드: ${PERMISSION_LABELS[next]}`);
      } catch (error) {
        this.#host.reportFailure(error);
      }
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+o")) {
      this.#runAction(this.#actions.showDetails);
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+p")) {
      this.#runAction(this.#actions.showSessions);
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+d") && this.#host.editor.getExpandedText().length === 0) {
      try {
        this.#actions.exit?.();
        this.#host.close();
      } catch (error) {
        this.#host.reportFailure(error);
      }
      return { consume: true };
    }

    const bounded = boundInputEvent(
      data,
      MAX_EDITOR_INPUT_BYTES - Buffer.byteLength(this.#host.editor.getExpandedText(), "utf8"),
    );
    if (bounded.data === undefined) {
      this.#host.notice(`입력은 최대 ${MAX_EDITOR_INPUT_BYTES} bytes까지 허용됩니다.`);
      return { consume: true };
    }
    if (bounded.truncated) {
      this.#host.notice(`붙여넣기를 ${MAX_EDITOR_INPUT_BYTES} bytes 입력 제한에 맞춰 줄였습니다.`);
    }
    return bounded.data === data ? undefined : { data: bounded.data };
  }

  #acceptSubmission(text: string): void {
    if (this.#disposed || this.#busy) return;
    const normalized = normalizedHistoryEntry(text);
    if (!normalized) return;
    this.#remember(normalized);
    this.setBusy(true);
    void this.#runSubmission(normalized);
  }

  async #runSubmission(text: string): Promise<void> {
    try {
      await this.#actions.submit(text);
    } catch (error) {
      if (!this.#disposed) this.#host.reportFailure(error);
    } finally {
      if (!this.#disposed) this.setBusy(false);
    }
  }

  #requestCancellation(): void {
    if (this.#cancelRequested) return;
    this.#cancelRequested = true;
    this.#host.cancellationRequested?.();
    this.#host.notice("현재 요청을 취소하는 중입니다.");
    this.#runAction(this.#actions.cancelRun);
  }

  #runAction(action: () => void | Promise<void>): void {
    try {
      const result = action();
      if (result) {
        void result.catch((error: unknown) => {
          if (!this.#disposed) this.#host.reportFailure(error);
        });
      }
    } catch (error) {
      this.#host.reportFailure(error);
    }
  }

  #remember(value: string): void {
    const normalized = normalizedHistoryEntry(value);
    if (!normalized || this.#history.at(-1) === normalized) return;
    const bytes = Buffer.byteLength(normalized, "utf8");
    if (
      this.#history.length >= MAX_HISTORY_ENTRIES ||
      this.#historyBytes + bytes > MAX_HISTORY_BYTES
    ) return;
    this.#history.push(normalized);
    this.#historyBytes += bytes;
    this.#host.editor.addToHistory(normalized);
  }
}

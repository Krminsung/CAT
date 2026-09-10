import {
  Container,
  CURSOR_MARKER,
  ProcessTerminal,
  ScrollView,
  SelectList,
  Text,
  TuiAltScreen,
  VStack,
  truncateToWidth,
  type Component,
  type EditorTheme,
  type Focusable,
  type OverlayHandle,
  type SelectItem,
  type Terminal,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  type TuiStopOptions,
} from "@earendil-works/pi-tui";

import { LocalClipboardWriter } from "../clipboard/local.js";
import {
  MAX_CLIPBOARD_TEXT_BYTES,
  type ClipboardWriteOrigin,
  type ClipboardWriteResult,
  type ClipboardWriter,
} from "../clipboard/types.js";
import { CancelledError } from "../core/errors.js";
import type { AgentEvent } from "../core/events.js";
import { PRODUCT_NAME, VERSION } from "../core/version.js";
import { Redactor } from "../security/redaction.js";
import type { StoredTranscriptRecord } from "../storage/sessions.js";
import {
  BoundedEditor,
  TerminalInputController,
  type TerminalInputConfiguration,
  type TerminalInputHost,
} from "./input.js";
import {
  MAX_RAW_TRANSCRIPT_BYTES,
  RawTranscriptView,
  type RawTranscriptExitReason,
} from "./raw-view.js";
import { SecretInputPanel } from "./secret-input.js";
import {
  safeTerminalLine,
  sanitizeTerminalText,
  type TerminalTextRedactor,
} from "./terminal-text.js";
import {
  TerminalTranscript,
  type RawTranscriptSnapshot,
  type ResumeTranscriptDisplay,
} from "./transcript.js";

const DISABLE_MOUSE_REPORTING =
  "\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1004l\u001B[?1006l\u001B[?1015l";
const EMERGENCY_TERMINAL_RESTORE =
  "\u001B[?2026l\u001B[?2004l\u001B[?1007l" +
  `${DISABLE_MOUSE_REPORTING}\u001B[?7h\u001B[?1049l\u001B[0m\u001B[?25h`;
const MAX_RENDER_COLUMNS = 1_000;
const MAX_RENDERED_LINE_BYTES = 64 * 1024;
const MAX_COMPONENT_ROWS = 8_192;
const MAX_CONFIGURED_SECRETS = 64;
const MAX_CONFIGURED_SECRET_BYTES = 256 * 1024;
const MAX_CONFIGURED_SECRET_ENTRY_BYTES = 16 * 1024;
const MAX_REGISTERED_SECRETS = 32;
const MAX_REGISTERED_SECRET_BYTES = 256 * 1024;
const MAX_SELECTION_OPTIONS = 128;
const MAX_SELECTION_BYTES = 256 * 1024;
const MAX_SELECTION_VALUE_BYTES = 512;
const MAX_SELECTION_LABEL_BYTES = 2 * 1024;
const MAX_SELECTION_DESCRIPTION_BYTES = 8 * 1024;
const MAX_SELECTION_TITLE_BYTES = 2 * 1024;
const MAX_SELECTION_MESSAGE_BYTES = 16 * 1024;

const plainStyle = (text: string): string => text;

const EDITOR_THEME: EditorTheme = {
  borderColor: plainStyle,
  selectList: {
    selectedPrefix: plainStyle,
    selectedText: plainStyle,
    description: plainStyle,
    scrollInfo: plainStyle,
    noMatch: plainStyle,
  },
};

export interface TerminalTtyState {
  readonly stdin: boolean;
  readonly stdout: boolean;
  readonly stderr: boolean;
}

export interface TerminalDiagnosticWriter {
  write(text: string): unknown;
}

export type TerminalScreenErrorCode =
  | "interactive_tty_required"
  | "screen_start_failed"
  | "screen_component_failed"
  | "screen_application_failed"
  | "screen_restore_failed";

export class TerminalScreenError extends Error {
  override name = "TerminalScreenError";

  constructor(
    readonly code: TerminalScreenErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type TerminalScreenState = "idle" | "starting" | "running" | "stopping" | "stopped";

export interface TerminalScreenExit {
  readonly reason: "closed" | "failure";
  readonly error?: TerminalScreenError;
}

export interface CatTerminalScreenOptions {
  readonly model: string;
  readonly workspace: string;
  readonly sessionId: string;
  readonly status?: string;
  readonly terminal?: Terminal;
  readonly tty?: TerminalTtyState;
  readonly diagnostics?: TerminalDiagnosticWriter;
  readonly redactor?: TerminalTextRedactor;
  readonly secrets?: readonly string[];
  readonly clipboard?: ClipboardWriter;
}

interface ActiveModal {
  cancel(error: Error): void;
}

export interface SecretPromptOptions {
  readonly label: string;
  readonly message?: string;
  readonly signal?: AbortSignal;
}

export interface TerminalSelectionOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface TerminalSelectionOptions {
  readonly title: string;
  readonly message?: string;
  readonly options: readonly TerminalSelectionOption[];
  readonly signal?: AbortSignal;
}

export interface TerminalInformationOptions {
  readonly title: string;
  readonly message: string;
  readonly signal?: AbortSignal;
}

type ComponentFailureHandler = (
  operation: "render" | "input" | "mouse" | "invalidate",
  label: string,
  error: unknown,
) => void;

export function detectTerminalTtyState(): TerminalTtyState {
  return {
    stdin: process.stdin.isTTY === true,
    stdout: process.stdout.isTTY === true,
    stderr: process.stderr.isTTY === true,
  };
}

function normalizedRenderWidth(width: number): number {
  if (!Number.isFinite(width)) return 1;
  return Math.max(1, Math.min(MAX_RENDER_COLUMNS, Math.floor(width)));
}

function selectionText(
  value: string,
  label: string,
  maximumBytes: number,
  redactor: TerminalTextRedactor,
  multiline: boolean,
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new TerminalScreenError(
      "screen_application_failed",
      `${label}의 형식 또는 크기가 올바르지 않습니다.`,
    );
  }
  const safe = multiline
    ? sanitizeTerminalText(value, { maximumBytes, redactor }).text.trim()
    : safeTerminalLine(value, { maximumBytes, redactor }).trim();
  if (!safe) {
    throw new TerminalScreenError(
      "screen_application_failed",
      `${label}에 표시 가능한 문자가 없습니다.`,
    );
  }
  return safe;
}

function selectionItems(
  options: readonly TerminalSelectionOption[],
  redactor: TerminalTextRedactor,
): SelectItem[] {
  if (options.length < 1 || options.length > MAX_SELECTION_OPTIONS) {
    throw new TerminalScreenError(
      "screen_application_failed",
      `선택지는 1–${MAX_SELECTION_OPTIONS}개여야 합니다.`,
    );
  }
  const items: SelectItem[] = [];
  const values = new Set<string>();
  let totalBytes = 0;
  for (const option of options) {
    const value = option.value.trim();
    const valueBytes = Buffer.byteLength(option.value, "utf8");
    const labelBytes = Buffer.byteLength(option.label, "utf8");
    const descriptionBytes = option.description === undefined
      ? 0
      : Buffer.byteLength(option.description, "utf8");
    totalBytes += valueBytes + labelBytes + descriptionBytes;
    if (
      !value ||
      valueBytes > MAX_SELECTION_VALUE_BYTES ||
      /\p{Cc}/u.test(value) ||
      values.has(value)
    ) {
      throw new TerminalScreenError(
        "screen_application_failed",
        "선택지 value는 서로 다른 bounded 문자열이어야 합니다.",
      );
    }
    if (totalBytes > MAX_SELECTION_BYTES) {
      throw new TerminalScreenError(
        "screen_application_failed",
        "선택지 전체 크기가 허용 한도를 초과했습니다.",
      );
    }
    const label = selectionText(
      option.label,
      "선택지 label",
      MAX_SELECTION_LABEL_BYTES,
      redactor,
      false,
    );
    const description = option.description === undefined
      ? undefined
      : selectionText(
          option.description,
          "선택지 description",
          MAX_SELECTION_DESCRIPTION_BYTES,
          redactor,
          false,
        );
    values.add(value);
    items.push({
      value,
      label,
      ...(description === undefined ? {} : { description }),
    });
  }
  return items;
}

function safeRenderedLine(
  value: string,
  width: number,
  redactor: TerminalTextRedactor,
  preserveCursor: boolean,
): string {
  const maximumWidth = normalizedRenderWidth(width);
  if (!preserveCursor) {
    return truncateToWidth(
      safeTerminalLine(value, { maximumBytes: MAX_RENDERED_LINE_BYTES, redactor }),
      maximumWidth,
      "…",
    );
  }

  const markerIndex = value.lastIndexOf(CURSOR_MARKER);
  if (markerIndex < 0) {
    return truncateToWidth(
      safeTerminalLine(value, { maximumBytes: MAX_RENDERED_LINE_BYTES, redactor }),
      maximumWidth,
      "…",
    );
  }
  const before = safeTerminalLine(value.slice(0, markerIndex), {
    maximumBytes: Math.floor(MAX_RENDERED_LINE_BYTES / 2),
    redactor,
  });
  const after = safeTerminalLine(value.slice(markerIndex + CURSOR_MARKER.length), {
    maximumBytes: Math.floor(MAX_RENDERED_LINE_BYTES / 2),
    redactor,
  });
  return truncateToWidth(`${before}${CURSOR_MARKER}${after}`, maximumWidth, "…");
}

class ComponentBoundary implements Component {
  readonly wantsKeyRelease: boolean;

  constructor(
    protected readonly component: Component,
    private readonly label: string,
    private readonly redactor: TerminalTextRedactor,
    private readonly failureHandler: ComponentFailureHandler,
    private readonly preserveCursor = false,
  ) {
    this.wantsKeyRelease = component.wantsKeyRelease === true;
  }

  render(width: number): string[] {
    try {
      const safeWidth = normalizedRenderWidth(width);
      const rendered = this.component.render(safeWidth);
      if (!Array.isArray(rendered)) throw new Error("구성 요소가 행 배열을 반환하지 않았습니다.");
      const rows: string[] = [];
      const maximumRows = Math.min(rendered.length, MAX_COMPONENT_ROWS);
      for (let index = 0; index < maximumRows; index += 1) {
        const row = rendered[index];
        if (typeof row !== "string") throw new Error("구성 요소가 문자열이 아닌 행을 반환했습니다.");
        rows.push(safeRenderedLine(row, safeWidth, this.redactor, this.preserveCursor));
      }
      if (rendered.length > maximumRows) rows.push("… [화면 행 제한으로 생략]");
      return rows;
    } catch (error) {
      this.failureHandler("render", this.label, error);
      return ["[화면 구성 요소를 표시하지 못했습니다.]"];
    }
  }

  handleInput(data: string): void {
    try {
      this.component.handleInput?.(data);
    } catch (error) {
      this.failureHandler("input", this.label, error);
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    try {
      return this.component.handleMouse?.(event);
    } catch (error) {
      this.failureHandler("mouse", this.label, error);
      return undefined;
    }
  }

  invalidate(): void {
    try {
      this.component.invalidate();
    } catch (error) {
      this.failureHandler("invalidate", this.label, error);
    }
  }
}

class FocusableComponentBoundary extends ComponentBoundary implements Focusable {
  constructor(
    private readonly focusableComponent: Component & Focusable,
    label: string,
    redactor: TerminalTextRedactor,
    failureHandler: ComponentFailureHandler,
  ) {
    super(focusableComponent, label, redactor, failureHandler, true);
  }

  get focused(): boolean {
    return this.focusableComponent.focused;
  }

  set focused(value: boolean) {
    this.focusableComponent.focused = value;
  }
}

class BoundedSingleLine implements Component {
  #text: string;

  constructor(
    text: string,
    private readonly redactor: TerminalTextRedactor,
  ) {
    this.#text = safeTerminalLine(text, { redactor });
  }

  setText(text: string): void {
    this.#text = safeTerminalLine(text, { redactor: this.redactor });
  }

  invalidate(): void {}

  render(width: number): string[] {
    return [truncateToWidth(this.#text, normalizedRenderWidth(width), "…")];
  }
}

class SelectionPanel implements Component {
  readonly #heading: Text;
  readonly #list: SelectList;
  readonly #footer: Text;

  constructor(options: {
    readonly title: string;
    readonly message?: string;
    readonly items: SelectItem[];
  }) {
    const heading = options.message
      ? `${options.title}\n\n${options.message}`
      : options.title;
    this.#heading = new Text(heading, 0, 0);
    this.#list = new SelectList(
      options.items,
      Math.min(10, options.items.length),
      EDITOR_THEME.selectList,
    );
    this.#footer = new Text("Enter로 선택 · Esc로 취소", 0, 0);
  }

  set onSelect(callback: ((item: SelectItem) => void) | undefined) {
    if (callback === undefined) delete this.#list.onSelect;
    else this.#list.onSelect = callback;
  }

  set onCancel(callback: (() => void) | undefined) {
    if (callback === undefined) delete this.#list.onCancel;
    else this.#list.onCancel = callback;
  }

  set onSelectionChange(callback: ((item: SelectItem) => void) | undefined) {
    if (callback === undefined) delete this.#list.onSelectionChange;
    else this.#list.onSelectionChange = callback;
  }

  handleInput(data: string): void {
    this.#list.handleInput(data);
  }

  invalidate(): void {
    this.#heading.invalidate();
    this.#list.invalidate();
    this.#footer.invalidate();
  }

  render(width: number): string[] {
    return [
      ...this.#heading.render(width),
      "",
      ...this.#list.render(width),
      "",
      ...this.#footer.render(width),
    ];
  }

  dispose(): void {
    delete this.#list.onSelect;
    delete this.#list.onCancel;
    delete this.#list.onSelectionChange;
  }
}

class NativeSelectionTui extends TuiAltScreen {
  constructor(
    terminal: Terminal,
    private readonly renderFailure: (error: unknown) => void,
  ) {
    super(terminal, true, undefined, {
      mouse: false,
      copyOnSelect: false,
      wheelScrollLines: 3,
    });
  }

  protected override beforeTerminalStart(): void {
    super.beforeTerminalStart();
    this.terminal.write(DISABLE_MOUSE_REPORTING);
  }

  protected override beforeTerminalStop(options: TuiStopOptions): void {
    try {
      this.terminal.write(DISABLE_MOUSE_REPORTING);
    } finally {
      super.beforeTerminalStop(options);
    }
  }

  protected override doRender(): void {
    try {
      super.doRender();
    } catch (error) {
      this.renderFailure(error);
    }
  }
}

class ScreenRedactor implements TerminalTextRedactor {
  readonly #base: TerminalTextRedactor;
  readonly #secrets = new Set<string>();
  #secretBytes = 0;
  #dynamic = new Redactor();

  constructor(base: TerminalTextRedactor) {
    this.#base = base;
  }

  addSecret(secret: string): boolean {
    if (this.#secrets.has(secret)) return true;
    const bytes = Buffer.byteLength(secret, "utf8");
    if (
      bytes < 8 ||
      bytes > 8 * 1024 ||
      this.#secrets.size >= MAX_REGISTERED_SECRETS ||
      this.#secretBytes + bytes > MAX_REGISTERED_SECRET_BYTES
    ) return false;
    this.#secrets.add(secret);
    this.#secretBytes += bytes;
    this.#dynamic = new Redactor([...this.#secrets]);
    return true;
  }

  clearAddedSecrets(): void {
    this.#secrets.clear();
    this.#secretBytes = 0;
    this.#dynamic = new Redactor();
  }

  redact(text: string): string {
    return this.#dynamic.redact(this.#base.redact(text));
  }
}

function failureMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "알 수 없는 오류";
}

function configuredScreenRedactor(options: CatTerminalScreenOptions): TerminalTextRedactor {
  const secrets = options.secrets ?? [];
  if (secrets.length > MAX_CONFIGURED_SECRETS) {
    throw new TerminalScreenError(
      "screen_application_failed",
      "화면 redaction secret 수가 허용 한도를 초과했습니다.",
    );
  }
  const selected: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const secret of secrets) {
    if (!secret || seen.has(secret)) continue;
    const bytes = Buffer.byteLength(secret, "utf8");
    if (
      bytes > MAX_CONFIGURED_SECRET_ENTRY_BYTES ||
      totalBytes + bytes > MAX_CONFIGURED_SECRET_BYTES
    ) {
      throw new TerminalScreenError(
        "screen_application_failed",
        "화면 redaction secret 크기가 허용 한도를 초과했습니다.",
      );
    }
    seen.add(secret);
    selected.push(secret);
    totalBytes += bytes;
  }
  const knownSecrets = new Redactor(selected);
  const base = options.redactor;
  if (!base) return knownSecrets;
  return {
    redact: (text) => knownSecrets.redact(base.redact(text)),
  };
}

export class CatTerminalScreen {
  readonly #terminal: Terminal;
  readonly #tty: TerminalTtyState;
  readonly #diagnostics: TerminalDiagnosticWriter;
  readonly #clipboard: ClipboardWriter;
  readonly #redactor: ScreenRedactor;
  readonly #tui: NativeSelectionTui;
  readonly #header: BoundedSingleLine;
  readonly #status: BoundedSingleLine;
  readonly #transcript: Container;
  readonly #transcriptModel: TerminalTranscript;
  readonly #scroll: ScrollView;
  readonly #editor: BoundedEditor;
  readonly #editorBoundary: FocusableComponentBoundary;
  readonly #rawView: RawTranscriptView;
  readonly #exitPromise: Promise<TerminalScreenExit>;

  #resolveExit: ((result: TerminalScreenExit) => void) | undefined;
  #state: TerminalScreenState = "idle";
  #failure: TerminalScreenError | undefined;
  #startAttempted = false;
  #restorationAttempted = false;
  #exitResolved = false;
  #inputController: TerminalInputController | undefined;
  #activeSecret: ActiveModal | undefined;
  #activeSelection: ActiveModal | undefined;
  #clipboardCopy: AbortController | undefined;

  constructor(options: CatTerminalScreenOptions) {
    this.#terminal = options.terminal ?? new ProcessTerminal();
    this.#tty = { ...(options.tty ?? detectTerminalTtyState()) };
    this.#diagnostics = options.diagnostics ?? process.stderr;
    this.#clipboard = options.clipboard ?? new LocalClipboardWriter();
    this.#redactor = new ScreenRedactor(configuredScreenRedactor(options));
    this.#transcript = new Container();
    this.#transcriptModel = new TerminalTranscript(this.#transcript, {
      sanitize: (text, maximumBytes, singleLine = false) => singleLine
        ? safeTerminalLine(text, { maximumBytes, redactor: this.#redactor })
        : sanitizeTerminalText(text, { maximumBytes, redactor: this.#redactor }).text,
      onChange: () => this.requestRender(),
    });

    const componentFailure: ComponentFailureHandler = (operation, label, error) => {
      this.#captureComponentFailure(operation, label, error);
    };
    this.#tui = new NativeSelectionTui(this.#terminal, (error) => {
      this.#captureComponentFailure("render", "화면 renderer", error);
    });
    this.#header = new BoundedSingleLine(
      `${PRODUCT_NAME} v${VERSION} · ${options.model} · ${options.workspace}`,
      this.#redactor,
    );
    this.#status = new BoundedSingleLine(
      options.status ?? `세션 ${options.sessionId} · 준비`,
      this.#redactor,
    );
    this.#editor = new BoundedEditor(
      this.#tui,
      EDITOR_THEME,
      { paddingX: 0, autocompleteMaxVisible: 8 },
      () => this.setStatus("입력이 허용된 크기 제한에 도달했습니다."),
    );
    this.#editor.disableSubmit = true;
    this.#editorBoundary = new FocusableComponentBoundary(
      this.#editor,
      "입력 편집기",
      this.#redactor,
      componentFailure,
    );
    const transcriptBoundary = new ComponentBoundary(
      this.#transcript,
      "대화 기록",
      this.#redactor,
      componentFailure,
    );
    this.#scroll = new ScrollView(transcriptBoundary, {
      follow: "end",
      primary: true,
      overscroll: "chain",
      scrollbar: "auto",
    });
    const headerBoundary = new ComponentBoundary(
      this.#header,
      "머리글",
      this.#redactor,
      componentFailure,
    );
    const statusBoundary = new ComponentBoundary(
      this.#status,
      "상태 표시줄",
      this.#redactor,
      componentFailure,
    );
    this.#tui.setLayoutRoot(new VStack([
      { component: headerBoundary, basis: 1, grow: 0, shrink: 0, minSize: 1, maxSize: 1 },
      { component: this.#scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: this.#editorBoundary, basis: "auto", grow: 0, shrink: 1, minSize: 3 },
      { component: statusBoundary, basis: 1, grow: 0, shrink: 0, minSize: 1, maxSize: 1 },
    ]));
    this.#tui.setFocus(this.#editorBoundary);
    this.#rawView = new RawTranscriptView({
      terminal: this.#terminal,
      tty: this.#tty,
      leaveAlternateScreen: () => this.#tui.stop({ preserveScreen: true }),
      returnToAlternateScreen: () => {
        this.#tui.setFocus(this.#editorBoundary);
        this.#tui.start();
        this.#tui.requestRender(true);
      },
      canReturnToAlternateScreen: () => this.#state === "running",
      sanitize: (text, maximumBytes) => sanitizeTerminalText(text, {
        maximumBytes,
        redactor: this.#redactor,
      }).text,
    });
    this.#exitPromise = new Promise<TerminalScreenExit>((resolve) => {
      this.#resolveExit = resolve;
    });
  }

  get state(): TerminalScreenState {
    return this.#state;
  }

  get isRunning(): boolean {
    return this.#state === "running";
  }

  get tty(): TerminalTtyState {
    return { ...this.#tty };
  }

  get editor(): BoundedEditor {
    return this.#editor;
  }

  get isFollowingTranscript(): boolean {
    return this.#scroll.isFollowingEnd;
  }

  get rawViewActive(): boolean {
    return this.#rawView.active;
  }

  start(): void {
    if (this.#state === "running") return;
    if (this.#state !== "idle") {
      throw new TerminalScreenError("screen_start_failed", "종료된 터미널 화면은 다시 시작할 수 없습니다.");
    }
    if (!this.#tty.stdin || !this.#tty.stdout) {
      const missing = [
        ...(this.#tty.stdin ? [] : ["stdin"]),
        ...(this.#tty.stdout ? [] : ["stdout"]),
      ].join("/");
      const error = new TerminalScreenError(
        "interactive_tty_required",
        `대화형 TUI에는 TTY ${missing}이 필요합니다.`,
      );
      this.#failure = error;
      this.#state = "stopped";
      this.#writeDiagnostic(error);
      this.#resolveExitOnce();
      throw error;
    }

    this.#state = "starting";
    this.#startAttempted = true;
    try {
      this.#tui.setFocus(this.#editorBoundary);
      this.#tui.start();
      this.#state = "running";
    } catch (cause) {
      const detail = safeTerminalLine(failureMessage(cause), {
        maximumBytes: 4 * 1024,
        redactor: this.#redactor,
      });
      const error = new TerminalScreenError(
        "screen_start_failed",
        `터미널 화면을 시작하지 못했습니다: ${detail}`,
        { cause },
      );
      this.#failure = error;
      this.stop();
      throw error;
    }
  }

  stop(): void {
    if (this.#state === "stopped" || this.#state === "stopping") return;
    this.#state = "stopping";
    const rawViewError = this.#rawView.cancel();
    this.#clipboardCopy?.abort();
    this.#activeSelection?.cancel(new CancelledError("터미널 화면이 닫혀 선택을 취소했습니다."));
    this.#activeSecret?.cancel(new CancelledError("터미널 화면이 닫혀 비밀 입력을 취소했습니다."));
    this.#inputController?.dispose();
    this.#inputController = undefined;
    try {
      this.#transcriptModel.finalize();
    } catch (error) {
      if (!this.#failure) {
        const detail = safeTerminalLine(failureMessage(error), {
          maximumBytes: 4 * 1024,
          redactor: this.#redactor,
        });
        this.#failure = new TerminalScreenError(
          "screen_component_failed",
          `종료 전 transcript를 확정하지 못했습니다: ${detail}`,
          { cause: error },
        );
      }
    }
    const restorationError = this.#restoreTerminal(rawViewError);
    if (restorationError !== undefined && !this.#failure) {
      const detail = safeTerminalLine(failureMessage(restorationError), {
        maximumBytes: 4 * 1024,
        redactor: this.#redactor,
      });
      this.#failure = new TerminalScreenError(
        "screen_restore_failed",
        `터미널 상태를 완전히 복원하지 못했습니다: ${detail}`,
        { cause: restorationError },
      );
    }
    this.#state = "stopped";
    if (this.#failure) this.#writeDiagnostic(this.#failure);
    this.#resolveExitOnce();
    this.#redactor.clearAddedSecrets();
  }

  close(): void {
    this.stop();
  }

  waitForExit(): Promise<TerminalScreenExit> {
    return this.#exitPromise;
  }

  configureInput(configuration: TerminalInputConfiguration): TerminalInputController {
    if (this.#state === "stopped" || this.#state === "stopping") {
      throw new TerminalScreenError("screen_application_failed", "종료된 화면에는 입력을 연결할 수 없습니다.");
    }
    if (this.#inputController) {
      throw new TerminalScreenError("screen_application_failed", "터미널 입력이 이미 연결되어 있습니다.");
    }
    const host: TerminalInputHost = {
      editor: this.#editor,
      addInputListener: (listener) => this.#tui.addInputListener(listener),
      close: () => this.close(),
      notice: (message) => this.setStatus(message),
      render: () => this.requestRender(),
      reportFailure: (error) => this.reportApplicationFailure(error),
    };
    this.#inputController = new TerminalInputController(host, configuration);
    return this.#inputController;
  }

  setBusy(busy: boolean): void {
    this.#inputController?.setBusy(busy);
  }

  requestSecret(options: SecretPromptOptions): Promise<string> {
    if (this.#state !== "running") {
      return Promise.reject(new TerminalScreenError(
        "screen_application_failed",
        "실행 중인 대화형 화면에서만 비밀값을 입력할 수 있습니다.",
      ));
    }
    if (this.#activeSecret || this.#activeSelection) {
      return Promise.reject(new TerminalScreenError(
        "screen_application_failed",
        "다른 modal 입력이 이미 열려 있습니다.",
      ));
    }
    if (this.#rawView.active || this.#clipboardCopy) {
      return Promise.reject(new TerminalScreenError(
        "screen_application_failed",
        "대화 복사 작업을 닫은 뒤 비밀값을 입력할 수 있습니다.",
      ));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new CancelledError("비밀 입력을 시작하기 전에 취소됐습니다."));
    }

    return new Promise<string>((resolve, reject) => {
      const panel = new SecretInputPanel({
        label: options.label,
        ...(options.message === undefined ? {} : { message: options.message }),
        redactor: this.#redactor,
      });
      const boundary = new FocusableComponentBoundary(
        panel,
        "비밀 입력",
        this.#redactor,
        (operation, label, error) => this.#captureComponentFailure(operation, label, error),
      );
      let overlay: OverlayHandle | undefined;
      let settled = false;

      const abort = (): void => {
        active.cancel(new CancelledError("비밀 입력이 취소됐습니다."));
      };
      const cleanup = (): void => {
        options.signal?.removeEventListener("abort", abort);
        panel.dispose();
        this.#inputController?.setModalInput(false);
        if (this.#activeSecret === active) this.#activeSecret = undefined;
        try {
          overlay?.hide();
        } catch (error) {
          this.#captureComponentFailure("invalidate", "비밀 입력 overlay", error);
        }
        if (this.#state === "running") {
          this.#tui.setFocus(this.#editorBoundary);
          this.requestRender();
        }
      };
      const active: ActiveModal = {
        cancel: (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      };
      panel.onChange = () => this.requestRender();
      panel.onInvalid = (message) => this.setStatus(message);
      panel.onCancel = () => active.cancel(new CancelledError("비밀 입력을 취소했습니다."));
      panel.onSubmit = (secret) => {
        if (settled) return;
        if (!this.#redactor.addSecret(secret)) {
          const error = new Error("비밀값을 안전한 화면 redaction 목록에 등록하지 못했습니다.");
          active.cancel(error);
          this.reportApplicationFailure(error);
          return;
        }
        settled = true;
        cleanup();
        resolve(secret);
      };

      this.#activeSecret = active;
      this.#inputController?.setModalInput(true);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) {
        abort();
        return;
      }
      try {
        overlay = this.#tui.showOverlay(boundary, {
          width: "80%",
          minWidth: 24,
          maxHeight: 12,
          margin: 1,
        });
        this.#tui.setFocus(boundary);
        this.requestRender();
      } catch (error) {
        active.cancel(error instanceof Error ? error : new Error("비밀 입력 화면을 열지 못했습니다."));
      }
    });
  }

  requestSelection(options: TerminalSelectionOptions): Promise<string> {
    if (this.#state !== "running") {
      return Promise.reject(new TerminalScreenError(
        "screen_application_failed",
        "실행 중인 대화형 화면에서만 선택 화면을 열 수 있습니다.",
      ));
    }
    if (this.#activeSelection || this.#activeSecret) {
      return Promise.reject(new TerminalScreenError(
        "screen_application_failed",
        "다른 modal 입력이 이미 열려 있습니다.",
      ));
    }
    if (this.#rawView.active || this.#clipboardCopy) {
      return Promise.reject(new TerminalScreenError(
        "screen_application_failed",
        "대화 복사 작업을 닫은 뒤 선택 화면을 열 수 있습니다.",
      ));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new CancelledError("선택 화면을 열기 전에 취소됐습니다."));
    }

    let title: string;
    let message: string | undefined;
    let items: SelectItem[];
    try {
      title = selectionText(
        options.title,
        "선택 화면 title",
        MAX_SELECTION_TITLE_BYTES,
        this.#redactor,
        false,
      );
      message = options.message === undefined
        ? undefined
        : selectionText(
            options.message,
            "선택 화면 message",
            MAX_SELECTION_MESSAGE_BYTES,
            this.#redactor,
            true,
          );
      items = selectionItems(options.options, this.#redactor);
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise<string>((resolve, reject) => {
      const panel = new SelectionPanel({
        title,
        ...(message === undefined ? {} : { message }),
        items,
      });
      const boundary = new ComponentBoundary(
        panel,
        "선택 입력",
        this.#redactor,
        (operation, label, error) => this.#captureComponentFailure(operation, label, error),
      );
      let overlay: OverlayHandle | undefined;
      let settled = false;

      const abort = (): void => {
        active.cancel(new CancelledError("선택 요청이 취소됐습니다."));
      };
      const cleanup = (): void => {
        options.signal?.removeEventListener("abort", abort);
        panel.dispose();
        this.#inputController?.setModalInput(false);
        if (this.#activeSelection === active) this.#activeSelection = undefined;
        try {
          overlay?.hide();
        } catch (error) {
          this.#captureComponentFailure("invalidate", "선택 overlay", error);
        }
        if (this.#state === "running") {
          this.#tui.setFocus(this.#editorBoundary);
          this.requestRender();
        }
      };
      const active: ActiveModal = {
        cancel: (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      };
      panel.onSelectionChange = () => this.requestRender();
      panel.onCancel = () => active.cancel(new CancelledError("선택을 취소했습니다."));
      panel.onSelect = (item) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(item.value);
      };

      this.#activeSelection = active;
      this.#inputController?.setModalInput(true);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) {
        abort();
        return;
      }
      try {
        overlay = this.#tui.showOverlay(boundary, {
          width: "88%",
          minWidth: 32,
          maxHeight: 20,
          margin: 1,
        });
        this.#tui.setFocus(boundary);
        this.requestRender();
      } catch (error) {
        active.cancel(error instanceof Error ? error : new Error("선택 화면을 열지 못했습니다."));
      }
    });
  }

  async showInformation(options: TerminalInformationOptions): Promise<void> {
    try {
      await this.requestSelection({
        title: options.title,
        message: options.message,
        options: [{ value: "close", label: "확인" }],
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (error instanceof CancelledError && options.signal?.aborted !== true) return;
      throw error;
    }
  }

  async run(
    application: (screen: CatTerminalScreen) => Promise<void>,
  ): Promise<TerminalScreenExit> {
    try {
      this.start();
      await application(this);
    } catch (error) {
      if (!this.#failure) this.reportApplicationFailure(error);
    } finally {
      this.stop();
    }
    return this.waitForExit();
  }

  reportApplicationFailure(error: unknown): void {
    if (this.#state === "stopped" || this.#state === "stopping" || this.#failure) return;
    const detail = safeTerminalLine(failureMessage(error), {
      maximumBytes: 4 * 1024,
      redactor: this.#redactor,
    });
    this.#failure = new TerminalScreenError(
      "screen_application_failed",
      `터미널 애플리케이션 오류가 발생했습니다: ${detail}`,
      { cause: error },
    );
    queueMicrotask(() => this.stop());
  }

  setHeader(text: string): void {
    if (this.#state === "stopped" || this.#state === "stopping") return;
    this.#header.setText(text);
    this.requestRender();
  }

  setStatus(text: string): void {
    if (this.#state === "stopped" || this.#state === "stopping") return;
    this.#status.setText(text);
    this.requestRender();
  }

  appendTranscriptText(text: string): void {
    if (this.#state === "stopped" || this.#state === "stopping") return;
    this.#transcriptModel.addText(text);
  }

  addUserMessage(text: string): void {
    if (this.#state === "stopped" || this.#state === "stopping") return;
    this.#transcriptModel.addUser(text);
  }

  addAssistantMessage(text: string): void {
    if (this.#state === "stopped" || this.#state === "stopping") return;
    this.#transcriptModel.addAssistant(text);
  }

  consumeAgentEvent(event: AgentEvent): void {
    if (this.#state === "stopped" || this.#state === "stopping") return;
    try {
      this.#transcriptModel.consumeAgentEvent(event);
    } catch (error) {
      this.#captureComponentFailure("render", "agent event transcript", error);
    }
  }

  restoreTranscript(
    records: readonly StoredTranscriptRecord[],
    display: ResumeTranscriptDisplay,
  ): void {
    if (this.#state === "stopped" || this.#state === "stopping") return;
    try {
      this.#transcriptModel.restore(records, display);
    } catch (error) {
      this.#captureComponentFailure("render", "세션 transcript 복원", error);
    }
  }

  setDetailsExpanded(expanded: boolean): void {
    if (this.#state === "stopped" || this.#state === "stopping") return;
    this.#transcriptModel.setDetailsExpanded(expanded);
  }

  toggleDetails(): boolean {
    if (this.#state === "stopped" || this.#state === "stopping") return false;
    return this.#transcriptModel.toggleDetails();
  }

  toggleToolDetails(runId: string, callId: string): boolean {
    if (this.#state === "stopped" || this.#state === "stopping") return false;
    return this.#transcriptModel.toggleTool(runId, callId);
  }

  rawTranscript(maximumBytes?: number): RawTranscriptSnapshot {
    return maximumBytes === undefined
      ? this.#transcriptModel.rawSnapshot()
      : this.#transcriptModel.rawSnapshot(maximumBytes);
  }

  async showRawTranscript(): Promise<RawTranscriptExitReason> {
    if (this.#state !== "running") {
      throw new TerminalScreenError(
        "screen_application_failed",
        "실행 중인 대화형 화면에서만 대화 복사 보기를 열 수 있습니다.",
      );
    }
    if (this.#rawView.active) {
      throw new TerminalScreenError(
        "screen_application_failed",
        "대화 복사 보기가 이미 열려 있습니다.",
      );
    }
    if (this.#activeSecret || this.#activeSelection || this.#clipboardCopy) {
      throw new TerminalScreenError(
        "screen_application_failed",
        "modal 입력 또는 clipboard 작업이 끝난 뒤 대화 복사 보기를 열 수 있습니다.",
      );
    }
    try {
      return await this.#rawView.show(
        this.#transcriptModel.rawSnapshot(MAX_RAW_TRANSCRIPT_BYTES),
      );
    } catch (error) {
      this.reportApplicationFailure(error);
      throw error;
    }
  }

  async copyTranscriptToClipboard(
    origin: ClipboardWriteOrigin = "user_command",
    signal?: AbortSignal,
  ): Promise<ClipboardWriteResult> {
    if (this.#state !== "running") return Object.freeze({ status: "unavailable" });
    if (
      this.#rawView.active ||
      this.#activeSecret ||
      this.#activeSelection ||
      this.#clipboardCopy
    ) {
      return Object.freeze({ status: "failed" });
    }
    const snapshot = this.#transcriptModel.rawSnapshot(MAX_CLIPBOARD_TEXT_BYTES);
    let result: ClipboardWriteResult;
    if (snapshot.truncated) {
      result = Object.freeze({
        status: "too_large",
        maximumBytes: MAX_CLIPBOARD_TEXT_BYTES,
      });
    } else {
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      this.#clipboardCopy = controller;
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      try {
        result = await this.#clipboard.writeText({
          text: snapshot.text,
          origin,
          signal: controller.signal,
        });
      } catch {
        result = Object.freeze({ status: "failed" });
      } finally {
        signal?.removeEventListener("abort", abort);
        if (this.#clipboardCopy === controller) this.#clipboardCopy = undefined;
      }
    }
    const message: Readonly<Record<ClipboardWriteResult["status"], string>> = {
      written: "대화 내용을 로컬 clipboard에 복사했습니다.",
      empty: "복사할 대화 내용이 없습니다.",
      too_large: "대화 내용이 clipboard 복사 크기 제한을 초과했습니다. /raw를 사용하세요.",
      unavailable: "사용할 수 있는 로컬 clipboard 도구가 없습니다.",
      cancelled: "clipboard 복사를 취소했습니다.",
      failed: "로컬 clipboard에 복사하지 못했습니다.",
    };
    this.setStatus(message[result.status]);
    return result;
  }

  clearTranscript(): void {
    if (this.#state === "stopped" || this.#state === "stopping") return;
    this.#transcriptModel.clear();
    this.#scroll.scrollToEnd();
  }

  requestRender(force = false): void {
    if (this.#state !== "running" || this.#rawView.active) return;
    try {
      this.#tui.requestRender(force);
    } catch (error) {
      this.#captureComponentFailure("render", "화면 갱신", error);
    }
  }

  #captureComponentFailure(
    operation: "render" | "input" | "mouse" | "invalidate",
    label: string,
    cause: unknown,
  ): void {
    if (this.#state === "stopped" || this.#state === "stopping" || this.#failure) return;
    const detail = safeTerminalLine(failureMessage(cause), {
      maximumBytes: 4 * 1024,
      redactor: this.#redactor,
    });
    this.#failure = new TerminalScreenError(
      "screen_component_failed",
      `${label} ${operation} 중 오류가 발생했습니다: ${detail}`,
      { cause },
    );
    queueMicrotask(() => this.stop());
  }

  #restoreTerminal(initialError?: unknown): unknown {
    if (!this.#startAttempted || this.#restorationAttempted) return initialError;
    this.#restorationAttempted = true;
    let firstError = initialError;
    try {
      this.#tui.stop({ preserveScreen: true });
    } catch (error) {
      firstError ??= error;
      try {
        this.#terminal.stop();
      } catch (terminalStopError) {
        firstError ??= terminalStopError;
      }
    }
    try {
      this.#terminal.write(EMERGENCY_TERMINAL_RESTORE);
    } catch (error) {
      firstError ??= error;
    }
    try {
      this.#terminal.showCursor();
    } catch (error) {
      firstError ??= error;
    }
    return firstError;
  }

  #writeDiagnostic(error: TerminalScreenError): void {
    const message = safeTerminalLine(`${PRODUCT_NAME}: ${error.message}`, {
      maximumBytes: 8 * 1024,
      redactor: this.#redactor,
    });
    try {
      this.#diagnostics.write(`${message}\n`);
    } catch {
      // Terminal restoration and exit settlement must not depend on diagnostic output.
    }
  }

  #resolveExitOnce(): void {
    if (this.#exitResolved) return;
    this.#exitResolved = true;
    const result: TerminalScreenExit = this.#failure
      ? { reason: "failure", error: this.#failure }
      : { reason: "closed" };
    this.#resolveExit?.(result);
    this.#resolveExit = undefined;
  }
}

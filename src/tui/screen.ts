import {
  Container,
  CURSOR_MARKER,
  ProcessTerminal,
  ScrollView,
  Text,
  TuiAltScreen,
  VStack,
  truncateToWidth,
  type Component,
  type EditorTheme,
  type Focusable,
  type OverlayHandle,
  type Terminal,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  type TuiStopOptions,
} from "@earendil-works/pi-tui";

import { CancelledError } from "../core/errors.js";
import { PRODUCT_NAME, VERSION } from "../core/version.js";
import { Redactor } from "../security/redaction.js";
import {
  BoundedEditor,
  TerminalInputController,
  type TerminalInputConfiguration,
  type TerminalInputHost,
} from "./input.js";
import { SecretInputPanel } from "./secret-input.js";
import {
  safeTerminalLine,
  sanitizeTerminalText,
  type TerminalTextRedactor,
} from "./terminal-text.js";

const DISABLE_MOUSE_REPORTING =
  "\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1004l\u001B[?1006l\u001B[?1015l";
const EMERGENCY_TERMINAL_RESTORE =
  "\u001B[?2026l\u001B[?2004l\u001B[?1007l" +
  `${DISABLE_MOUSE_REPORTING}\u001B[?7h\u001B[?1049l\u001B[0m\u001B[?25h`;
const MAX_RENDER_COLUMNS = 1_000;
const MAX_RENDERED_LINE_BYTES = 64 * 1024;
const MAX_COMPONENT_ROWS = 8_192;
const MAX_TRANSCRIPT_ENTRY_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_ENTRIES = 256;
const MAX_REGISTERED_SECRETS = 32;
const MAX_REGISTERED_SECRET_BYTES = 256 * 1024;

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
}

interface TranscriptComponent {
  readonly component: Component;
  readonly bytes: number;
}

interface ActiveSecretPrompt {
  cancel(error: Error): void;
}

export interface SecretPromptOptions {
  readonly label: string;
  readonly message?: string;
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

export class CatTerminalScreen {
  readonly #terminal: Terminal;
  readonly #tty: TerminalTtyState;
  readonly #diagnostics: TerminalDiagnosticWriter;
  readonly #redactor: ScreenRedactor;
  readonly #tui: NativeSelectionTui;
  readonly #header: BoundedSingleLine;
  readonly #status: BoundedSingleLine;
  readonly #transcript = new Container();
  readonly #transcriptComponents: TranscriptComponent[] = [];
  readonly #scroll: ScrollView;
  readonly #editor: BoundedEditor;
  readonly #editorBoundary: FocusableComponentBoundary;
  readonly #exitPromise: Promise<TerminalScreenExit>;

  #resolveExit: ((result: TerminalScreenExit) => void) | undefined;
  #state: TerminalScreenState = "idle";
  #failure: TerminalScreenError | undefined;
  #startAttempted = false;
  #restorationAttempted = false;
  #exitResolved = false;
  #transcriptBytes = 0;
  #inputController: TerminalInputController | undefined;
  #activeSecret: ActiveSecretPrompt | undefined;

  constructor(options: CatTerminalScreenOptions) {
    this.#terminal = options.terminal ?? new ProcessTerminal();
    this.#tty = { ...(options.tty ?? detectTerminalTtyState()) };
    this.#diagnostics = options.diagnostics ?? process.stderr;
    this.#redactor = new ScreenRedactor(
      options.redactor ?? new Redactor(options.secrets ?? []),
    );

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
    this.#activeSecret?.cancel(new CancelledError("터미널 화면이 닫혀 비밀 입력을 취소했습니다."));
    this.#inputController?.dispose();
    this.#inputController = undefined;
    const restorationError = this.#restoreTerminal();
    if (restorationError && !this.#failure) {
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
    if (this.#activeSecret) {
      return Promise.reject(new TerminalScreenError(
        "screen_application_failed",
        "다른 비밀 입력이 이미 열려 있습니다.",
      ));
    }
    if (this.#inputController?.busy) {
      return Promise.reject(new TerminalScreenError(
        "screen_application_failed",
        "실행 중인 요청이 끝난 뒤 비밀값을 입력할 수 있습니다.",
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
      const active: ActiveSecretPrompt = {
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
    const sanitized = sanitizeTerminalText(text, {
      maximumBytes: MAX_TRANSCRIPT_ENTRY_BYTES,
      redactor: this.#redactor,
    });
    if (!sanitized.text) return;
    const textComponent = new Text(sanitized.text, 0, 0);
    const component = new ComponentBoundary(
      textComponent,
      "대화 항목",
      this.#redactor,
      (operation, label, error) => this.#captureComponentFailure(operation, label, error),
    );
    const bytes = Buffer.byteLength(sanitized.text, "utf8");
    this.#transcript.addChild(component);
    this.#transcriptComponents.push({ component, bytes });
    this.#transcriptBytes += bytes;
    while (
      this.#transcriptComponents.length > MAX_TRANSCRIPT_ENTRIES ||
      this.#transcriptBytes > MAX_TRANSCRIPT_BYTES
    ) {
      const removed = this.#transcriptComponents.shift();
      if (!removed) break;
      this.#transcript.removeChild(removed.component);
      this.#transcriptBytes -= removed.bytes;
    }
    this.requestRender();
  }

  clearTranscript(): void {
    if (this.#state === "stopped" || this.#state === "stopping") return;
    this.#transcript.clear();
    this.#transcriptComponents.length = 0;
    this.#transcriptBytes = 0;
    this.#scroll.scrollToEnd();
    this.requestRender();
  }

  requestRender(force = false): void {
    if (this.#state !== "running") return;
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

  #restoreTerminal(): unknown {
    if (!this.#startAttempted || this.#restorationAttempted) return undefined;
    this.#restorationAttempted = true;
    let firstError: unknown;
    try {
      this.#tui.stop({ preserveScreen: true });
    } catch (error) {
      firstError = error;
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

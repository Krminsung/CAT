import { Input, Text, matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";
import { safeTerminalLine, type TerminalTextRedactor } from "./terminal-text.js";

export interface TextInputPanelOptions {
  readonly label: string;
  readonly message?: string;
  readonly initialValue?: string;
  readonly validate?: (value: string) => string;
  readonly redactor: TerminalTextRedactor;
}

const MAX_INPUT_BYTES = 4_096;

/** Public configuration input. API keys must continue to use SecretInputPanel. */
export class TextInputPanel implements Component, Focusable {
  readonly #input: Input;
  readonly #message: Text;
  #error = "";
  #disabled = false;
  #paste: string | undefined;
  #pasteTooLong = false;
  onSubmit: ((value: string) => void) | undefined;
  onCancel: (() => void) | undefined;
  onChange: (() => void) | undefined;
  onInvalid: ((message: string) => void) | undefined;

  constructor(readonly options: TextInputPanelOptions) {
    this.#input = new Input({ prompt: `${options.label}: ` });
    this.#input.setValue((options.initialValue ?? "").slice(0, MAX_INPUT_BYTES));
    this.#input.handleInput("\u0005"); // Place the cursor after the initial value (Ctrl+E).
    this.#message = new Text(options.message ?? "", 0, 0);
    this.#input.onSubmit = (value) => {
      try {
        const selected = value.trim();
        if (!selected || Buffer.byteLength(selected, "utf8") > MAX_INPUT_BYTES || /\p{Cc}/u.test(selected)) {
          throw new Error("제어 문자 없이 1–4096 bytes를 입력하세요.");
        }
        const normalized = options.validate ? options.validate(selected) : selected;
        this.#disabled = true;
        this.onSubmit?.(normalized);
      } catch (error) {
        this.#error = safeTerminalLine(error instanceof Error ? error.message : "입력을 확인하세요.", {
          maximumBytes: 1_024,
          redactor: options.redactor,
        });
        this.onInvalid?.(this.#error);
        this.onChange?.();
      }
    };
    this.#input.onEscape = () => this.onCancel?.();
  }

  get focused(): boolean { return this.#input.focused; }
  set focused(value: boolean) { this.#input.focused = value; }

  handleInput(data: string): void {
    if (this.#disabled) return;
    if (matchesKey(data, "ctrl+c") || (matchesKey(data, "ctrl+d") && !this.#input.getValue())) {
      this.onCancel?.();
      return;
    }
    const previous = this.#input.getValue();
    const pasteStart = data.indexOf("\u001b[200~");
    if (pasteStart >= 0) {
      this.#paste = "";
      this.#pasteTooLong = false;
      data = data.slice(pasteStart + 6);
    }
    if (this.#paste !== undefined) {
      const end = data.indexOf("\u001b[201~");
      const fragment = end < 0 ? data : data.slice(0, end);
      if (Buffer.byteLength(this.#paste, "utf8") + Buffer.byteLength(fragment, "utf8") > MAX_INPUT_BYTES) {
        this.#pasteTooLong = true;
      } else if (!this.#pasteTooLong) {
        this.#paste += fragment;
      }
      if (end < 0) return;
      data = this.#pasteTooLong ? "" : `\u001b[200~${this.#paste}\u001b[201~`;
      this.#paste = undefined;
      if (this.#pasteTooLong) this.#error = "입력은 4096 bytes 이하여야 합니다.";
    }
    if (Buffer.byteLength(data, "utf8") > MAX_INPUT_BYTES * 2) {
      this.#error = "입력이 너무 깁니다.";
    } else {
      this.#input.handleInput(data);
      if (Buffer.byteLength(this.#input.getValue(), "utf8") > MAX_INPUT_BYTES) {
        this.#input.setValue(previous);
        this.#error = "입력은 4096 bytes 이하여야 합니다.";
      }
    }
    this.onChange?.();
  }

  render(width: number): string[] {
    return [
      ...this.#message.render(width),
      ...this.#input.render(width),
      ...new Text(this.#error || "Enter로 확인 · Esc로 돌아가기 · Ctrl+U로 지우기", 0, 0).render(width),
    ];
  }

  invalidate(): void { this.#input.invalidate(); this.#message.invalidate(); }
  dispose(): void {
    this.#disabled = true;
    this.#paste = undefined;
    this.#input.setValue("");
    delete this.#input.onSubmit;
    delete this.#input.onEscape;
    this.onSubmit = undefined;
    this.onCancel = undefined;
    this.onChange = undefined;
    this.onInvalid = undefined;
  }
}

import { matchesKey, type Terminal } from "@earendil-works/pi-tui";

import type { RawTranscriptSnapshot } from "./transcript.js";

export const MAX_RAW_TRANSCRIPT_BYTES = 1024 * 1024;

const RAW_SCREEN_PREFIX = "\u001B[0m\u001B[2J\u001B[H";

export type RawTranscriptExitReason =
  | "enter"
  | "escape"
  | "ctrl_c"
  | "ctrl_d"
  | "screen_closed";

export type RawTranscriptViewErrorCode =
  | "raw_tty_required"
  | "raw_already_active"
  | "raw_transition_failed"
  | "raw_restore_failed";

export class RawTranscriptViewError extends Error {
  override name = "RawTranscriptViewError";

  constructor(
    readonly code: RawTranscriptViewErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface RawTranscriptViewOptions {
  readonly terminal: Terminal;
  readonly tty: { readonly stdin: boolean; readonly stdout: boolean };
  readonly leaveAlternateScreen: () => void;
  readonly returnToAlternateScreen: () => void;
  readonly canReturnToAlternateScreen: () => boolean;
  readonly sanitize: (text: string, maximumBytes: number) => string;
}

function exitReason(data: string): RawTranscriptExitReason | undefined {
  if (matchesKey(data, "enter")) return "enter";
  if (matchesKey(data, "escape")) return "escape";
  if (matchesKey(data, "ctrl+c")) return "ctrl_c";
  if (matchesKey(data, "ctrl+d")) return "ctrl_d";
  return undefined;
}

function renderRawScreen(
  snapshot: RawTranscriptSnapshot,
  sanitize: RawTranscriptViewOptions["sanitize"],
): string {
  const body = sanitize(snapshot.text, MAX_RAW_TRANSCRIPT_BYTES);
  const rows = [
    "cat · 대화 복사 보기",
    `표시 항목 ${snapshot.entries}개${snapshot.truncated ? " · 오래되거나 큰 내용 일부 생략" : ""}`,
    "",
    body,
    "",
    "터미널의 기본 드래그 선택으로 위 내용을 복사할 수 있습니다.",
    "Enter, Esc, Ctrl+C 또는 Ctrl+D를 누르면 같은 대화로 돌아갑니다.",
  ];
  return `${RAW_SCREEN_PREFIX}${rows.join("\n").replaceAll("\n", "\r\n")}`;
}

function viewError(
  code: RawTranscriptViewErrorCode,
  message: string,
  cause: unknown,
): RawTranscriptViewError {
  return cause instanceof RawTranscriptViewError
    ? cause
    : new RawTranscriptViewError(code, message, { cause });
}

export class RawTranscriptView {
  readonly #options: RawTranscriptViewOptions;
  #active = false;
  #terminalStarted = false;
  #finish: ((reason: RawTranscriptExitReason) => void) | undefined;

  constructor(options: RawTranscriptViewOptions) {
    this.#options = options;
  }

  get active(): boolean {
    return this.#active;
  }

  async show(snapshot: RawTranscriptSnapshot): Promise<RawTranscriptExitReason> {
    if (!this.#options.tty.stdin || !this.#options.tty.stdout) {
      throw new RawTranscriptViewError(
        "raw_tty_required",
        "대화 복사 보기는 stdin과 stdout TTY가 모두 필요합니다.",
      );
    }
    if (this.#active) {
      throw new RawTranscriptViewError(
        "raw_already_active",
        "대화 복사 보기가 이미 열려 있습니다.",
      );
    }

    this.#active = true;
    let leftAlternateScreen = false;
    let reason: RawTranscriptExitReason | undefined;
    let failure: unknown;
    try {
      this.#options.leaveAlternateScreen();
      leftAlternateScreen = true;
      this.#options.terminal.write(renderRawScreen(snapshot, this.#options.sanitize));
      reason = await new Promise<RawTranscriptExitReason>((resolve, reject) => {
        let settled = false;
        this.#finish = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        try {
          this.#terminalStarted = true;
          this.#options.terminal.start((data) => {
            const value = exitReason(data);
            if (value) this.#finish?.(value);
          }, () => undefined);
        } catch (error) {
          settled = true;
          this.#finish = undefined;
          reject(error);
        }
      });
    } catch (error) {
      failure = error;
    }

    if (this.#terminalStarted) {
      try {
        this.#options.terminal.stop();
      } catch (error) {
        failure ??= error;
      } finally {
        this.#terminalStarted = false;
      }
    }
    this.#finish = undefined;
    this.#active = false;

    if (leftAlternateScreen && this.#options.canReturnToAlternateScreen()) {
      try {
        this.#options.returnToAlternateScreen();
      } catch (error) {
        throw viewError(
          "raw_restore_failed",
          "대화 복사 보기에서 터미널 화면으로 돌아오지 못했습니다.",
          error,
        );
      }
    }
    if (failure !== undefined) {
      throw viewError(
        "raw_transition_failed",
        "대화 복사 보기 전환 중 터미널 오류가 발생했습니다.",
        failure,
      );
    }
    return reason ?? "screen_closed";
  }

  cancel(): unknown {
    if (!this.#active) return undefined;
    let failure: unknown;
    if (this.#terminalStarted) {
      try {
        this.#options.terminal.stop();
      } catch (error) {
        failure = error;
      } finally {
        this.#terminalStarted = false;
      }
    }
    this.#finish?.("screen_closed");
    return failure;
  }
}

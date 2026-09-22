import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { AgentEvent } from "../core/events.js";
import { safeTerminalLine, type TerminalTextRedactor } from "./terminal-text.js";

export function fitLine(text: string, width: number): string {
  const size = Math.max(1, Math.min(1_000, Math.floor(width)));
  const clipped = truncateToWidth(text, size, "…");
  return clipped + " ".repeat(Math.max(0, size - visibleWidth(clipped)));
}

export function sessionDisplayName(name?: string): string {
  return name?.trim() || "새 대화";
}

export function messageFrame(lines: readonly string[], width: number, role: "user" | "assistant"): string[] {
  if (width < 8) return [role === "user" ? "나" : "CAT", ...lines, ""];
  const title = role === "user" ? " 나 · 요청 " : " CAT · 응답 ";
  const heading = truncateToWidth(title, width - 2, "");
  const edge = role === "user" ? "┃" : "│";
  return [
    `╭${heading}${"─".repeat(Math.max(0, width - 2 - visibleWidth(heading)))}╮`,
    ...lines.map((line) => `${edge} ${fitLine(line, width - 4)} ${edge}`),
    `╰${"─".repeat(width - 2)}╯`,
    "",
  ];
}

/** Apply only locally generated SGR after the screen boundary strips external escape sequences. */
export function decorateScreenLine(
  line: string,
  width: number,
  kind: "header" | "transcript" | "editor" | "status" | "activity" | "modal",
  color: boolean,
): string {
  if (!color) return line;
  const trimmed = line.trimStart();
  let style = "";
  if (kind === "modal") {
    style = /^│ › /u.test(trimmed) ? "1;97;44" : "38;5;252;48;5;235";
  } else if (kind === "header") {
    style = "1;36";
  } else if (kind === "activity") {
    style = /^\s*[✓○]/u.test(line) ? "36" : "1;33";
  } else if (kind === "status") {
    style = "";
  } else if (kind === "editor") {
    style = /^─/u.test(line) ? "1;36" : "";
  } else if (/^┃|^╭ 나/u.test(line)) {
    style = "97;48;5;24";
  } else if (/^╭ CAT|^✓/u.test(line)) {
    style = "1;36";
  } else if (/^경고|^오류|^×/u.test(line)) {
    style = "1;33";
  } else if (/^[╭╰]|^계획/u.test(line)) {
    style = "36";
  }
  return style ? `\u001b[${style}m${fitLine(line, width)}\u001b[0m` : line;
}

export class WelcomePanel implements Component {
  readonly #text = new Text([
    "",
    "    /\\_/\\",
    "   ( o.o )   CAT",
    "    > ^ <    터미널에서 함께 만드는 코딩 에이전트",
    "",
    "  무엇을 만들어 볼까요?",
    "  아래 입력창에 요청을 적어 주세요.",
    "",
    "  /help 도움말   /sessions 이전 대화   /connect 연결 설정",
    "",
  ].join("\n"), 0, 0);

  render(width: number): string[] { return this.#text.render(width); }
  invalidate(): void { this.#text.invalidate(); }
}

export class ScreenHeader implements Component {
  #text: string;
  #session = "새 대화";

  constructor(text: string, readonly redactor: TerminalTextRedactor) {
    this.#text = safeTerminalLine(text, { redactor });
  }

  setText(text: string): void { this.#text = safeTerminalLine(text, { redactor: this.redactor }); }
  setSession(name: string, mode: string): void {
    this.#session = safeTerminalLine(`${name} · ${mode}`, { redactor: this.redactor });
  }
  render(width: number): string[] {
    return [
      fitLine(` /\\_/\\  ${this.#text}`, width),
      fitLine(` 대화 · ${this.#session}`, width),
      "─".repeat(Math.max(1, Math.min(1_000, width))),
    ];
  }
  invalidate(): void {}
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

function elapsedText(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Visual activity only: it never cancels work or imposes an execution deadline. */
export class RunActivity implements Component {
  #busy = false;
  #startedAt = 0;
  #elapsed = 0;
  #phase = "요청 준비 중";
  #outcome = "준비";
  #modal = false;
  #cancelRequested = false;
  #planStep = "";

  constructor(readonly redactor: TerminalTextRedactor) {}
  get busy(): boolean { return this.#busy; }

  setBusy(busy: boolean): void {
    if (busy === this.#busy) return;
    this.#busy = busy;
    if (busy) {
      this.#startedAt = performance.now();
      this.#phase = "요청 준비 중";
      this.#outcome = "요청 처리 완료";
      this.#planStep = "";
      this.#cancelRequested = false;
    } else {
      this.#elapsed = performance.now() - this.#startedAt;
    }
  }

  setModal(active: boolean): void { this.#modal = active; }
  setOutcome(outcome: "cancelled" | "failed"): void {
    this.#outcome = outcome === "cancelled" ? "요청 취소됨" : "작업 중단 · 안내 확인";
  }
  cancelRequested(): void { if (this.#busy) this.#cancelRequested = true; }
  setPhase(text: string): void {
    this.#phase = safeTerminalLine(text, { maximumBytes: 512, redactor: this.redactor });
  }

  consume(event: AgentEvent): void {
    switch (event.type) {
      case "run_start": this.setPhase("모델 응답 기다리는 중"); break;
      case "text_delta": this.setPhase("CAT 응답 작성 중"); break;
      case "text_complete": this.setPhase("다음 작업 준비 중"); break;
      case "tool_start": this.setPhase(`도구 실행 중 · ${event.toolName}`); break;
      case "tool_result": this.setPhase("다음 단계 판단 중"); break;
      case "approval_required": this.setPhase("권한 승인 기다리는 중"); break;
      case "user_input_required": this.setPhase("사용자 답변 기다리는 중"); break;
      case "user_input_result": this.setPhase("작업 이어가는 중"); break;
      case "plan_update": {
        const step = event.plan.find((item) => item.status === "in_progress");
        this.#planStep = step
          ? safeTerminalLine(step.step, { maximumBytes: 512, redactor: this.redactor })
          : "";
        break;
      }
      case "run_end":
        this.#outcome = event.termination === "completed" ? "작업 완료"
          : event.termination === "cancelled" ? "요청 취소됨" : "작업 중단 · 안내 확인";
        this.setPhase("실행 결과 정리 중");
        break;
      case "notice":
      case "usage": break;
    }
  }

  render(width: number): string[] {
    if (!this.#busy) {
      const symbol = this.#outcome === "준비" ? "○" : /중단|취소/u.test(this.#outcome) ? "!" : "✓";
      return [fitLine(` ${symbol} ${this.#outcome}${
        this.#outcome === "준비" ? " · 요청을 입력하세요" : ` · ${elapsedText(this.#elapsed)}`
      }`, width)];
    }
    const elapsed = performance.now() - this.#startedAt;
    const phase = this.#cancelRequested ? "취소 요청 처리 중"
      : this.#modal ? "사용자 확인 기다리는 중" : this.#phase;
    const leading = ` ${SPINNER[Math.floor(elapsed / 120) % SPINNER.length]} ${phase}`;
    const trailing = ` · ${elapsedText(elapsed)} · Ctrl+C 취소`;
    const available = Math.max(1, width - visibleWidth(trailing));
    const detail = this.#planStep && width >= 100 && !this.#modal ? ` · ${this.#planStep}` : "";
    return [fitLine(`${truncateToWidth(leading + detail, available, "…")}${trailing}`, width)];
  }
  invalidate(): void {}
}

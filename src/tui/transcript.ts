import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  Container,
  Text,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";

import { conversationMessageFromTranscript } from "../context/transcript.js";
import type { AgentEvent, AgentPlanStep } from "../core/events.js";
import type { RunTermination } from "../core/execution.js";
import type { JsonValue } from "../core/json.js";
import type { ConversationMessage } from "../core/messages.js";
import type { ToolExecutionResult } from "../core/tools.js";
import type { StoredTranscriptRecord } from "../storage/sessions.js";

const MAX_ENTRIES = 512;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_ENTRY_BYTES = 256 * 1024;
const MAX_TOOL_DETAIL_BYTES = 128 * 1024;
const MAX_PLAN_BYTES = 128 * 1024;
const MAX_NOTICE_BYTES = 16 * 1024;
const MAX_IDENTIFIER_BYTES = 512;
const MAX_STREAM_CHUNKS = 1_024;
const MAX_PLAN_STEPS = 100;
const MAX_RESTORE_RECORDS = 2_000;
const MAX_TRACKED_RUNS = 64;
const DEFAULT_RAW_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const SENSITIVE_FIELD = /^(?:api[_ -]?key|authorization|cookie|set-cookie|password|passwd|secret|token|access[_ -]?token|refresh[_ -]?token|credentials?)$/iu;
const REDACTED = "[REDACTED]";

const RUN_END_LABELS: Readonly<Record<RunTermination, string>> = {
  completed: "",
  cancelled: "요청이 취소됐습니다.",
  budget_exhausted: "실행 예산이 소진됐습니다.",
  permission_denied: "도구 권한이 거부됐습니다.",
  provider_error: "provider 오류로 실행을 끝냈습니다.",
  protocol_error: "protocol 오류로 실행을 끝냈습니다.",
  concurrent_run: "같은 세션의 다른 실행이 이미 진행 중입니다.",
  no_progress: "같은 작업의 반복을 감지해 실행을 끝냈습니다.",
};

export type TranscriptNoticeLevel = "info" | "warning" | "error";

export interface ResumeTranscriptDisplay {
  readonly sessionId: string;
  readonly name?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly restoredRecords?: number;
  readonly notices?: readonly { readonly message: string }[];
}

export interface RawTranscriptSnapshot {
  readonly text: string;
  readonly truncated: boolean;
  readonly entries: number;
  readonly includedEntries: number;
}

export interface TerminalTranscriptOptions {
  readonly sanitize: (text: string, maximumBytes: number, singleLine?: boolean) => string;
  readonly onChange: () => void;
}

type ManagedKind = "text" | "assistant" | "tool" | "plan" | "resume" | "notice";

interface TranscriptEntryComponent extends Component {
  readonly byteSize: number;
  readonly active: boolean;
  rawText(): string;
  dispose(): void;
}

interface ManagedEntry {
  readonly kind: ManagedKind;
  readonly id?: string;
  readonly component: TranscriptEntryComponent;
  bytes: number;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function validIdentifier(value: string): boolean {
  return Boolean(value) &&
    Buffer.byteLength(value, "utf8") <= MAX_IDENTIFIER_BYTES &&
    !/[\u0000-\u001F\u007F]/u.test(value);
}

function jsonText(value: JsonValue): string {
  try {
    return JSON.stringify(
      value,
      (key: string, item: unknown): unknown => SENSITIVE_FIELD.test(key) ? REDACTED : item,
      2,
    ) ?? "null";
  } catch {
    return "[JSON 값을 표시할 수 없습니다.]";
  }
}

function textParts(message: ConversationMessage): string {
  if (message.role === "tool") return "";
  const parts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") parts.push(part.text);
  }
  return parts.join("\n");
}

function resultStatus(result: ToolExecutionResult): string {
  switch (result.status) {
    case "success": return "완료";
    case "failure": return "실패";
    case "denied": return "거부";
    case "cancelled": return "취소";
  }
}

function resultDetail(result: ToolExecutionResult): string {
  let detail: string;
  switch (result.status) {
    case "success": {
      detail = jsonText(result.output.content);
      if (result.output.truncated) {
        const omitted = result.output.omittedBytes === undefined
          ? ""
          : ` · ${result.output.omittedBytes} bytes 생략`;
        detail += `\n[도구 출력이 잘렸습니다${omitted}]`;
      }
      break;
    }
    case "failure":
      detail = `${result.error.code}: ${result.error.message} · 실행 상태 ${result.execution}`;
      break;
    case "denied":
      detail = result.reason;
      break;
    case "cancelled":
      detail = result.reason ?? "도구 실행이 취소됐습니다.";
      break;
  }
  if (result.warnings?.length) {
    detail += `\n경고 ${result.warnings.length}개: ${result.warnings
      .slice(0, 8)
      .map((warning) => warning.message)
      .join(" · ")}`;
  }
  return detail;
}

abstract class CachedTranscriptEntry implements TranscriptEntryComponent {
  protected readonly text = new Text("", 0, 0);
  protected dirty = true;

  abstract get byteSize(): number;
  abstract get active(): boolean;
  protected abstract displayText(): string;
  abstract rawText(): string;

  invalidate(): void {
    this.dirty = true;
    this.text.invalidate();
  }

  render(width: number): string[] {
    if (this.dirty) {
      this.text.setText(this.displayText());
      this.dirty = false;
    }
    return this.text.render(Math.max(1, width));
  }

  dispose(): void {
    this.text.setText("");
    this.dirty = false;
  }
}

class StaticTextEntry extends CachedTranscriptEntry {
  readonly #display: string;
  readonly #raw: string;
  readonly #bytes: number;

  constructor(
    prefix: string,
    text: string,
    maximumBytes: number,
    sanitize: TerminalTranscriptOptions["sanitize"],
  ) {
    super();
    const safe = sanitize(text, maximumBytes);
    this.#display = `${prefix}${safe.replaceAll("\n", `\n${" ".repeat(visibleWidth(prefix))}`)}`;
    this.#raw = this.#display;
    this.#bytes = Buffer.byteLength(safe, "utf8");
  }

  get byteSize(): number { return this.#bytes; }
  get active(): boolean { return false; }
  protected displayText(): string { return this.#display; }
  rawText(): string { return this.#raw; }
}

class StreamingAssistantEntry extends CachedTranscriptEntry {
  readonly #chunks: string[] = [];
  readonly #sanitize: TerminalTranscriptOptions["sanitize"];
  #bytes = 0;
  #truncated = false;
  #completed = false;
  #materialized = "";

  constructor(sanitize: TerminalTranscriptOptions["sanitize"]) {
    super();
    this.#sanitize = sanitize;
  }

  get byteSize(): number { return this.#bytes; }
  get active(): boolean { return !this.#completed; }

  append(delta: string): boolean {
    if (this.#completed || !delta) return false;
    const remaining = Math.max(0, MAX_TEXT_ENTRY_BYTES - this.#bytes);
    if (remaining === 0) {
      const changed = !this.#truncated;
      this.#truncated = true;
      this.dirty ||= changed;
      return changed;
    }
    const accepted = utf8Prefix(delta, remaining);
    if (!accepted) {
      const changed = !this.#truncated;
      this.#truncated = true;
      this.dirty ||= changed;
      return changed;
    }
    this.#chunks.push(accepted);
    this.#bytes += Buffer.byteLength(accepted, "utf8");
    if (accepted !== delta) this.#truncated = true;
    if (this.#chunks.length >= MAX_STREAM_CHUNKS) {
      this.#chunks.splice(0, this.#chunks.length, this.#chunks.join(""));
    }
    this.dirty = true;
    return true;
  }

  complete(): void {
    if (this.#completed) return;
    this.#materialized = this.#safeText();
    this.#chunks.length = 0;
    this.#bytes = Buffer.byteLength(this.#materialized, "utf8");
    this.#completed = true;
    this.dirty = true;
  }

  protected displayText(): string {
    const value = this.#completed ? this.#materialized : this.#safeText();
    return `• ${value.replaceAll("\n", "\n  ")}`;
  }

  rawText(): string {
    const value = this.#completed ? this.#materialized : this.#safeText();
    return `• ${value.replaceAll("\n", "\n  ")}`;
  }

  override dispose(): void {
    this.#chunks.length = 0;
    this.#materialized = "";
    this.#bytes = 0;
    this.#completed = true;
    super.dispose();
  }

  #safeText(): string {
    const text = this.#chunks.join("");
    const safe = this.#sanitize(text, MAX_TEXT_ENTRY_BYTES);
    return this.#truncated ? `${safe}\n… [응답 표시 제한에 도달했습니다.]` : safe;
  }
}

class ToolTranscriptEntry extends CachedTranscriptEntry {
  readonly #name: string;
  readonly #sanitize: TerminalTranscriptOptions["sanitize"];
  #summary: string;
  #detail: string;
  #status = "진행 중";
  #expanded = false;
  #finished = false;

  constructor(
    name: string,
    summary: string,
    detail: string,
    sanitize: TerminalTranscriptOptions["sanitize"],
  ) {
    super();
    this.#sanitize = sanitize;
    this.#name = sanitize(name, 2 * 1024, true);
    this.#summary = sanitize(summary, 16 * 1024, true);
    this.#detail = sanitize(detail, MAX_TOOL_DETAIL_BYTES);
  }

  get byteSize(): number {
    return Buffer.byteLength(`${this.#name}\n${this.#summary}\n${this.#detail}`, "utf8");
  }
  get active(): boolean { return !this.#finished; }

  progress(summary: string): void {
    if (this.#finished) return;
    this.#summary = this.#sanitize(summary, 16 * 1024, true);
    this.dirty = true;
  }

  finish(result: ToolExecutionResult): void {
    if (this.#finished) return;
    this.#status = resultStatus(result);
    this.#detail = this.#sanitize(resultDetail(result), MAX_TOOL_DETAIL_BYTES);
    this.#finished = true;
    this.dirty = true;
  }

  setExpanded(expanded: boolean): void {
    if (this.#expanded === expanded) return;
    this.#expanded = expanded;
    this.dirty = true;
  }

  toggle(): void {
    this.setExpanded(!this.#expanded);
  }

  protected displayText(): string {
    const symbol = this.#status === "완료" ? "✓" : this.#status === "진행 중" ? "○" : "×";
    const header = `${symbol} ${this.#name} · ${this.#status}${this.#summary ? ` · ${this.#summary}` : ""}`;
    return this.#expanded && this.#detail
      ? `${header}\n  └ ${this.#detail.replaceAll("\n", "\n    ")}`
      : header;
  }

  rawText(): string {
    return `${this.#name} · ${this.#status}${this.#summary ? ` · ${this.#summary}` : ""}${
      this.#detail ? `\n${this.#detail}` : ""
    }`;
  }

  override dispose(): void {
    this.#summary = "";
    this.#detail = "";
    this.#finished = true;
    super.dispose();
  }
}

class PlanTranscriptEntry extends CachedTranscriptEntry {
  readonly #sanitize: TerminalTranscriptOptions["sanitize"];
  #explanation = "";
  #steps: readonly AgentPlanStep[] = [];
  #expanded = true;
  #bytes = 0;

  constructor(sanitize: TerminalTranscriptOptions["sanitize"]) {
    super();
    this.#sanitize = sanitize;
  }

  get byteSize(): number { return this.#bytes; }
  get active(): boolean { return false; }

  update(explanation: string, steps: readonly AgentPlanStep[]): void {
    this.#explanation = this.#sanitize(explanation, 16 * 1024);
    const bounded: AgentPlanStep[] = [];
    let bytes = Buffer.byteLength(this.#explanation, "utf8");
    for (const step of steps.slice(0, MAX_PLAN_STEPS)) {
      const text = this.#sanitize(step.step, 8 * 1024, true);
      const nextBytes = Buffer.byteLength(text, "utf8");
      if (bytes + nextBytes > MAX_PLAN_BYTES) break;
      bounded.push(Object.freeze({ step: text, status: step.status }));
      bytes += nextBytes;
    }
    this.#steps = Object.freeze(bounded);
    this.#bytes = bytes;
    this.dirty = true;
  }

  setExpanded(expanded: boolean): void {
    if (this.#expanded === expanded) return;
    this.#expanded = expanded;
    this.dirty = true;
  }

  toggle(): void {
    this.setExpanded(!this.#expanded);
  }

  protected displayText(): string {
    const completed = this.#steps.filter((step) => step.status === "completed").length;
    const header = `계획 · ${completed}/${this.#steps.length} 완료${
      this.#explanation ? ` · ${this.#explanation}` : ""
    }`;
    if (!this.#expanded) return header;
    const rows = this.#steps.map((step) => {
      const symbol = step.status === "completed" ? "✓" : step.status === "in_progress" ? "→" : "·";
      return `  ${symbol} ${step.step}`;
    });
    return [header, ...rows].join("\n");
  }

  rawText(): string {
    const completed = this.#steps.filter((step) => step.status === "completed").length;
    const header = `계획 · ${completed}/${this.#steps.length} 완료${
      this.#explanation ? ` · ${this.#explanation}` : ""
    }`;
    const rows = this.#steps.map((step) => {
      const symbol = step.status === "completed" ? "✓" : step.status === "in_progress" ? "→" : "·";
      return `  ${symbol} ${step.step}`;
    });
    return [header, ...rows].join("\n");
  }

  override dispose(): void {
    this.#steps = [];
    this.#explanation = "";
    this.#bytes = 0;
    super.dispose();
  }
}

function toolKey(runId: string, callId: string): string {
  return `${runId}\u0000${callId}`;
}

function runEndNotice(event: Extract<AgentEvent, { type: "run_end" }>): string | undefined {
  if (event.termination === "completed") return undefined;
  const label = RUN_END_LABELS[event.termination];
  return event.message ? `${label} ${event.message}` : label;
}

export class TerminalTranscript {
  readonly #container: Container;
  readonly #sanitize: TerminalTranscriptOptions["sanitize"];
  readonly #onChange: () => void;
  readonly #entries: ManagedEntry[] = [];
  readonly #assistants = new Map<string, ManagedEntry>();
  readonly #activeAssistantByRun = new Map<string, string>();
  readonly #tools = new Map<string, ManagedEntry>();
  readonly #lastSequenceByRun = new Map<string, number>();

  #plan: ManagedEntry | undefined;
  #totalBytes = 0;
  #detailsExpanded = false;

  constructor(container: Container, options: TerminalTranscriptOptions) {
    this.#container = container;
    this.#sanitize = options.sanitize;
    this.#onChange = options.onChange;
  }

  get size(): number { return this.#entries.length; }
  get byteSize(): number { return this.#totalBytes; }

  addUser(text: string): void {
    this.#add("text", new StaticTextEntry("› ", text, MAX_TEXT_ENTRY_BYTES, this.#sanitize));
  }

  addText(text: string): void {
    this.#add("text", new StaticTextEntry("", text, MAX_TEXT_ENTRY_BYTES, this.#sanitize));
  }

  addAssistant(text: string): void {
    this.#add("text", new StaticTextEntry("• ", text, MAX_TEXT_ENTRY_BYTES, this.#sanitize));
  }

  addNotice(level: TranscriptNoticeLevel, code: string, message: string): void {
    const prefix = level === "error" ? "오류" : level === "warning" ? "경고" : "안내";
    const safeCode = this.#sanitize(code, 512, true);
    this.#add(
      "notice",
      new StaticTextEntry(`${prefix} · `, `${safeCode}${safeCode ? ": " : ""}${message}`, MAX_NOTICE_BYTES, this.#sanitize),
    );
  }

  addResume(display: ResumeTranscriptDisplay): void {
    const title = display.name ?? display.sessionId;
    const parts = [
      title,
      display.provider,
      display.model,
      display.restoredRecords === undefined ? undefined : `${display.restoredRecords}개 record`,
    ].filter((part): part is string => Boolean(part));
    this.#add(
      "resume",
      new StaticTextEntry("↻ 세션 재개 · ", parts.join(" · "), MAX_NOTICE_BYTES, this.#sanitize),
    );
    for (const notice of display.notices?.slice(0, 32) ?? []) {
      this.addNotice("warning", "resume", notice.message);
    }
  }

  beginAssistant(messageId: string): boolean {
    if (!validIdentifier(messageId) || this.#assistants.has(messageId)) return false;
    const component = new StreamingAssistantEntry(this.#sanitize);
    const entry = this.#add("assistant", component, messageId);
    this.#assistants.set(messageId, entry);
    return true;
  }

  appendAssistant(messageId: string, delta: string): boolean {
    if (!validIdentifier(messageId)) return false;
    const entry = this.#assistants.get(messageId);
    if (!entry || !(entry.component instanceof StreamingAssistantEntry)) return false;
    const changed = entry.component.append(delta);
    if (changed) this.#touch(entry);
    return changed;
  }

  completeAssistant(messageId: string): boolean {
    if (!validIdentifier(messageId)) return false;
    const entry = this.#assistants.get(messageId);
    if (!entry || !(entry.component instanceof StreamingAssistantEntry)) return false;
    entry.component.complete();
    this.#touch(entry);
    return true;
  }

  toolStart(
    runId: string,
    callId: string,
    name: string,
    input?: JsonValue,
  ): boolean {
    if (!validIdentifier(runId) || !validIdentifier(callId)) return false;
    const key = toolKey(runId, callId);
    const existing = this.#tools.get(key);
    const inputText = input === undefined ? "" : jsonText(input);
    if (existing?.component instanceof ToolTranscriptEntry) {
      existing.component.progress("진행 중");
      this.#touch(existing);
      return true;
    }
    const component = new ToolTranscriptEntry(name, "진행 중", inputText, this.#sanitize);
    component.setExpanded(this.#detailsExpanded);
    const entry = this.#add("tool", component, key);
    this.#tools.set(key, entry);
    return true;
  }

  toolProgress(runId: string, callId: string, summary: string): boolean {
    if (!validIdentifier(runId) || !validIdentifier(callId)) return false;
    const entry = this.#tools.get(toolKey(runId, callId));
    if (!entry || !(entry.component instanceof ToolTranscriptEntry)) return false;
    entry.component.progress(summary);
    this.#touch(entry);
    return true;
  }

  toolResult(
    runId: string,
    callId: string,
    name: string,
    result: ToolExecutionResult,
  ): boolean {
    if (!validIdentifier(runId) || !validIdentifier(callId)) return false;
    const key = toolKey(runId, callId);
    let entry = this.#tools.get(key);
    if (!entry) {
      const component = new ToolTranscriptEntry(name, "", "", this.#sanitize);
      component.setExpanded(this.#detailsExpanded);
      entry = this.#add("tool", component, key);
      this.#tools.set(key, entry);
    }
    if (!(entry.component instanceof ToolTranscriptEntry)) return false;
    entry.component.finish(result);
    this.#touch(entry);
    return true;
  }

  updatePlan(explanation: string, plan: readonly AgentPlanStep[]): void {
    let entry = this.#plan;
    if (!entry || !(entry.component instanceof PlanTranscriptEntry)) {
      const component = new PlanTranscriptEntry(this.#sanitize);
      component.setExpanded(true);
      entry = this.#add("plan", component, "active-plan");
      this.#plan = entry;
    }
    const component = entry.component;
    if (!(component instanceof PlanTranscriptEntry)) return;
    component.update(explanation, plan);
    this.#touch(entry);
  }

  setDetailsExpanded(expanded: boolean): void {
    this.#detailsExpanded = expanded;
    for (const entry of this.#entries) {
      if (entry.component instanceof ToolTranscriptEntry) entry.component.setExpanded(expanded);
      if (entry.component instanceof PlanTranscriptEntry) entry.component.setExpanded(expanded);
    }
    this.#onChange();
  }

  toggleDetails(): boolean {
    this.setDetailsExpanded(!this.#detailsExpanded);
    return this.#detailsExpanded;
  }

  toggleTool(runId: string, callId: string): boolean {
    if (!validIdentifier(runId) || !validIdentifier(callId)) return false;
    const entry = this.#tools.get(toolKey(runId, callId));
    if (!entry || !(entry.component instanceof ToolTranscriptEntry)) return false;
    entry.component.toggle();
    this.#onChange();
    return true;
  }

  consumeAgentEvent(event: AgentEvent): void {
    if (!this.#acceptSequence(event.runId, event.sequence)) return;
    switch (event.type) {
      case "run_start":
        this.#completeRunAssistant(event.runId);
        break;
      case "text_delta": {
        let messageId = this.#activeAssistantByRun.get(event.runId);
        if (!messageId) {
          const digest = createHash("sha256").update(event.runId, "utf8").digest("hex").slice(0, 16);
          messageId = `stream:${digest}:${event.sequence}`;
          if (!this.beginAssistant(messageId)) {
            this.addNotice("warning", "assistant_stream", "응답 stream 식별자를 만들지 못했습니다.");
            break;
          }
          this.#activeAssistantByRun.set(event.runId, messageId);
        }
        this.appendAssistant(messageId, event.text);
        break;
      }
      case "tool_start":
        this.#completeRunAssistant(event.runId);
        this.toolStart(event.runId, event.callId, event.toolName, event.input);
        break;
      case "tool_result":
        this.toolResult(event.runId, event.callId, event.toolName, event.result);
        break;
      case "plan_update":
        this.updatePlan(event.explanation, event.plan);
        break;
      case "notice":
        this.addNotice(event.level, event.code, event.message);
        break;
      case "run_end": {
        this.#completeRunAssistant(event.runId);
        const message = runEndNotice(event);
        if (message) this.addNotice(event.termination === "cancelled" ? "info" : "warning", "run_end", message);
        break;
      }
      case "approval_required":
      case "text_complete":
      case "user_input_required":
      case "user_input_result":
      case "usage":
        break;
    }
  }

  restore(records: readonly StoredTranscriptRecord[], display: ResumeTranscriptDisplay): void {
    const selected = records.slice(-MAX_RESTORE_RECORDS);
    let invalidRecords = 0;
    for (const record of selected) {
      try {
        const message = conversationMessageFromTranscript(record);
        if (!message) continue;
        this.#restoreMessage(message, record.runId ?? `resume:${display.sessionId}`);
      } catch {
        invalidRecords += 1;
      }
    }
    if (records.length > selected.length) {
      this.addNotice("warning", "resume_limit", `${records.length - selected.length}개 오래된 record를 화면에서 생략했습니다.`);
    }
    if (invalidRecords > 0) {
      this.addNotice("warning", "resume_invalid", `${invalidRecords}개 transcript record를 화면에 복원하지 못했습니다.`);
    }
    this.addResume({
      ...display,
      restoredRecords: selected.length,
    });
  }

  rawSnapshot(maximumBytes = DEFAULT_RAW_SNAPSHOT_BYTES): RawTranscriptSnapshot {
    const limit = Number.isSafeInteger(maximumBytes) && maximumBytes > 0
      ? Math.min(maximumBytes, DEFAULT_RAW_SNAPSHOT_BYTES)
      : DEFAULT_RAW_SNAPSHOT_BYTES;
    const rows: string[] = [];
    let bytes = 0;
    let truncated = false;
    let includedEntries = 0;
    for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
      const entry = this.#entries[index];
      if (!entry) continue;
      const text = entry.component.rawText();
      const separator = rows.length === 0 ? "" : "\n\n";
      const available = limit - bytes - Buffer.byteLength(separator, "utf8");
      if (available <= 0) {
        truncated = true;
        break;
      }
      const accepted = utf8Prefix(text, available);
      if (accepted || text.length === 0) {
        rows.push(accepted);
        includedEntries += 1;
      }
      bytes += Buffer.byteLength(separator, "utf8") + Buffer.byteLength(accepted, "utf8");
      if (accepted !== text) {
        truncated = true;
        break;
      }
    }
    if (includedEntries < this.#entries.length) truncated = true;
    rows.reverse();
    return Object.freeze({
      text: rows.join("\n\n"),
      truncated,
      entries: this.#entries.length,
      includedEntries,
    });
  }

  finalize(): void {
    for (const entry of this.#assistants.values()) {
      if (!(entry.component instanceof StreamingAssistantEntry) || !entry.component.active) continue;
      entry.component.complete();
      this.#totalBytes += entry.component.byteSize - entry.bytes;
      entry.bytes = entry.component.byteSize;
    }
    this.#activeAssistantByRun.clear();
    this.#prune();
    this.#onChange();
  }

  clear(): void {
    for (const entry of this.#entries) entry.component.dispose();
    this.#entries.length = 0;
    this.#assistants.clear();
    this.#activeAssistantByRun.clear();
    this.#tools.clear();
    this.#lastSequenceByRun.clear();
    this.#plan = undefined;
    this.#totalBytes = 0;
    this.#container.clear();
    this.#onChange();
  }

  #restoreMessage(message: ConversationMessage, runId: string): void {
    if (message.role === "system") return;
    if (message.role === "user") {
      this.addUser(textParts(message));
      return;
    }
    if (message.role === "assistant") {
      const text = textParts(message);
      if (text) this.addAssistant(text);
      for (const part of message.content) {
        if (part.type === "tool_call") {
          this.toolStart(runId, part.callId, part.name, part.input);
        }
      }
      return;
    }
    this.toolResult(runId, message.callId, message.toolName, message.result);
  }

  #add(
    kind: ManagedKind,
    component: TranscriptEntryComponent,
    id?: string,
  ): ManagedEntry {
    this.#makeRoom(component.byteSize);
    const entry: ManagedEntry = {
      kind,
      component,
      bytes: component.byteSize,
      ...(id === undefined ? {} : { id }),
    };
    this.#entries.push(entry);
    this.#totalBytes += entry.bytes;
    this.#container.addChild(component);
    this.#onChange();
    return entry;
  }

  #touch(entry: ManagedEntry): void {
    this.#totalBytes += entry.component.byteSize - entry.bytes;
    entry.bytes = entry.component.byteSize;
    this.#prune();
    this.#onChange();
  }

  #prune(): void {
    while (this.#entries.length > MAX_ENTRIES || this.#totalBytes > MAX_TOTAL_BYTES) {
      let index = this.#entries.findIndex((entry) => !entry.component.active);
      if (index < 0) index = 0;
      if (!this.#removeAt(index)) break;
    }
  }

  #makeRoom(incomingBytes: number): void {
    while (
      this.#entries.length >= MAX_ENTRIES ||
      this.#totalBytes + incomingBytes > MAX_TOTAL_BYTES
    ) {
      let index = this.#entries.findIndex((entry) => !entry.component.active);
      if (index < 0) index = 0;
      if (!this.#removeAt(index)) break;
    }
  }

  #removeAt(index: number): boolean {
    const [removed] = this.#entries.splice(index, 1);
    if (!removed) return false;
    this.#totalBytes -= removed.bytes;
    this.#container.removeChild(removed.component);
    this.#forget(removed);
    removed.component.dispose();
    return true;
  }

  #forget(entry: ManagedEntry): void {
    if (entry.kind === "assistant" && entry.id && this.#assistants.get(entry.id) === entry) {
      this.#assistants.delete(entry.id);
      for (const [runId, messageId] of this.#activeAssistantByRun) {
        if (messageId === entry.id) this.#activeAssistantByRun.delete(runId);
      }
    }
    if (entry.kind === "tool" && entry.id && this.#tools.get(entry.id) === entry) {
      this.#tools.delete(entry.id);
    }
    if (entry.kind === "plan" && this.#plan === entry) this.#plan = undefined;
  }

  #completeRunAssistant(runId: string): void {
    const messageId = this.#activeAssistantByRun.get(runId);
    if (!messageId) return;
    this.completeAssistant(messageId);
    this.#activeAssistantByRun.delete(runId);
  }

  #acceptSequence(runId: string, sequence: number): boolean {
    if (!validIdentifier(runId) || !Number.isSafeInteger(sequence) || sequence < 1) return false;
    const previous = this.#lastSequenceByRun.get(runId) ?? 0;
    if (sequence <= previous) return false;
    if (!this.#lastSequenceByRun.has(runId) && this.#lastSequenceByRun.size >= MAX_TRACKED_RUNS) {
      const oldest = this.#lastSequenceByRun.keys().next().value;
      if (typeof oldest === "string") this.#lastSequenceByRun.delete(oldest);
    }
    this.#lastSequenceByRun.set(runId, sequence);
    return true;
  }
}

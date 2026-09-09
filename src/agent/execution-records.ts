import { ConfigurationError } from "../core/errors.js";
import type { JsonValue } from "../core/json.js";
import type { ToolExecutionResult } from "../core/tools.js";
import type { NormalizedToolCall } from "./tool-calls.js";

export type ToolCallExecutionStatus =
  | "ready"
  | "started"
  | "completed"
  | "not_started"
  | "failed"
  | "unknown"
  | "denied"
  | "cancelled";

export interface ToolCallExecutionRecord {
  readonly runId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly input: NormalizedToolCall["input"];
  readonly fingerprint: string;
  readonly source: NormalizedToolCall["source"];
  readonly status: ToolCallExecutionStatus;
  readonly registeredAt: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly result?: ToolExecutionResult;
}

function freezeJson(value: JsonValue): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    freezeJson(child);
  }
  Object.freeze(value);
}

function cloneJson<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new ConfigurationError("도구 실행 기록을 JSON으로 복제할 수 없습니다.");
  }
  const cloned = JSON.parse(serialized) as T;
  freezeJson(cloned as unknown as JsonValue);
  return cloned;
}

function terminalStatus(
  previous: ToolCallExecutionStatus,
  result: ToolExecutionResult,
): ToolCallExecutionStatus {
  if (result.status === "success") {
    if (previous !== "started") {
      throw new Error("시작 기록이 없는 도구를 완료로 기록할 수 없습니다.");
    }
    return "completed";
  }
  if (result.status === "failure") {
    if (result.execution === "not_started") return "not_started";
    if (previous !== "started") {
      throw new Error("시작 기록이 없는 도구의 부작용 상태를 확정할 수 없습니다.");
    }
    return result.execution;
  }
  if (result.status === "denied") return "denied";
  if (previous === "started") return "unknown";
  return "cancelled";
}

export class ToolCallExecutionLedger {
  readonly #runId: string;
  readonly #now: () => number;
  readonly #records = new Map<string, ToolCallExecutionRecord>();

  constructor(runId: string, now: () => number = Date.now) {
    if (!runId || runId.length > 256 || /[\u0000-\u001f\u007f]/u.test(runId)) {
      throw new ConfigurationError("도구 기록의 runId가 올바르지 않습니다.");
    }
    this.#runId = runId;
    this.#now = now;
  }

  register(calls: readonly NormalizedToolCall[]): void {
    const incoming = new Set<string>();
    for (const call of calls) {
      if (incoming.has(call.callId) || this.#records.has(call.callId)) {
        throw new Error(`도구 호출 ID를 중복 등록할 수 없습니다: ${call.callId}`);
      }
      incoming.add(call.callId);
    }
    const registeredAt = this.#timestamp();
    for (const call of calls) {
      const record: ToolCallExecutionRecord = Object.freeze({
        runId: this.#runId,
        callId: call.callId,
        toolName: call.name,
        input: cloneJson(call.input),
        fingerprint: call.fingerprint,
        source: call.source,
        status: "ready",
        registeredAt,
      });
      this.#records.set(call.callId, record);
    }
  }

  markStarted(callId: string): ToolCallExecutionRecord {
    const previous = this.#required(callId);
    if (previous.status !== "ready") {
      throw new Error(`도구 호출을 다시 시작할 수 없습니다: ${callId}`);
    }
    const record: ToolCallExecutionRecord = Object.freeze({
      ...previous,
      status: "started",
      startedAt: this.#timestamp(),
    });
    this.#records.set(callId, record);
    return record;
  }

  finish(
    callId: string,
    result: ToolExecutionResult,
  ): ToolCallExecutionRecord {
    const previous = this.#required(callId);
    if (previous.status !== "ready" && previous.status !== "started") {
      throw new Error(`도구 호출 결과를 중복 기록할 수 없습니다: ${callId}`);
    }
    const stableResult = cloneJson(result);
    const record: ToolCallExecutionRecord = Object.freeze({
      ...previous,
      status: terminalStatus(previous.status, stableResult),
      finishedAt: this.#timestamp(),
      result: stableResult,
    });
    this.#records.set(callId, record);
    return record;
  }

  interruptUnfinished(reason: string): readonly ToolCallExecutionRecord[] {
    const changed: ToolCallExecutionRecord[] = [];
    for (const record of this.#records.values()) {
      if (record.status !== "ready" && record.status !== "started") continue;
      const result: ToolExecutionResult = record.status === "started"
        ? {
            status: "failure",
            error: {
              code: "tool_result_unknown",
              message: reason,
              retryable: false,
            },
            execution: "unknown",
          }
        : { status: "cancelled", reason };
      changed.push(this.finish(record.callId, result));
    }
    return Object.freeze(changed);
  }

  get(callId: string): ToolCallExecutionRecord | undefined {
    return this.#records.get(callId);
  }

  records(): readonly ToolCallExecutionRecord[] {
    return Object.freeze([...this.#records.values()]);
  }

  #required(callId: string): ToolCallExecutionRecord {
    const record = this.#records.get(callId);
    if (!record) throw new Error(`등록되지 않은 도구 호출입니다: ${callId}`);
    return record;
  }

  #timestamp(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ConfigurationError("도구 실행 기록 시간이 올바르지 않습니다.");
    }
    return value;
  }
}

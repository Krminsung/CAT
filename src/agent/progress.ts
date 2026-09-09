import { createHash } from "node:crypto";
import { ConfigurationError } from "../core/errors.js";
import type { JsonValue } from "../core/json.js";
import type { NormalizedToolCall } from "./tool-calls.js";
import type { ToolCallExecutionRecord } from "./execution-records.js";

export interface RepeatedExecutionBlock {
  readonly fingerprint: string;
  readonly repetitions: number;
  readonly message: string;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new ConfigurationError("도구 결과를 JSON으로 표현할 수 없습니다.");
    }
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(",")}}`;
}

function executionFingerprint(record: ToolCallExecutionRecord): string {
  if (!record.result) {
    throw new Error("결과가 없는 도구 실행은 진전 여부에 반영할 수 없습니다.");
  }
  const serialized = canonicalJson(record.result as unknown as JsonValue);
  return createHash("sha256")
    .update(record.fingerprint, "utf8")
    .update("\0", "utf8")
    .update(serialized, "utf8")
    .digest("hex");
}

export class RepeatedToolExecutionGuard {
  readonly #maximumIdenticalExecutions: number;
  #lastCallFingerprint: string | undefined;
  #lastExecutionFingerprint: string | undefined;
  #repetitions = 0;

  constructor(maximumIdenticalExecutions = 2) {
    if (
      !Number.isSafeInteger(maximumIdenticalExecutions) ||
      maximumIdenticalExecutions < 1 ||
      maximumIdenticalExecutions > 10
    ) {
      throw new ConfigurationError("동일 도구 실행 상한은 1–10 범위의 정수여야 합니다.");
    }
    this.#maximumIdenticalExecutions = maximumIdenticalExecutions;
  }

  blockBefore(call: NormalizedToolCall): RepeatedExecutionBlock | undefined {
    if (
      this.#lastCallFingerprint !== call.fingerprint ||
      this.#repetitions < this.#maximumIdenticalExecutions
    ) {
      return undefined;
    }
    return Object.freeze({
      fingerprint: call.fingerprint,
      repetitions: this.#repetitions,
      message: "동일한 도구·인자·결과가 진전 없이 두 번 반복되어 세 번째 실행 전에 중단했습니다.",
    });
  }

  observe(record: ToolCallExecutionRecord): void {
    const fingerprint = executionFingerprint(record);
    if (fingerprint === this.#lastExecutionFingerprint) {
      this.#repetitions += 1;
    } else {
      this.#lastExecutionFingerprint = fingerprint;
      this.#repetitions = 1;
    }
    this.#lastCallFingerprint = record.fingerprint;
  }
}

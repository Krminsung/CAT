import { createHash } from "node:crypto";
import { ConfigurationError } from "../core/errors.js";
import type { JsonObject, JsonValue } from "../core/json.js";
import type { ProviderToolSpec } from "../core/provider.js";
import { ToolInputValidationError, validateToolInput } from "../tools/schema.js";
import {
  parseTextToolCalls,
  type TextToolFallbackMode,
} from "./fallback-parser.js";

export interface NativeToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: JsonObject;
}

export type NormalizedToolCallSource = "native" | "text_strict" | "text_relaxed";

export interface NormalizedToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: Readonly<JsonObject>;
  readonly source: NormalizedToolCallSource;
  readonly fingerprint: string;
}

export type ToolCallNormalizationIssueKind =
  | "duplicate_call_id"
  | "invalid_call_id"
  | "too_many_calls"
  | "unknown_tool"
  | "invalid_tool_input"
  | "malformed_fallback";

export interface ToolCallNormalizationIssue {
  readonly kind: ToolCallNormalizationIssueKind;
  readonly message: string;
  readonly recoverable: boolean;
  readonly callId?: string;
  readonly toolName?: string;
}

export interface ToolCallNormalizationRequest {
  readonly runId: string;
  readonly turn: number;
  readonly text: string;
  readonly nativeCalls: readonly NativeToolCall[];
  readonly tools: readonly ProviderToolSpec[];
}

export interface ToolCallNormalizationResult {
  readonly calls: readonly NormalizedToolCall[];
  readonly issues: readonly ToolCallNormalizationIssue[];
  readonly visibleText: string;
  readonly fallbackUsed: boolean;
}

export interface ToolCallNormalizerOptions {
  readonly fallbackMode?: TextToolFallbackMode;
  readonly maximumCallsPerResponse?: number;
}

interface CandidateCall {
  readonly callId: string;
  readonly name: string;
  readonly input: JsonObject;
  readonly source: NormalizedToolCallSource;
}

const CALL_ID_PATTERN = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,127}$/u;
const DEFAULT_MAXIMUM_CALLS = 64;

function maximumCalls(value: number | undefined): number {
  const selected = value ?? DEFAULT_MAXIMUM_CALLS;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 256) {
    throw new ConfigurationError("응답별 도구 호출 상한은 1–256 범위의 정수여야 합니다.");
  }
  return selected;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new ConfigurationError("도구 입력을 JSON으로 표현할 수 없습니다.");
    }
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(",")}}`;
}

function freezeJson(value: JsonValue): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    freezeJson(child);
  }
  Object.freeze(value);
}

function cloneInput(value: JsonObject): JsonObject {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new ToolInputValidationError("도구 입력을 JSON으로 복제할 수 없습니다.");
  }
  const cloned = JSON.parse(serialized) as unknown;
  if (typeof cloned !== "object" || cloned === null || Array.isArray(cloned)) {
    throw new ToolInputValidationError("도구 입력은 JSON 객체여야 합니다.");
  }
  freezeJson(cloned as JsonObject);
  return cloned as JsonObject;
}

export function toolCallFingerprint(
  name: string,
  input: Readonly<JsonObject>,
): string {
  return createHash("sha256")
    .update(name, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(input as JsonObject), "utf8")
    .digest("hex");
}

function textCallId(runId: string, turn: number, index: number, text: string): string {
  const runDigest = createHash("sha256").update(runId, "utf8").digest("hex").slice(0, 16);
  const messageDigest = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
  return `text:${runDigest}:${turn}:${index}:${messageDigest}`;
}

function issue(
  kind: ToolCallNormalizationIssueKind,
  message: string,
  recoverable: boolean,
  detail: { callId?: string; toolName?: string } = {},
): ToolCallNormalizationIssue {
  return Object.freeze({ kind, message, recoverable, ...detail });
}

export class ToolCallNormalizer {
  readonly fallbackMode: TextToolFallbackMode;
  readonly maximumCallsPerResponse: number;
  readonly #seenCallIds = new Set<string>();

  constructor(options: ToolCallNormalizerOptions = {}) {
    this.fallbackMode = options.fallbackMode ?? "strict";
    if (!(["disabled", "strict", "relaxed"] as const).includes(this.fallbackMode)) {
      throw new ConfigurationError("텍스트 도구 fallback 모드가 올바르지 않습니다.");
    }
    this.maximumCallsPerResponse = maximumCalls(options.maximumCallsPerResponse);
  }

  normalize(request: ToolCallNormalizationRequest): ToolCallNormalizationResult {
    const candidates: CandidateCall[] = [];
    let fallbackUsed = false;
    let visibleText = request.text;

    if (request.nativeCalls.length > 0) {
      for (const call of request.nativeCalls) {
        candidates.push({ ...call, source: "native" });
      }
    } else {
      const parsed = parseTextToolCalls(request.text, this.fallbackMode);
      if (parsed.kind === "malformed") {
        return Object.freeze({
          calls: Object.freeze([]),
          issues: Object.freeze([
            issue("malformed_fallback", parsed.message, true),
          ]),
          visibleText: "",
          fallbackUsed: true,
        });
      }
      if (parsed.kind === "calls") {
        fallbackUsed = true;
        visibleText = "";
        const source = this.fallbackMode === "relaxed"
          ? "text_relaxed"
          : "text_strict";
        parsed.calls.forEach((call, index) => {
          candidates.push({
            ...call,
            callId: textCallId(request.runId, request.turn, index + 1, request.text),
            source,
          });
        });
      }
    }

    if (candidates.length === 0) {
      return Object.freeze({
        calls: Object.freeze([]),
        issues: Object.freeze([]),
        visibleText,
        fallbackUsed,
      });
    }
    if (candidates.length > this.maximumCallsPerResponse) {
      return Object.freeze({
        calls: Object.freeze([]),
        issues: Object.freeze([
          issue(
            "too_many_calls",
            `한 응답의 도구 호출이 ${this.maximumCallsPerResponse}개 상한을 초과했습니다.`,
            false,
          ),
        ]),
        visibleText: fallbackUsed ? "" : visibleText,
        fallbackUsed,
      });
    }

    const callIdIssue = this.#reserveCallIds(candidates.map((call) => call.callId));
    if (callIdIssue) {
      return Object.freeze({
        calls: Object.freeze([]),
        issues: Object.freeze([callIdIssue]),
        visibleText: fallbackUsed ? "" : visibleText,
        fallbackUsed,
      });
    }

    const definitions = new Map<string, ProviderToolSpec>();
    for (const tool of request.tools) {
      if (definitions.has(tool.name)) {
        throw new ConfigurationError(`provider 도구 정의가 중복됐습니다: ${tool.name}`);
      }
      definitions.set(tool.name, tool);
    }

    const calls: NormalizedToolCall[] = [];
    const issues: ToolCallNormalizationIssue[] = [];
    for (const candidate of candidates) {
      if (!TOOL_NAME_PATTERN.test(candidate.name)) {
        issues.push(issue(
          "unknown_tool",
          "도구 이름이 올바르지 않거나 등록되지 않았습니다.",
          true,
          { callId: candidate.callId, toolName: candidate.name },
        ));
        continue;
      }
      const definition = definitions.get(candidate.name);
      if (!definition) {
        issues.push(issue(
          "unknown_tool",
          `등록되지 않았거나 비활성화된 도구입니다: ${candidate.name}`,
          true,
          { callId: candidate.callId, toolName: candidate.name },
        ));
        continue;
      }
      try {
        const input = cloneInput(
          validateToolInput(
            candidate.input,
            definition.inputSchema,
            candidate.name,
          ),
        );
        calls.push(Object.freeze({
          callId: candidate.callId,
          name: candidate.name,
          input,
          source: candidate.source,
          fingerprint: toolCallFingerprint(candidate.name, input),
        }));
      } catch (error) {
        const message = error instanceof ToolInputValidationError
          ? error.message
          : `${candidate.name} 입력을 검증하지 못했습니다.`;
        issues.push(issue(
          "invalid_tool_input",
          message,
          true,
          { callId: candidate.callId, toolName: candidate.name },
        ));
      }
    }

    return Object.freeze({
      calls: Object.freeze(calls),
      issues: Object.freeze(issues),
      visibleText,
      fallbackUsed,
    });
  }

  #reserveCallIds(
    callIds: readonly string[],
  ): ToolCallNormalizationIssue | undefined {
    const current = new Set<string>();
    for (const callId of callIds) {
      if (!CALL_ID_PATTERN.test(callId) || callId.trim() !== callId) {
        return issue(
          "invalid_call_id",
          "모델 도구 호출 ID가 비어 있거나 올바르지 않습니다.",
          false,
          { callId },
        );
      }
      if (current.has(callId) || this.#seenCallIds.has(callId)) {
        return issue(
          "duplicate_call_id",
          "같은 run에서 모델 도구 호출 ID가 중복되었습니다. 이 응답의 도구는 실행하지 않습니다.",
          false,
          { callId },
        );
      }
      current.add(callId);
    }
    for (const callId of current) this.#seenCallIds.add(callId);
    return undefined;
  }
}

import { createHash } from "node:crypto";
import { ConfigurationError } from "../core/errors.js";
import type { JsonObject, JsonValue } from "../core/json.js";
import type {
  AssistantMessage,
  ConversationMessage,
  SystemMessage,
  ToolCallContent,
  ToolMessage,
} from "../core/messages.js";
import type { ToolExecutionResult } from "../core/tools.js";
import { Redactor } from "../security/redaction.js";
import type { StoredTranscriptRecord } from "../storage/sessions.js";
import {
  estimateConversationTokens,
  evaluateAutoCompact,
  normalizeModelContextInfo,
  type AutoCompactDecision,
  type ModelContextInfo,
} from "./model-context.js";
import {
  conversationMessageFromJson,
  conversationMessageFromTranscript,
  conversationMessageToJson,
  toolExecutionResultFromJson,
  toolExecutionResultToJson,
} from "./transcript.js";

export const COMPACTION_RECORD_SCHEMA_VERSION = 1;

const DEFAULT_MAX_SOURCE_RECORDS = 100_000;
const DEFAULT_MAX_RETAINED_UNITS = 4_000;
const DEFAULT_MAX_RETAINED_MESSAGES = 5_000;
const DEFAULT_MAX_RETAINED_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_PROJECTED_MESSAGES = 800;
const DEFAULT_MAX_PROJECTED_BYTES = 6 * 1024 * 1024;
const DEFAULT_MAX_OBSERVATION_BYTES = 64 * 1024;
const DEFAULT_MAX_SINGLE_OBSERVATION_BYTES = 8 * 1024;
const DEFAULT_MAX_HISTORICAL_TEXT_BYTES = 128 * 1024;
const DEFAULT_MAX_SYSTEM_MESSAGES = 32;
const DEFAULT_MAX_SYSTEM_BYTES = 512 * 1024;
const MAX_PROJECTION_WARNINGS = 128;
const MAX_PROJECTION_WARNING_BYTES = 8 * 1024;
const MAX_INCOMPLETE_TOOL_REFERENCES = 12;
const MAX_COMPACTION_SUMMARY_BYTES = 256 * 1024;
const MAX_COMPACTION_PRESERVED_MESSAGES = 64;
const MAX_COMPACTION_PRESERVED_BYTES = 4 * 1024 * 1024;
const MAX_REDACTION_SECRETS = 256;
const MIN_REDACTION_SECRET_BYTES = 8;
const MAX_REDACTION_SECRET_BYTES = 64 * 1024;
const MAX_REDACTION_SECRETS_BYTES = 1024 * 1024;
const REDACTION_MARKER = "[REDACTED]";
const MIN_OBSERVATION_BYTES = 512;
const SHORTEN_MARKER = "\n[Historical content shortened; consult the source transcript if needed.]\n";

export interface ContextProjectionLimits {
  readonly maxSourceRecords?: number;
  readonly maxRetainedUnits?: number;
  readonly maxRetainedMessages?: number;
  readonly maxRetainedBytes?: number;
  readonly maxProjectedMessages?: number;
  readonly maxProjectedBytes?: number;
  readonly maxObservationBytes?: number;
  readonly maxSingleObservationBytes?: number;
  readonly maxHistoricalTextBytes?: number;
  readonly maxSystemMessages?: number;
  readonly maxSystemBytes?: number;
}

export interface ModelContextProjectorOptions {
  readonly context: ModelContextInfo;
  readonly secrets?: readonly string[];
  readonly limits?: ContextProjectionLimits;
}

export interface ContextProjectionWarning {
  readonly code:
    | "invalid_message_record"
    | "invalid_compaction_record"
    | "incomplete_tool_exchange"
    | "orphan_tool_result"
    | "tool_result_mismatch"
    | "untrusted_system_message"
    | "retention_limit"
    | "omitted_warnings";
  readonly message: string;
}

export type ContextProjectionRequirement =
  | "auto_compaction_threshold"
  | "retention_limit"
  | "projection_limit"
  | "trusted_system_limit"
  | "empty_projection";

export interface ModelContextProjection {
  readonly messages: readonly ConversationMessage[];
  readonly context: ModelContextInfo;
  readonly sourceEstimatedTokens: number;
  readonly projectedEstimatedTokens: number;
  readonly autoCompact: AutoCompactDecision;
  readonly readyForModel: boolean;
  readonly requirements: readonly ContextProjectionRequirement[];
  readonly truncated: boolean;
  readonly omittedHistoryUnits: number;
  readonly droppedIncompleteToolExchanges: number;
  readonly droppedOrphanToolResults: number;
  readonly truncatedObservations: number;
  readonly observationBytes: number;
  readonly warnings: readonly ContextProjectionWarning[];
}

interface ResolvedLimits {
  readonly maxSourceRecords: number;
  readonly maxRetainedUnits: number;
  readonly maxRetainedMessages: number;
  readonly maxRetainedBytes: number;
  readonly maxProjectedMessages: number;
  readonly maxProjectedBytes: number;
  readonly maxObservationBytes: number;
  readonly maxSingleObservationBytes: number;
  readonly maxHistoricalTextBytes: number;
  readonly maxSystemMessages: number;
  readonly maxSystemBytes: number;
}

interface HistoryUnit {
  readonly messages: readonly ConversationMessage[];
  readonly bytes: number;
  readonly tokens: number;
  readonly toolResults: number;
}

interface PendingToolExchange {
  readonly assistant: AssistantMessage;
  readonly expected: ReadonlyMap<string, string>;
  readonly results: ToolMessage[];
  readonly received: Set<string>;
  bytes: number;
}

interface CompactionBoundary {
  readonly id: string;
  readonly createdAt: number;
  readonly summary: string;
  readonly preservedMessages: readonly ConversationMessage[];
}

interface ProjectedUnit {
  readonly messages: readonly ConversationMessage[];
  readonly observationBytes: number;
  readonly truncatedObservations: number;
  readonly textTruncated: boolean;
}

function integer(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new ConfigurationError(`${label}은 ${minimum}–${maximum} 범위의 정수여야 합니다.`);
  }
  return selected;
}

function resolveLimits(input: ContextProjectionLimits = {}): ResolvedLimits {
  const maxObservationBytes = integer(
    input.maxObservationBytes,
    DEFAULT_MAX_OBSERVATION_BYTES,
    MIN_OBSERVATION_BYTES,
    4 * 1024 * 1024,
    "관찰 전체 byte",
  );
  const maxSingleObservationBytes = integer(
    input.maxSingleObservationBytes,
    DEFAULT_MAX_SINGLE_OBSERVATION_BYTES,
    MIN_OBSERVATION_BYTES,
    Math.min(maxObservationBytes, 1024 * 1024),
    "관찰 개별 byte",
  );
  return Object.freeze({
    maxSourceRecords: integer(
      input.maxSourceRecords,
      DEFAULT_MAX_SOURCE_RECORDS,
      1,
      1_000_000,
      "Projection source record 수",
    ),
    maxRetainedUnits: integer(
      input.maxRetainedUnits,
      DEFAULT_MAX_RETAINED_UNITS,
      1,
      20_000,
      "Projection 보존 unit 수",
    ),
    maxRetainedMessages: integer(
      input.maxRetainedMessages,
      DEFAULT_MAX_RETAINED_MESSAGES,
      1,
      20_000,
      "Projection 보존 message 수",
    ),
    maxRetainedBytes: integer(
      input.maxRetainedBytes,
      DEFAULT_MAX_RETAINED_BYTES,
      64 * 1024,
      64 * 1024 * 1024,
      "Projection 보존 byte",
    ),
    maxProjectedMessages: integer(
      input.maxProjectedMessages,
      DEFAULT_MAX_PROJECTED_MESSAGES,
      1,
      1_000,
      "모델 projection message 수",
    ),
    maxProjectedBytes: integer(
      input.maxProjectedBytes,
      DEFAULT_MAX_PROJECTED_BYTES,
      64 * 1024,
      8 * 1024 * 1024,
      "모델 projection byte",
    ),
    maxObservationBytes,
    maxSingleObservationBytes,
    maxHistoricalTextBytes: integer(
      input.maxHistoricalTextBytes,
      DEFAULT_MAX_HISTORICAL_TEXT_BYTES,
      1_024,
      1024 * 1024,
      "역사 message text byte",
    ),
    maxSystemMessages: integer(
      input.maxSystemMessages,
      DEFAULT_MAX_SYSTEM_MESSAGES,
      1,
      128,
      "신뢰된 system message 수",
    ),
    maxSystemBytes: integer(
      input.maxSystemBytes,
      DEFAULT_MAX_SYSTEM_BYTES,
      1_024,
      2 * 1024 * 1024,
      "신뢰된 system message byte",
    ),
  });
}

function serializedBytes(value: unknown, label: string): number {
  let serialized: string;
  try {
    const candidate = JSON.stringify(value);
    if (candidate === undefined) throw new Error("undefined_json");
    serialized = candidate;
  } catch {
    throw new ConfigurationError(`${label}을 JSON으로 직렬화할 수 없습니다.`);
  }
  return Buffer.byteLength(serialized, "utf8");
}

function messageBytes(messages: readonly ConversationMessage[]): number {
  return serializedBytes(messages, "Projection message");
}

export function normalizeContextRedactionSecrets(
  secrets: readonly string[] | undefined,
): readonly string[] {
  if (secrets === undefined) return Object.freeze([]);
  if (!Array.isArray(secrets) || secrets.length > MAX_REDACTION_SECRETS) {
    throw new ConfigurationError("Projection redaction secret 수가 너무 많습니다.");
  }
  let totalBytes = 0;
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const secret of secrets) {
    if (typeof secret !== "string") {
      throw new ConfigurationError("Projection redaction secret 형식이 올바르지 않습니다.");
    }
    if (!secret || seen.has(secret)) continue;
    const bytes = Buffer.byteLength(secret, "utf8");
    if (bytes < MIN_REDACTION_SECRET_BYTES || REDACTION_MARKER.includes(secret)) {
      throw new ConfigurationError("Projection redaction secret이 너무 짧거나 안전하지 않습니다.");
    }
    if (bytes > MAX_REDACTION_SECRET_BYTES) {
      throw new ConfigurationError("Projection redaction secret 하나가 너무 큽니다.");
    }
    totalBytes += bytes;
    if (totalBytes > MAX_REDACTION_SECRETS_BYTES) {
      throw new ConfigurationError("Projection redaction secret 전체 크기가 너무 큽니다.");
    }
    seen.add(secret);
    selected.push(secret);
  }
  return Object.freeze(selected);
}

function toolCalls(message: AssistantMessage): readonly ToolCallContent[] {
  return message.content.filter(
    (part): part is ToolCallContent => part.type === "tool_call",
  );
}

function boundedUtf8(value: string, maximumBytes: number): {
  readonly text: string;
  readonly omittedBytes: number;
} {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return { text: value, omittedBytes: 0 };
  const marker = Buffer.from(SHORTEN_MARKER, "utf8");
  if (maximumBytes <= marker.byteLength) {
    let end = maximumBytes;
    while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
    return {
      text: bytes.subarray(0, end).toString("utf8"),
      omittedBytes: bytes.byteLength - end,
    };
  }
  const keep = maximumBytes - marker.byteLength;
  let headEnd = Math.floor(keep / 2);
  while (
    headEnd > 0 &&
    (bytes[headEnd] ?? 0) >= 0x80 &&
    (bytes[headEnd] ?? 0) < 0xc0
  ) {
    headEnd -= 1;
  }
  let tailStart = bytes.byteLength - Math.ceil(keep / 2);
  while (
    tailStart < bytes.byteLength &&
    (bytes[tailStart] ?? 0) >= 0x80 &&
    (bytes[tailStart] ?? 0) < 0xc0
  ) {
    tailStart += 1;
  }
  return {
    text: bytes.subarray(0, headEnd).toString("utf8") +
      marker.toString("utf8") +
      bytes.subarray(tailStart).toString("utf8"),
    omittedBytes: bytes.byteLength - headEnd - (bytes.byteLength - tailStart),
  };
}

function redactJson(value: JsonValue, redactor: Redactor): JsonValue {
  if (typeof value === "string") return redactor.redact(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const output = value.map((item) => redactJson(item, redactor));
    Object.freeze(output);
    return output;
  }
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = redactJson(item, redactor);
  }
  Object.freeze(output);
  return output;
}

function redactObject(value: JsonObject, redactor: Redactor): JsonObject {
  const redacted = redactJson(value, redactor);
  if (redacted === null || typeof redacted !== "object" || Array.isArray(redacted)) {
    throw new ConfigurationError("Redaction 결과가 JSON 객체가 아닙니다.");
  }
  return redacted;
}

function projectedToolResult(
  result: ToolExecutionResult,
  maximumBytes: number,
  redactor: Redactor,
): { readonly result: ToolExecutionResult; readonly bytes: number; readonly truncated: boolean } {
  const safeJson = redactObject(toolExecutionResultToJson(result), redactor);
  const serialized = JSON.stringify(safeJson);
  if (serialized === undefined) {
    throw new ConfigurationError("모델용 tool observation을 직렬화할 수 없습니다.");
  }
  const safeBytes = Buffer.byteLength(serialized, "utf8");
  if (safeBytes <= maximumBytes) {
    return Object.freeze({
      result: toolExecutionResultFromJson(safeJson),
      bytes: safeBytes,
      truncated: false,
    });
  }
  const previewLimit = Math.max(64, maximumBytes - 384);
  const preview = boundedUtf8(serialized, previewLimit);
  const omittedBytes = Math.max(0, safeBytes - Buffer.byteLength(preview.text, "utf8"));
  const notice = `Older tool observation shortened by ${omittedBytes} bytes.`;
  let shortened: ToolExecutionResult;
  if (result.status === "success") {
    shortened = {
      status: "success",
      output: {
        content: { observationPreview: preview.text, notice },
        truncated: true,
        omittedBytes,
      },
    };
  } else if (result.status === "failure") {
    shortened = {
      status: "failure",
      error: {
        code: boundedUtf8(redactor.redact(result.error.code), 64).text || "tool_failure",
        message: boundedUtf8(redactor.redact(result.error.message), 128).text || notice,
        retryable: result.error.retryable,
        details: { observationPreview: preview.text, notice },
      },
      execution: result.execution,
    };
  } else if (result.status === "denied") {
    shortened = {
      status: "denied",
      reason: boundedUtf8(redactor.redact(result.reason), Math.max(64, maximumBytes - 128)).text,
    };
  } else {
    const reason = result.reason === undefined
      ? notice
      : boundedUtf8(redactor.redact(result.reason), Math.max(64, maximumBytes - 128)).text;
    shortened = { status: "cancelled", reason };
  }
  let normalized = toolExecutionResultFromJson(shortened);
  let bytes = serializedBytes(
    toolExecutionResultToJson(normalized),
    "축약된 모델용 tool observation",
  );
  if (bytes > maximumBytes) {
    const minimalNotice = `Older tool observation omitted (${safeBytes} bytes).`;
    const minimal: ToolExecutionResult = result.status === "success"
      ? {
          status: "success",
          output: {
            content: { notice: minimalNotice },
            truncated: true,
            omittedBytes: safeBytes,
          },
        }
      : result.status === "failure"
        ? {
            status: "failure",
            error: {
              code: "tool_failure",
              message: minimalNotice,
              retryable: result.error.retryable,
            },
            execution: result.execution,
          }
        : result.status === "denied"
          ? { status: "denied", reason: minimalNotice }
          : { status: "cancelled", reason: minimalNotice };
    normalized = toolExecutionResultFromJson(minimal);
    bytes = serializedBytes(
      toolExecutionResultToJson(normalized),
      "최소 모델용 tool observation",
    );
    if (bytes > maximumBytes) {
      throw new ConfigurationError("최소 tool observation이 projection 상한을 초과했습니다.");
    }
  }
  return Object.freeze({ result: normalized, bytes, truncated: true });
}

function projectedNonToolMessage(
  message: Exclude<ConversationMessage, ToolMessage>,
  redactor: Redactor,
  maximumTextBytes: number,
): { readonly message: Exclude<ConversationMessage, ToolMessage>; readonly truncated: boolean } {
  let truncated = false;
  const content = message.content.map((part) => {
    if (part.type === "text") {
      const bounded = boundedUtf8(redactor.redact(part.text), maximumTextBytes);
      if (bounded.omittedBytes > 0) truncated = true;
      return { type: "text" as const, text: bounded.text };
    }
    return {
      type: "tool_call" as const,
      callId: redactor.redact(part.callId),
      name: redactor.redact(part.name),
      input: redactObject(part.input, redactor),
    };
  });
  const projected = conversationMessageFromJson({
    role: message.role,
    id: redactor.redact(message.id),
    createdAt: message.createdAt,
    content,
  });
  if (projected.role === "tool") {
    throw new ConfigurationError("일반 message projection이 tool message로 바뀌었습니다.");
  }
  return Object.freeze({ message: projected, truncated });
}

function compactionBoundary(record: StoredTranscriptRecord): CompactionBoundary | undefined {
  if (record.kind !== "compaction") return undefined;
  const data = record.data;
  if (data.status !== "completed") return undefined;
  if (data.compactionSchemaVersion !== COMPACTION_RECORD_SCHEMA_VERSION) {
    throw new ConfigurationError("Compaction record schema version이 올바르지 않습니다.");
  }
  if (
    typeof data.summary !== "string" ||
    !data.summary.trim() ||
    Buffer.byteLength(data.summary, "utf8") > MAX_COMPACTION_SUMMARY_BYTES
  ) {
    throw new ConfigurationError("Compaction summary 형식 또는 크기가 올바르지 않습니다.");
  }
  const preserved = data.preservedMessages ?? [];
  if (!Array.isArray(preserved) || preserved.length > MAX_COMPACTION_PRESERVED_MESSAGES) {
    throw new ConfigurationError("Compaction preserved message 수가 올바르지 않습니다.");
  }
  const preservedMessages = preserved.map((item) => conversationMessageFromJson(item));
  if (messageBytes(preservedMessages) > MAX_COMPACTION_PRESERVED_BYTES) {
    throw new ConfigurationError("Compaction preserved message 전체 크기가 너무 큽니다.");
  }
  const createdAt = Date.parse(record.createdAt);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new ConfigurationError("Compaction record 시간이 올바르지 않습니다.");
  }
  return Object.freeze({
    id: `compaction:${record.recordId}`,
    createdAt,
    summary: data.summary,
    preservedMessages: Object.freeze(preservedMessages),
  });
}

export class ModelContextProjector {
  readonly #unresolvedExecutions = new Map<string, { toolName: string; callId: string; createdAt: number }>();
  readonly #context: ModelContextInfo;
  readonly #limits: ResolvedLimits;
  readonly #redactor: Redactor;
  readonly #trustedSystems: SystemMessage[] = [];
  readonly #units: HistoryUnit[] = [];
  readonly #warnings: ContextProjectionWarning[] = [];
  #unitStart = 0;
  #retainedBytes = 0;
  #retainedMessages = 0;
  #sourceRecords = 0;
  #sourceTokens = 0;
  #omittedUnits = 0;
  #droppedIncomplete = 0;
  #droppedOrphans = 0;
  #omittedWarnings = 0;
  #pending: PendingToolExchange | undefined;
  #compaction: CompactionBoundary | undefined;
  #systemBytes = 0;
  #finished = false;

  constructor(options: ModelContextProjectorOptions) {
    this.#context = normalizeModelContextInfo(options.context);
    this.#limits = resolveLimits(options.limits);
    this.#redactor = new Redactor(normalizeContextRedactionSecrets(options.secrets));
  }

  addTrustedSystem(message: SystemMessage): void {
    this.#assertMutable();
    const normalized = conversationMessageFromJson(message);
    if (normalized.role !== "system") {
      throw new ConfigurationError("신뢰된 system projection에는 system message만 넣을 수 있습니다.");
    }
    const bytes = messageBytes([normalized]);
    if (
      this.#trustedSystems.length >= this.#limits.maxSystemMessages ||
      this.#systemBytes + bytes > this.#limits.maxSystemBytes
    ) {
      throw new ConfigurationError("신뢰된 system message 상한을 초과했습니다.");
    }
    this.#trustedSystems.push(normalized);
    this.#systemBytes += bytes;
  }

  pushRecord(record: StoredTranscriptRecord): void {
    this.#assertMutable();
    this.#sourceRecords += 1;
    if (this.#sourceRecords > this.#limits.maxSourceRecords) {
      throw new ConfigurationError("Projection source transcript record 상한을 초과했습니다.");
    }
    if (record.kind === "agent_event") {
      const event = record.data.event;
      if (!event || typeof event !== "object" || Array.isArray(event)) return;
      const { runId, callId, toolName } = event;
      if (typeof runId !== "string" || typeof callId !== "string" || typeof toolName !== "string" ||
        runId.length > 256 || callId.length > 256 || toolName.length > 256) return;
      const key = JSON.stringify([runId, callId]);
      if (event.type === "tool_start") {
        if (this.#unresolvedExecutions.size >= 256 && !this.#unresolvedExecutions.has(key)) {
          throw new ConfigurationError("실행 결과가 없는 기록이 너무 많습니다. 세션 상태를 직접 확인하세요.");
        }
        this.#unresolvedExecutions.set(key, { toolName, callId, createdAt: Date.parse(record.createdAt) });
      } else if (event.type === "tool_result" && this.#unresolvedExecutions.get(key)?.toolName === toolName) {
        this.#unresolvedExecutions.delete(key);
      }
      return;
    }
    if (record.kind === "compaction") {
      try {
        const boundary = compactionBoundary(record);
        if (boundary) this.#applyCompaction(boundary);
      } catch (error) {
        this.#warn(
          "invalid_compaction_record",
          error instanceof Error ? error.message : "Compaction record를 해석하지 못했습니다.",
        );
      }
      return;
    }
    if (record.kind !== "message") return;
    try {
      const message = conversationMessageFromTranscript(record);
      if (message) this.#acceptMessage(message, false);
    } catch (error) {
      this.#warn(
        "invalid_message_record",
        error instanceof Error ? error.message : "Message record를 해석하지 못했습니다.",
      );
    }
  }

  pushMessage(message: ConversationMessage): void {
    this.#assertMutable();
    this.#acceptMessage(conversationMessageFromJson(message), false);
  }

  finish(): ModelContextProjection {
    this.#assertMutable();
    this.#finished = true;
    this.#discardPending("Transcript 끝에 완료되지 않은 tool call/result가 있습니다.");
    if (this.#unresolvedExecutions.size > 0) {
      const unresolved = [...this.#unresolvedExecutions.values()];
      const names = unresolved.slice(0, MAX_INCOMPLETE_TOOL_REFERENCES)
        .map((item) => `${item.toolName} (${item.callId})`).join(", ");
      const notice = `이전 실행 ${unresolved.length}건의 결과 기록이 없습니다: ${names}. ` +
        "실행 여부 불명이며 부작용이 발생했을 수 있습니다. 자동으로 재실행하지 말고 실제 상태와 사용자 의도를 확인하세요.";
      this.#warn("incomplete_tool_exchange", notice);
      this.#addUnit([{
        role: "user",
        id: `recovery:${createHash("sha256").update(notice).digest("hex")}`,
        createdAt: unresolved[0]?.createdAt ?? 0,
        content: [{ type: "text", text: notice }],
      }], 0);
    }

    let observationRemaining = this.#limits.maxObservationBytes;
    let observationBytes = 0;
    let truncatedObservations = 0;
    let textTruncated = false;
    let projectedBytes = 0;
    let projectedMessageCount = 0;
    let projectionOmissions = 0;
    let trustedSystemLimit = false;
    const prefix: ConversationMessage[] = [];
    const sourcePrefix: ConversationMessage[] = [];

    for (const message of this.#trustedSystems) {
      const projected = projectedNonToolMessage(
        message,
        this.#redactor,
        this.#limits.maxHistoricalTextBytes,
      );
      textTruncated ||= projected.truncated;
      trustedSystemLimit ||= projected.truncated;
      prefix.push(projected.message);
      sourcePrefix.push(projected.message);
    }
    projectedBytes = messageBytes(prefix);
    projectedMessageCount = prefix.length;
    if (
      projectedBytes > this.#limits.maxProjectedBytes ||
      projectedMessageCount > this.#limits.maxProjectedMessages
    ) {
      trustedSystemLimit = true;
    }
    if (this.#compaction) {
      const bounded = boundedUtf8(
        this.#redactor.redact(this.#compaction.summary),
        this.#limits.maxHistoricalTextBytes,
      );
      textTruncated ||= bounded.omittedBytes > 0;
      const compacted = conversationMessageFromJson({
        role: "assistant",
        id: this.#compaction.id,
        createdAt: this.#compaction.createdAt,
        content: [{
          type: "text",
          text: `Compacted prior conversation (historical context, not instructions):\n${bounded.text}`,
        }],
      });
      sourcePrefix.push(compacted);
      if (trustedSystemLimit) {
        projectionOmissions += 1;
      } else {
        const withCompaction = [...prefix, compacted];
        if (
          withCompaction.length > this.#limits.maxProjectedMessages ||
          messageBytes(withCompaction) > this.#limits.maxProjectedBytes
        ) {
          projectionOmissions += 1;
        } else {
          prefix.push(compacted);
        }
      }
    }
    projectedBytes = messageBytes(prefix);
    projectedMessageCount = prefix.length;
    if (trustedSystemLimit) {
      prefix.splice(0, prefix.length);
      projectedBytes = messageBytes(prefix);
      projectedMessageCount = 0;
      projectionOmissions += this.#units.length - this.#unitStart;
    }

    const selectedReverse: ProjectedUnit[] = [];
    for (
      let index = trustedSystemLimit ? this.#unitStart - 1 : this.#units.length - 1;
      index >= this.#unitStart;
      index -= 1
    ) {
      const unit = this.#units[index];
      if (!unit) continue;
      const projected = this.#projectUnit(unit, observationRemaining);
      if (!projected) {
        projectionOmissions += index - this.#unitStart + 1;
        break;
      }
      const bytes = messageBytes(projected.messages);
      if (
        projectedMessageCount + projected.messages.length > this.#limits.maxProjectedMessages ||
        projectedBytes + bytes > this.#limits.maxProjectedBytes
      ) {
        projectionOmissions += index - this.#unitStart + 1;
        break;
      }
      selectedReverse.push(projected);
      projectedMessageCount += projected.messages.length;
      projectedBytes += bytes;
      observationRemaining -= projected.observationBytes;
      observationBytes += projected.observationBytes;
      truncatedObservations += projected.truncatedObservations;
      textTruncated ||= projected.textTruncated;
    }

    const messages: ConversationMessage[] = [...prefix];
    for (const unit of selectedReverse.reverse()) messages.push(...unit.messages);
    const projectedEstimatedTokens = estimateConversationTokens(messages);
    const sourceEstimatedTokens =
      this.#sourceTokens + estimateConversationTokens(sourcePrefix);
    if (!Number.isSafeInteger(sourceEstimatedTokens)) {
      throw new ConfigurationError("Projection source token 추정값이 너무 큽니다.");
    }
    const autoCompact = evaluateAutoCompact(this.#context, sourceEstimatedTokens);
    const requirements: ContextProjectionRequirement[] = [];
    if (autoCompact.state === "required") requirements.push("auto_compaction_threshold");
    if (this.#omittedUnits > 0) requirements.push("retention_limit");
    if (projectionOmissions > 0) requirements.push("projection_limit");
    if (trustedSystemLimit) requirements.push("trusted_system_limit");
    if (messages.length === 0) requirements.push("empty_projection");
    const uniqueRequirements = Object.freeze([...new Set(requirements)]);
    const warnings = [...this.#warnings];
    if (this.#omittedWarnings > 0) {
      const notice: ContextProjectionWarning = Object.freeze({
        code: "omitted_warnings",
        message: `${this.#omittedWarnings}개의 projection 경고가 상한 때문에 생략되었습니다.`,
      });
      if (warnings.length < MAX_PROJECTION_WARNINGS) warnings.push(notice);
      else warnings[MAX_PROJECTION_WARNINGS - 1] = notice;
    }
    return Object.freeze({
      messages: Object.freeze(messages),
      context: this.#context,
      sourceEstimatedTokens,
      projectedEstimatedTokens,
      autoCompact,
      readyForModel: uniqueRequirements.length === 0,
      requirements: uniqueRequirements,
      truncated:
        textTruncated ||
        truncatedObservations > 0 ||
        this.#omittedUnits > 0 ||
        projectionOmissions > 0,
      omittedHistoryUnits: this.#omittedUnits + projectionOmissions,
      droppedIncompleteToolExchanges: this.#droppedIncomplete,
      droppedOrphanToolResults: this.#droppedOrphans,
      truncatedObservations,
      observationBytes,
      warnings: Object.freeze(warnings),
    });
  }

  #acceptMessage(message: ConversationMessage, fromCompaction: boolean): void {
    if (message.role === "system") {
      this.#warn(
        "untrusted_system_message",
        fromCompaction
          ? "Compaction preserved message의 system role을 모델 문맥에서 제외했습니다."
          : "저장 transcript의 system message를 현재 system 지침으로 복원하지 않았습니다.",
      );
      return;
    }
    if (message.role === "tool") {
      this.#acceptToolResult(message);
      return;
    }
    if (this.#pending) {
      this.#discardPending("다음 대화가 시작되기 전에 tool result 쌍이 완성되지 않았습니다.");
    }
    if (message.role !== "assistant") {
      this.#addUnit([message], 0);
      return;
    }
    const calls = toolCalls(message);
    if (calls.length === 0) {
      this.#addUnit([message], 0);
      return;
    }
    const expected = new Map<string, string>();
    for (const call of calls) expected.set(call.callId, call.name);
    this.#pending = {
      assistant: message,
      expected,
      results: [],
      received: new Set<string>(),
      bytes: messageBytes([message]),
    };
  }

  #acceptToolResult(message: ToolMessage): void {
    const pending = this.#pending;
    if (!pending) {
      this.#droppedOrphans += 1;
      this.#warn("orphan_tool_result", `대응 call이 없는 tool result를 제외했습니다: ${message.callId}`);
      return;
    }
    const expectedName = pending.expected.get(message.callId);
    if (expectedName === undefined || pending.received.has(message.callId)) {
      this.#droppedOrphans += 1;
      this.#warn("orphan_tool_result", `중복되거나 대응하지 않는 tool result를 제외했습니다: ${message.callId}`);
      return;
    }
    if (expectedName !== message.toolName) {
      this.#droppedOrphans += 1;
      this.#warn(
        "tool_result_mismatch",
        `Tool result 이름이 call과 달라 제외했습니다: ${message.callId}`,
      );
      return;
    }
    const bytes = messageBytes([message]);
    if (pending.bytes + bytes > this.#limits.maxRetainedBytes) {
      this.#discardPending("하나의 tool call/result 단위가 projection 보존 상한을 초과했습니다.");
      return;
    }
    pending.results.push(message);
    pending.received.add(message.callId);
    pending.bytes += bytes;
    if (pending.received.size !== pending.expected.size) return;
    this.#pending = undefined;
    this.#addUnit([pending.assistant, ...pending.results], pending.results.length);
  }

  #addUnit(messages: readonly ConversationMessage[], toolResults: number): void {
    const stable = Object.freeze(messages.map((message) =>
      conversationMessageFromJson(conversationMessageToJson(message))
    ));
    const bytes = messageBytes(stable);
    const tokens = estimateConversationTokens(stable);
    this.#sourceTokens += tokens;
    if (!Number.isSafeInteger(this.#sourceTokens)) {
      throw new ConfigurationError("Projection source token 추정값이 너무 큽니다.");
    }
    if (
      bytes > this.#limits.maxRetainedBytes ||
      stable.length > this.#limits.maxRetainedMessages
    ) {
      this.#omittedUnits += 1;
      this.#warn("retention_limit", "대화 단위 하나가 projection 보존 상한을 초과했습니다.");
      return;
    }
    while (
      this.#units.length - this.#unitStart >= this.#limits.maxRetainedUnits ||
      this.#retainedMessages + stable.length > this.#limits.maxRetainedMessages ||
      this.#retainedBytes + bytes > this.#limits.maxRetainedBytes
    ) {
      const removed = this.#units[this.#unitStart];
      if (!removed) break;
      this.#retainedBytes -= removed.bytes;
      this.#retainedMessages -= removed.messages.length;
      this.#unitStart += 1;
      this.#omittedUnits += 1;
    }
    this.#units.push(Object.freeze({ messages: stable, bytes, tokens, toolResults }));
    this.#retainedBytes += bytes;
    this.#retainedMessages += stable.length;
    if (this.#unitStart >= 1_024 && this.#unitStart * 2 >= this.#units.length) {
      this.#units.splice(0, this.#unitStart);
      this.#unitStart = 0;
    }
  }

  #projectUnit(unit: HistoryUnit, observationRemaining: number): ProjectedUnit | undefined {
    if (unit.toolResults > 0 && observationRemaining < unit.toolResults * MIN_OBSERVATION_BYTES) {
      return undefined;
    }
    const messages: ConversationMessage[] = [];
    let remainingResults = unit.toolResults;
    let remainingObservation = observationRemaining;
    let observationBytes = 0;
    let truncatedObservations = 0;
    let textTruncated = false;
    for (const message of unit.messages) {
      if (message.role !== "tool") {
        const projected = projectedNonToolMessage(
          message,
          this.#redactor,
          this.#limits.maxHistoricalTextBytes,
        );
        messages.push(projected.message);
        textTruncated ||= projected.truncated;
        continue;
      }
      const allowance = Math.min(
        this.#limits.maxSingleObservationBytes,
        Math.floor(remainingObservation / Math.max(1, remainingResults)),
      );
      if (allowance < MIN_OBSERVATION_BYTES) return undefined;
      const result = projectedToolResult(message.result, allowance, this.#redactor);
      messages.push(conversationMessageFromJson({
        role: "tool",
        id: this.#redactor.redact(message.id),
        createdAt: message.createdAt,
        callId: this.#redactor.redact(message.callId),
        toolName: this.#redactor.redact(message.toolName),
        result: toolExecutionResultToJson(result.result),
      }));
      observationBytes += result.bytes;
      remainingObservation -= result.bytes;
      remainingResults -= 1;
      if (result.truncated) truncatedObservations += 1;
    }
    if (remainingObservation < 0) return undefined;
    return Object.freeze({
      messages: Object.freeze(messages),
      observationBytes,
      truncatedObservations,
      textTruncated,
    });
  }

  #applyCompaction(boundary: CompactionBoundary): void {
    this.#discardPending("새 compaction 경계 전에 tool result 쌍이 완성되지 않았습니다.");
    this.#units.splice(0, this.#units.length);
    this.#unitStart = 0;
    this.#retainedBytes = 0;
    this.#retainedMessages = 0;
    this.#sourceTokens = 0;
    this.#omittedUnits = 0;
    this.#compaction = boundary;
    for (const message of boundary.preservedMessages) {
      this.#acceptMessage(message, true);
    }
  }

  #discardPending(message: string): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    this.#droppedIncomplete += 1;
    const unresolved = [...pending.expected]
      .filter(([callId]) => !pending.received.has(callId));
    const references = unresolved
      .slice(0, MAX_INCOMPLETE_TOOL_REFERENCES)
      .map(([callId, toolName]) => `${toolName} (${callId})`);
    const omitted = unresolved.length - references.length;
    const detail = references.length === 0
      ? ""
      : ` 미완료 호출: ${references.join(", ")}${
          omitted > 0 ? ` 외 ${omitted}개` : ""
        }.`;
    this.#warn("incomplete_tool_exchange", `${message}${detail}`);
    const unknownResults: ToolMessage[] = unresolved.map(([callId, toolName]) => ({
      role: "tool",
      id: `recovered:${createHash("sha256").update(`${pending.assistant.id}:${callId}`).digest("hex")}`,
      createdAt: pending.assistant.createdAt,
      callId,
      toolName,
      result: {
        status: "failure",
        execution: "unknown",
        error: {
          code: "interrupted_tool_result_unknown",
          message: "이전 실행의 결과가 저장되지 않았습니다. 부작용이 이미 발생했을 수 있습니다. 자동 재실행하지 말고 실제 상태와 사용자 의도를 확인하세요.",
          retryable: false,
        },
      },
    }));
    // Keep completed siblings as well as explicit unknown results. Do not
    // silently erase the whole batch, and never manufacture a success.
    this.#addUnit([pending.assistant, ...pending.results, ...unknownResults], pending.expected.size);
  }

  #warn(code: ContextProjectionWarning["code"], message: string): void {
    if (this.#warnings.length >= MAX_PROJECTION_WARNINGS) {
      this.#omittedWarnings += 1;
      return;
    }
    const bounded = boundedUtf8(
      this.#redactor.redact(message),
      MAX_PROJECTION_WARNING_BYTES,
    );
    this.#warnings.push(Object.freeze({ code, message: bounded.text }));
  }

  #assertMutable(): void {
    if (this.#finished) {
      throw new ConfigurationError("완료된 model context projection에는 기록을 더 넣을 수 없습니다.");
    }
  }
}

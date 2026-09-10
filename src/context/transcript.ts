import { ConfigurationError } from "../core/errors.js";
import type { JsonObject, JsonValue } from "../core/json.js";
import type {
  AssistantMessage,
  ConversationMessage,
  SystemMessage,
  TextContent,
  ToolCallContent,
  ToolMessage,
  UserMessage,
} from "../core/messages.js";
import type {
  ToolExecutionResult,
  ToolFailure,
} from "../core/tools.js";
import type {
  StoredTranscriptRecord,
  TranscriptAppendRequest,
} from "../storage/sessions.js";

export const TRANSCRIPT_MESSAGE_SCHEMA_VERSION = 1;

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_PARTS = 256;
const MAX_TOOL_CALLS = 128;
const MAX_TOOL_INPUT_BYTES = 1024 * 1024;
const MAX_ALL_TOOL_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_TOOL_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_WARNINGS = 64;
const MAX_JSON_DEPTH = 40;
const MAX_JSON_NODES = 100_000;

interface JsonState {
  nodes: number;
  readonly ancestors: WeakSet<object>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError(`${label}은 객체여야 합니다.`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ConfigurationError(`${label}에 알 수 없는 ${key} field가 있습니다.`);
    }
  }
}

function identifier(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value, "utf8") > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ConfigurationError(`${label} 형식이 올바르지 않습니다.`);
  }
  return value;
}

function text(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maximum
  ) {
    throw new ConfigurationError(`${label} 크기 또는 형식이 올바르지 않습니다.`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ConfigurationError(`${label}은 0 이상의 안전한 정수여야 합니다.`);
  }
  return value;
}

function jsonValue(
  value: unknown,
  depth: number,
  state: JsonState,
): JsonValue {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new ConfigurationError("Transcript message의 JSON 구조가 너무 큽니다.");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ConfigurationError("Transcript message에는 유한한 숫자만 쓸 수 있습니다.");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new ConfigurationError("Transcript message에는 JSON 값만 쓸 수 있습니다.");
  }
  if (state.ancestors.has(value)) {
    throw new ConfigurationError("Transcript message에 순환 참조가 있습니다.");
  }
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const output = value.map((item) => jsonValue(item, depth + 1, state));
      Object.freeze(output);
      return output;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ConfigurationError("Transcript message에는 일반 JSON 객체만 쓸 수 있습니다.");
    }
    const output: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = jsonValue(item, depth + 1, state);
    }
    Object.freeze(output);
    return output;
  } finally {
    state.ancestors.delete(value);
  }
}

function jsonObject(
  value: unknown,
  label: string,
  state: JsonState,
): JsonObject {
  const result = jsonValue(value, 0, state);
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new ConfigurationError(`${label}은 JSON 객체여야 합니다.`);
  }
  return result;
}

function byteLength(value: unknown, label: string, maximum: number): number {
  let serialized: string;
  try {
    const result = JSON.stringify(value);
    if (result === undefined) throw new Error("undefined_json");
    serialized = result;
  } catch {
    throw new ConfigurationError(`${label}을 JSON으로 직렬화할 수 없습니다.`);
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > maximum) {
    throw new ConfigurationError(`${label} 크기 제한을 초과했습니다.`);
  }
  return bytes;
}

const FAILURE_KEYS = new Set(["code", "message", "retryable", "details"]);

function toolFailure(
  value: unknown,
  label: string,
  state: JsonState,
): ToolFailure {
  const raw = object(value, label);
  onlyKeys(raw, FAILURE_KEYS, label);
  if (typeof raw.retryable !== "boolean") {
    throw new ConfigurationError(`${label}의 retryable 값이 올바르지 않습니다.`);
  }
  const details = raw.details === undefined
    ? undefined
    : jsonValue(raw.details, 0, state);
  return Object.freeze({
    code: identifier(raw.code, `${label} code`, 256),
    message: text(raw.message, `${label} message`, 64 * 1024),
    retryable: raw.retryable,
    ...(details === undefined ? {} : { details }),
  });
}

function toolWarnings(
  value: unknown,
  state: JsonState,
): readonly ToolFailure[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_TOOL_WARNINGS) {
    throw new ConfigurationError("Tool result warnings 형식이 올바르지 않습니다.");
  }
  return Object.freeze(
    value.map((item, index) => toolFailure(item, `Tool warning ${index + 1}`, state)),
  );
}

const TOOL_SUCCESS_KEYS = new Set(["status", "output", "warnings"]);
const TOOL_FAILURE_KEYS = new Set(["status", "error", "execution", "warnings"]);
const TOOL_REASON_KEYS = new Set(["status", "reason", "warnings"]);
const TOOL_OUTPUT_KEYS = new Set(["content", "truncated", "omittedBytes"]);

export function toolExecutionResultFromJson(value: unknown): ToolExecutionResult {
  byteLength(value, "Tool result", MAX_TOOL_RESULT_BYTES);
  const state: JsonState = { nodes: 0, ancestors: new WeakSet<object>() };
  const raw = object(value, "Tool result");
  const warnings = toolWarnings(raw.warnings, state);
  if (raw.status === "success") {
    onlyKeys(raw, TOOL_SUCCESS_KEYS, "Tool success result");
    const output = object(raw.output, "Tool success output");
    onlyKeys(output, TOOL_OUTPUT_KEYS, "Tool success output");
    if (typeof output.truncated !== "boolean") {
      throw new ConfigurationError("Tool success output의 truncated 값이 올바르지 않습니다.");
    }
    const omittedBytes = output.omittedBytes === undefined
      ? undefined
      : nonnegativeInteger(output.omittedBytes, "Tool success omittedBytes");
    return Object.freeze({
      status: "success",
      output: Object.freeze({
        content: jsonValue(output.content, 0, state),
        truncated: output.truncated,
        ...(omittedBytes === undefined ? {} : { omittedBytes }),
      }),
      ...(warnings === undefined ? {} : { warnings }),
    });
  }
  if (raw.status === "failure") {
    onlyKeys(raw, TOOL_FAILURE_KEYS, "Tool failure result");
    if (
      raw.execution !== "not_started" &&
      raw.execution !== "failed" &&
      raw.execution !== "unknown"
    ) {
      throw new ConfigurationError("Tool failure execution 값이 올바르지 않습니다.");
    }
    return Object.freeze({
      status: "failure",
      error: toolFailure(raw.error, "Tool failure", state),
      execution: raw.execution,
      ...(warnings === undefined ? {} : { warnings }),
    });
  }
  if (raw.status === "denied") {
    onlyKeys(raw, TOOL_REASON_KEYS, "Tool denied result");
    return Object.freeze({
      status: "denied",
      reason: text(raw.reason, "Tool denied reason", 64 * 1024),
      ...(warnings === undefined ? {} : { warnings }),
    });
  }
  if (raw.status === "cancelled") {
    onlyKeys(raw, TOOL_REASON_KEYS, "Tool cancelled result");
    const reason = raw.reason === undefined
      ? undefined
      : text(raw.reason, "Tool cancelled reason", 64 * 1024);
    return Object.freeze({
      status: "cancelled",
      ...(reason === undefined ? {} : { reason }),
      ...(warnings === undefined ? {} : { warnings }),
    });
  }
  throw new ConfigurationError("Tool result status가 올바르지 않습니다.");
}

export function toolExecutionResultToJson(result: ToolExecutionResult): JsonObject {
  const normalized = toolExecutionResultFromJson(result);
  return jsonObject(normalized, "Tool result", {
    nodes: 0,
    ancestors: new WeakSet<object>(),
  });
}

const TEXT_PART_KEYS = new Set(["type", "text"]);
const TOOL_CALL_PART_KEYS = new Set(["type", "callId", "name", "input"]);

function textPart(
  value: unknown,
  textBytes: { value: number },
): TextContent {
  const raw = object(value, "Message text part");
  onlyKeys(raw, TEXT_PART_KEYS, "Message text part");
  if (raw.type !== "text") {
    throw new ConfigurationError("Message text part 종류가 올바르지 않습니다.");
  }
  const content = text(raw.text, "Message text", MAX_MESSAGE_TEXT_BYTES);
  textBytes.value += Buffer.byteLength(content, "utf8");
  if (textBytes.value > MAX_MESSAGE_TEXT_BYTES) {
    throw new ConfigurationError("Message text 전체 크기 제한을 초과했습니다.");
  }
  return Object.freeze({ type: "text", text: content });
}

function toolCallPart(
  value: unknown,
  state: JsonState,
  inputBytes: { value: number },
): ToolCallContent {
  const raw = object(value, "Message tool call part");
  onlyKeys(raw, TOOL_CALL_PART_KEYS, "Message tool call part");
  if (raw.type !== "tool_call") {
    throw new ConfigurationError("Message tool call part 종류가 올바르지 않습니다.");
  }
  const input = jsonObject(raw.input, "Tool call input", state);
  inputBytes.value += byteLength(input, "Tool call input", MAX_TOOL_INPUT_BYTES);
  if (inputBytes.value > MAX_ALL_TOOL_INPUT_BYTES) {
    throw new ConfigurationError("Message tool call input 전체 크기 제한을 초과했습니다.");
  }
  return Object.freeze({
    type: "tool_call",
    callId: identifier(raw.callId, "Tool call ID", 512),
    name: identifier(raw.name, "Tool 이름", 128),
    input,
  });
}

const BASE_MESSAGE_KEYS = new Set(["role", "id", "createdAt", "content"]);
const TOOL_MESSAGE_KEYS = new Set(["role", "id", "createdAt", "callId", "toolName", "result"]);

export function conversationMessageFromJson(value: unknown): ConversationMessage {
  const raw = object(value, "Conversation message");
  const role = raw.role;
  const id = identifier(raw.id, "Message ID", 512);
  const createdAt = nonnegativeInteger(raw.createdAt, "Message createdAt");
  const state: JsonState = { nodes: 0, ancestors: new WeakSet<object>() };

  if (role === "tool") {
    onlyKeys(raw, TOOL_MESSAGE_KEYS, "Tool message");
    const message: ToolMessage = Object.freeze({
      role: "tool",
      id,
      createdAt,
      callId: identifier(raw.callId, "Tool message call ID", 512),
      toolName: identifier(raw.toolName, "Tool message 이름", 128),
      result: toolExecutionResultFromJson(raw.result),
    });
    byteLength(message, "Tool message", MAX_MESSAGE_BYTES);
    return message;
  }
  if (role !== "system" && role !== "user" && role !== "assistant") {
    throw new ConfigurationError("Conversation message role이 올바르지 않습니다.");
  }
  onlyKeys(raw, BASE_MESSAGE_KEYS, "Conversation message");
  if (
    !Array.isArray(raw.content) ||
    raw.content.length < 1 ||
    raw.content.length > MAX_CONTENT_PARTS
  ) {
    throw new ConfigurationError("Conversation message content 수가 올바르지 않습니다.");
  }
  const textBytes = { value: 0 };
  if (role === "system" || role === "user") {
    const content = raw.content.map((part) => textPart(part, textBytes));
    const message: SystemMessage | UserMessage = role === "system"
      ? Object.freeze({ role: "system", id, createdAt, content: Object.freeze(content) })
      : Object.freeze({ role: "user", id, createdAt, content: Object.freeze(content) });
    byteLength(message, "Conversation message", MAX_MESSAGE_BYTES);
    return message;
  }

  const inputBytes = { value: 0 };
  let toolCalls = 0;
  const callIds = new Set<string>();
  const content: Array<TextContent | ToolCallContent> = [];
  for (const part of raw.content) {
    const candidate = object(part, "Assistant content part");
    if (candidate.type === "text") {
      content.push(textPart(candidate, textBytes));
      continue;
    }
    if (candidate.type !== "tool_call") {
      throw new ConfigurationError("Assistant content part 종류가 올바르지 않습니다.");
    }
    toolCalls += 1;
    if (toolCalls > MAX_TOOL_CALLS) {
      throw new ConfigurationError("Assistant message의 tool call 수가 너무 많습니다.");
    }
    const call = toolCallPart(candidate, state, inputBytes);
    if (callIds.has(call.callId)) {
      throw new ConfigurationError("Assistant message에 중복 tool call ID가 있습니다.");
    }
    callIds.add(call.callId);
    content.push(call);
  }
  const message: AssistantMessage = Object.freeze({
    role: "assistant",
    id,
    createdAt,
    content: Object.freeze(content),
  });
  byteLength(message, "Assistant message", MAX_MESSAGE_BYTES);
  return message;
}

export function conversationMessageToJson(message: ConversationMessage): JsonObject {
  const normalized = conversationMessageFromJson(message);
  return jsonObject(normalized, "Conversation message", {
    nodes: 0,
    ancestors: new WeakSet<object>(),
  });
}

const MESSAGE_RECORD_KEYS = new Set(["messageSchemaVersion", "message"]);

export function transcriptMessageRequest(
  message: ConversationMessage,
  runId?: string,
): TranscriptAppendRequest {
  return Object.freeze({
    kind: "message",
    data: {
      messageSchemaVersion: TRANSCRIPT_MESSAGE_SCHEMA_VERSION,
      message: conversationMessageToJson(message),
    },
    ...(runId === undefined ? {} : { runId }),
  });
}

export function conversationMessageFromTranscript(
  record: StoredTranscriptRecord,
): ConversationMessage | undefined {
  if (record.kind !== "message") return undefined;
  const raw = object(record.data, "Transcript message record");
  onlyKeys(raw, MESSAGE_RECORD_KEYS, "Transcript message record");
  if (raw.messageSchemaVersion !== TRANSCRIPT_MESSAGE_SCHEMA_VERSION) {
    throw new ConfigurationError("Transcript message schema version이 올바르지 않습니다.");
  }
  return conversationMessageFromJson(raw.message);
}

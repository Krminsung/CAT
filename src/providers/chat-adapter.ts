import {
  CancelledError,
  ConfigurationError,
  ContextWindowError,
  ProviderError,
  ProtocolError,
} from "../core/errors.js";
import type { JsonObject } from "../core/json.js";
import type { ConversationMessage } from "../core/messages.js";
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderToolSpec,
  ProviderUsage,
} from "../core/provider.js";
import { PRODUCT_NAME, VERSION } from "../core/version.js";
import { normalizeApiPath, normalizeProviderBaseUrl } from "../security/endpoints.js";
import { Redactor } from "../security/redaction.js";
import { ModelHttpTransport } from "../transport/model-http.js";
import { readServerSentEvents } from "../transport/sse.js";
import type { ProviderCredentialAccess } from "./credential-access.js";
import {
  parseProtocolJsonObject,
  protocolInteger,
  protocolJsonObject,
  protocolRecord,
  protocolString,
} from "./protocol-json.js";
import {
  configurationJsonObject,
  configurationString,
  isContextWindowFailure,
  providerDiagnostic,
  providerHttpFailure,
  safeProviderDiagnostic,
  sanitizedProviderError,
  validateProviderCapabilities,
} from "./shared.js";

const MAX_MESSAGES = 10_000;
const MAX_CHOICES = 16;
const MAX_TOOL_CALLS = 128;
const MAX_TOOL_CALL_INDEX = 10_000;
const MAX_TOOL_ARGUMENT_BYTES = 2 * 1024 * 1024;
const MAX_ALL_TOOL_ARGUMENT_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_FIELD_CHUNKS = 65_536;
const MAX_ALL_TOOL_FIELD_CHUNKS = 200_000;
const MAX_ID_BYTES = 2_048;
const MAX_NAME_BYTES = 1_024;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export type ChatAuthenticationStyle = "bearer" | "anthropic";

export interface ChatAdapterOptions {
  id: string;
  displayName: string;
  baseUrl: string;
  origin: string;
  generationPath: string;
  capabilities: ProviderCapabilities;
  credential: ProviderCredentialAccess;
  transport: ModelHttpTransport;
  authentication?: ChatAuthenticationStyle;
  timeoutMs?: number;
  maxRetries?: number;
}

interface PendingChatToolCall {
  choiceIndex: number;
  callIndex: number;
  order: number;
  idChunks: string[];
  nameChunks: string[];
  argumentChunks: string[];
  idBytes: number;
  nameBytes: number;
  argumentBytes: number;
  chunkCount: number;
  complete: boolean;
}

type ContentMessage = Exclude<ConversationMessage, { role: "tool" }>;

function validTimeout(value: number | undefined): number {
  const selected = value ?? 180_000;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 300_000) {
    throw new ConfigurationError("Chat adapter 제한 시간은 1–300000ms여야 합니다.");
  }
  return selected;
}

function validRetries(value: number | undefined): number {
  const selected = value ?? 2;
  if (!Number.isSafeInteger(selected) || selected < 0 || selected > 2) {
    throw new ConfigurationError("Chat adapter 재시도 횟수는 0–2여야 합니다.");
  }
  return selected;
}

function authenticationStyle(value: unknown): ChatAuthenticationStyle {
  const selected = value ?? "bearer";
  if (selected !== "bearer" && selected !== "anthropic") {
    throw new ConfigurationError("Chat adapter 인증 방식이 올바르지 않습니다.");
  }
  return selected;
}

function endpointUrl(baseUrl: string, path: string, origin: string): URL {
  const normalizedBase = normalizeProviderBaseUrl(baseUrl, "Chat base URL", true);
  const normalizedPath = normalizeApiPath(path, "Chat generation 경로");
  if (normalizedBase.origin !== origin) {
    throw new ConfigurationError("Chat base URL과 credential origin이 일치하지 않습니다.");
  }
  const endpoint = new URL(`${normalizedBase.baseUrl}${normalizedPath}`);
  if (endpoint.origin !== origin) {
    throw new ConfigurationError("Chat endpoint가 credential origin 밖에 있습니다.");
  }
  return endpoint;
}

function messageText(message: ContentMessage): string {
  const text: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") text.push(part.text);
  }
  return text.join("\n");
}

function jsonText(value: unknown, label: string): string {
  try {
    return JSON.stringify(configurationJsonObject(value, label));
  } catch {
    throw new ConfigurationError(`${label}를 Chat 요청으로 직렬화하지 못했습니다.`);
  }
}

function chatMessages(messages: readonly ConversationMessage[]): JsonObject[] {
  if (messages.length > MAX_MESSAGES) {
    throw new ConfigurationError("Chat 입력 message 수가 너무 많습니다.");
  }
  const result: JsonObject[] = [];
  let historicalToolCalls = 0;
  for (const message of messages) {
    if (message.role === "system" || message.role === "user") {
      result.push({ role: message.role, content: messageText(message) });
      continue;
    }
    if (message.role === "tool") {
      result.push({
        role: "tool",
        tool_call_id: configurationString(message.callId, "Chat call ID", 512),
        content: jsonText(message.result, "Tool 결과"),
      });
      continue;
    }
    const toolCalls: JsonObject[] = [];
    for (const part of message.content) {
      if (part.type !== "tool_call") continue;
      historicalToolCalls += 1;
      if (historicalToolCalls > MAX_MESSAGES) {
        throw new ConfigurationError("Chat 대화 기록의 tool call 수가 너무 많습니다.");
      }
      toolCalls.push({
        id: configurationString(part.callId, "Chat call ID", 512),
        type: "function",
        function: {
          name: configurationString(part.name, "Chat tool 이름", 128),
          arguments: jsonText(part.input, "Tool 입력"),
        },
      });
    }
    const content = messageText(message);
    result.push({
      role: "assistant",
      content: content || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }
  return result;
}

function chatTools(
  tools: readonly ProviderToolSpec[],
  capabilities: ProviderCapabilities,
): JsonObject[] {
  if (tools.length > MAX_TOOL_CALLS) {
    throw new ConfigurationError("Chat tool 수가 너무 많습니다.");
  }
  if (!capabilities.nativeToolCalls) return [];
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: configurationString(tool.name, "Chat tool 이름", 128),
      description: configurationString(tool.description, "Chat tool 설명", 8_192, true),
      parameters: configurationJsonObject(tool.inputSchema, "Chat tool schema"),
      ...(capabilities.strictToolSchemas ? { strict: tool.strict } : {}),
    },
  }));
}

function requestBody(
  request: ProviderRequest,
  capabilities: ProviderCapabilities,
): string {
  const tools = chatTools(request.tools, capabilities);
  if (
    request.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(request.maxOutputTokens) ||
      request.maxOutputTokens < 1 ||
      request.maxOutputTokens > 1_000_000)
  ) {
    throw new ConfigurationError("Chat max output token 값이 올바르지 않습니다.");
  }
  const payload: JsonObject = {
    model: configurationString(request.model, "Chat model ID", 256),
    messages: chatMessages(request.messages),
    stream: true,
    ...(capabilities.streamUsage
      ? { stream_options: { include_usage: true } }
      : {}),
    ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
    ...(tools.length > 0 && capabilities.parallelToolCalls
      ? { parallel_tool_calls: true }
      : {}),
    ...(request.maxOutputTokens !== undefined
      ? { max_tokens: request.maxOutputTokens }
      : {}),
  };
  try {
    return JSON.stringify(payload);
  } catch {
    throw new ConfigurationError("Chat 요청을 JSON으로 직렬화하지 못했습니다.");
  }
}

function requestHeaders(
  apiKey: string,
  authentication: ChatAuthenticationStyle,
): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    "User-Agent": `${PRODUCT_NAME}/${VERSION}`,
    ...(authentication === "anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : {}),
  };
}

class ChatToolCollector {
  readonly #calls = new Map<string, PendingChatToolCall>();
  readonly #choices = new Set<number>();
  readonly #finishReasons = new Map<number, "stop" | "tool_calls">();
  #nextOrder = 0;
  #totalArgumentBytes = 0;
  #totalChunkCount = 0;

  #choice(index: number): void {
    this.#choices.add(index);
    if (this.#choices.size > MAX_CHOICES) {
      throw new ProtocolError("Chat stream의 choice 수가 너무 많습니다.");
    }
  }

  #call(choiceIndex: number, callIndex: number): PendingChatToolCall {
    this.#choice(choiceIndex);
    const key = `${choiceIndex}:${callIndex}`;
    const existing = this.#calls.get(key);
    if (existing) return existing;
    if (this.#calls.size >= MAX_TOOL_CALLS) {
      throw new ProtocolError("Chat stream의 tool call 수가 너무 많습니다.");
    }
    const created: PendingChatToolCall = {
      choiceIndex,
      callIndex,
      order: this.#nextOrder,
      idChunks: [],
      nameChunks: [],
      argumentChunks: [],
      idBytes: 0,
      nameBytes: 0,
      argumentBytes: 0,
      chunkCount: 0,
      complete: false,
    };
    this.#nextOrder += 1;
    this.#calls.set(key, created);
    return created;
  }

  #append(
    call: PendingChatToolCall,
    target: "id" | "name" | "arguments",
    value: string,
  ): void {
    if (call.complete || this.#finishReasons.has(call.choiceIndex)) {
      throw new ProtocolError("완료된 Chat tool call에 delta가 추가됐습니다.");
    }
    call.chunkCount += 1;
    this.#totalChunkCount += 1;
    if (
      call.chunkCount > MAX_TOOL_FIELD_CHUNKS ||
      this.#totalChunkCount > MAX_ALL_TOOL_FIELD_CHUNKS
    ) {
      throw new ProtocolError("Chat tool call의 fragment 수가 너무 많습니다.");
    }
    const bytes = Buffer.byteLength(value, "utf8");
    if (target === "id") {
      call.idBytes += bytes;
      if (call.idBytes > MAX_ID_BYTES) {
        throw new ProtocolError("Chat tool call ID가 허용 크기를 초과했습니다.");
      }
      call.idChunks.push(value);
      return;
    }
    if (target === "name") {
      call.nameBytes += bytes;
      if (call.nameBytes > MAX_NAME_BYTES) {
        throw new ProtocolError("Chat tool 이름이 허용 크기를 초과했습니다.");
      }
      call.nameChunks.push(value);
      return;
    }
    call.argumentBytes += bytes;
    this.#totalArgumentBytes += bytes;
    if (
      call.argumentBytes > MAX_TOOL_ARGUMENT_BYTES ||
      this.#totalArgumentBytes > MAX_ALL_TOOL_ARGUMENT_BYTES
    ) {
      throw new ProtocolError("Chat tool 인자가 허용 크기를 초과했습니다.");
    }
    call.argumentChunks.push(value);
  }

  append(choiceIndex: number, value: unknown): void {
    const raw = protocolRecord(value);
    if (!raw) throw new ProtocolError("Chat tool call delta가 객체가 아닙니다.");
    const callIndex = protocolInteger(raw.index);
    if (callIndex === undefined || callIndex > MAX_TOOL_CALL_INDEX) {
      throw new ProtocolError("Chat tool call index가 올바르지 않습니다.");
    }
    if (raw.type !== undefined && raw.type !== "function") {
      throw new ProtocolError("Chat tool call type이 function이 아닙니다.");
    }
    const call = this.#call(choiceIndex, callIndex);
    if (raw.id !== undefined) {
      if (typeof raw.id !== "string") {
        throw new ProtocolError("Chat tool call ID delta가 문자열이 아닙니다.");
      }
      this.#append(call, "id", raw.id);
    }
    if (raw.function !== undefined) {
      const fn = protocolRecord(raw.function);
      if (!fn) throw new ProtocolError("Chat tool call function이 객체가 아닙니다.");
      if (fn.name !== undefined) {
        if (typeof fn.name !== "string") {
          throw new ProtocolError("Chat tool 이름 delta가 문자열이 아닙니다.");
        }
        this.#append(call, "name", fn.name);
      }
      if (fn.arguments !== undefined) {
        if (typeof fn.arguments !== "string") {
          throw new ProtocolError("Chat tool argument delta가 문자열이 아닙니다.");
        }
        this.#append(call, "arguments", fn.arguments);
      }
    }
  }

  markChoiceFinished(choiceIndex: number, reason: "stop" | "tool_calls"): void {
    this.#choice(choiceIndex);
    const existing = this.#finishReasons.get(choiceIndex);
    if (existing && existing !== reason) {
      throw new ProtocolError("Chat choice 종료 사유가 stream 중 변경됐습니다.");
    }
    const calls = [...this.#calls.values()].filter(
      (call) => call.choiceIndex === choiceIndex,
    );
    if (reason === "stop" && calls.length > 0) {
      throw new ProtocolError("Chat tool call이 stop 종료로 끝났습니다.");
    }
    for (const call of calls) call.complete = true;
    this.#finishReasons.set(choiceIndex, reason);
  }

  assertTextAllowed(choiceIndex: number): void {
    this.#choice(choiceIndex);
    if (this.#finishReasons.has(choiceIndex)) {
      throw new ProtocolError("종료된 Chat choice에 text delta가 추가됐습니다.");
    }
  }

  observeChoice(choiceIndex: number): void {
    this.#choice(choiceIndex);
  }

  finishAll(): ProviderStreamEvent[] {
    const result: ProviderStreamEvent[] = [];
    const calls = [...this.#calls.values()].sort((left, right) =>
      left.choiceIndex - right.choiceIndex ||
      left.callIndex - right.callIndex ||
      left.order - right.order
    );
    for (const call of calls) {
      const reason = this.#finishReasons.get(call.choiceIndex);
      if (reason === "stop") {
        throw new ProtocolError("Chat tool call이 올바른 종료 사유 없이 끝났습니다.");
      }
      call.complete = true;
      const callId = protocolString(
        call.idChunks.join(""),
        "Chat tool call ID",
        512,
      );
      const name = protocolString(
        call.nameChunks.join(""),
        "Chat tool 이름",
        128,
      );
      const argumentsText = call.argumentChunks.join("") || "{}";
      result.push({
        type: "tool_call",
        callId,
        name,
        input: parseProtocolJsonObject(argumentsText, `Chat tool ${name} 인자`),
      });
    }
    return result;
  }
}

function usage(value: unknown): ProviderUsage | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = protocolRecord(value);
  if (!raw) throw new ProtocolError("Chat usage가 객체가 아닙니다.");
  const fields = ["prompt_tokens", "completion_tokens", "total_tokens"] as const;
  for (const field of fields) {
    if (raw[field] !== undefined && protocolInteger(raw[field]) === undefined) {
      throw new ProtocolError(`Chat usage ${field} 값이 올바르지 않습니다.`);
    }
  }
  const inputTokens = protocolInteger(raw.prompt_tokens);
  const outputTokens = protocolInteger(raw.completion_tokens);
  const totalTokens = protocolInteger(raw.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function mergeUsage(
  previous: ProviderUsage | undefined,
  next: ProviderUsage | undefined,
): ProviderUsage | undefined {
  if (!next) return previous;
  return {
    ...(previous ?? {}),
    ...next,
  };
}

function choiceIndex(choice: Record<string, unknown>, position: number): number {
  if (choice.index === undefined) return position;
  const index = protocolInteger(choice.index);
  if (index === undefined) throw new ProtocolError("Chat choice index가 올바르지 않습니다.");
  return index;
}

function finishReason(value: unknown): "stop" | "tool_calls" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "stop" || value === "tool_calls") return value;
  if (value === "length") {
    throw new ProviderError("Chat 모델 응답이 output token 한도에서 중단됐습니다.");
  }
  if (value === "content_filter") {
    throw new ProviderError("Chat 모델 응답이 content filter로 중단됐습니다.");
  }
  throw new ProtocolError("Chat finish_reason을 해석할 수 없습니다.");
}

export class ChatProviderAdapter implements ProviderAdapter {
  readonly id: string;
  readonly protocol = "openai-chat" as const;
  readonly capabilities: ProviderCapabilities;
  readonly #displayName: string;
  readonly #endpoint: URL;
  readonly #credential: ProviderCredentialAccess;
  readonly #transport: ModelHttpTransport;
  readonly #authentication: ChatAuthenticationStyle;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;

  constructor(options: ChatAdapterOptions) {
    const id = options.id.trim().toLowerCase();
    if (!PROVIDER_ID.test(id)) throw new ConfigurationError("Chat provider ID가 올바르지 않습니다.");
    if (options.credential.provider !== id || options.credential.origin !== options.origin) {
      throw new ConfigurationError("Chat credential이 provider endpoint와 일치하지 않습니다.");
    }
    this.id = id;
    this.#displayName = configurationString(options.displayName, "Provider 표시 이름", 128);
    this.#endpoint = endpointUrl(options.baseUrl, options.generationPath, options.origin);
    this.capabilities = validateProviderCapabilities(
      options.capabilities,
      "Chat provider",
    );
    this.#credential = options.credential;
    this.#transport = options.transport;
    this.#authentication = authenticationStyle(options.authentication);
    this.#timeoutMs = validTimeout(options.timeoutMs);
    this.#maxRetries = validRetries(options.maxRetries);
  }

  async *stream(
    request: ProviderRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderStreamEvent> {
    let redactor = new Redactor();
    try {
      const body = requestBody(request, this.capabilities);
      const response = await this.#credential.withValue(async (apiKey) => {
        redactor = new Redactor([apiKey]);
        return await this.#transport.request({
          url: this.#endpoint,
          expectedOrigin: this.#credential.origin,
          method: "POST",
          headers: requestHeaders(apiKey, this.#authentication),
          body,
          signal,
          timeoutMs: this.#timeoutMs,
          retryBudget: request.retryBudget,
          maxRetries: this.#maxRetries,
        });
      });
      if (!response.ok) {
        throw await providerHttpFailure(response, this.#displayName, redactor);
      }

      const tools = new ChatToolCollector();
      let responseId: string | undefined;
      let measuredUsage: ProviderUsage | undefined;
      let sawText = false;
      for await (const event of readServerSentEvents(response)) {
        if (event.data === "[DONE]") {
          const toolEvents = tools.finishAll();
          if (!sawText && toolEvents.length === 0) {
            throw new ProtocolError("Chat stream이 응답 내용 없이 완료됐습니다.");
          }
          for (const toolEvent of toolEvents) yield toolEvent;
          if (measuredUsage) yield { type: "usage", usage: measuredUsage };
          yield {
            type: "completed",
            ...(responseId ? { responseId } : {}),
          };
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data) as unknown;
        } catch {
          throw new ProtocolError("Chat stream event JSON이 올바르지 않습니다.");
        }
        const raw = protocolJsonObject(parsed, "Chat stream event");
        if (raw.error !== undefined || raw.type === "error") {
          const detail = safeProviderDiagnostic(
            redactor.redact(
              providerDiagnostic(raw.error) ??
              providerDiagnostic(raw) ??
              "Chat 모델 응답에 실패했습니다.",
            ),
          );
          throw isContextWindowFailure(detail)
            ? new ContextWindowError(detail)
            : new ProviderError(detail);
        }
        if (raw.id !== undefined) {
          const currentId = protocolString(raw.id, "Chat response ID", 512);
          if (responseId !== undefined && responseId !== currentId) {
            throw new ProtocolError("Chat response ID가 stream 중 변경됐습니다.");
          }
          responseId = currentId;
        }
        const currentUsage = usage(raw.usage);
        measuredUsage = mergeUsage(measuredUsage, currentUsage);
        if (raw.choices === undefined && currentUsage) continue;
        if (!Array.isArray(raw.choices)) {
          throw new ProtocolError("Chat stream event에 choices 배열이 없습니다.");
        }
        for (let position = 0; position < raw.choices.length; position += 1) {
          const choice = protocolRecord(raw.choices[position]);
          if (!choice) throw new ProtocolError("Chat choice가 객체가 아닙니다.");
          const index = choiceIndex(choice, position);
          tools.observeChoice(index);
          const delta = protocolRecord(choice.delta);
          if (!delta) throw new ProtocolError("Chat choice delta가 객체가 아닙니다.");

          if (delta.content !== undefined && delta.content !== null) {
            if (typeof delta.content !== "string") {
              throw new ProtocolError("Chat text delta가 문자열이 아닙니다.");
            }
            if (delta.content) {
              tools.assertTextAllowed(index);
              sawText = true;
              yield { type: "text_delta", text: delta.content };
            }
          }
          if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
            if (!Array.isArray(delta.tool_calls)) {
              throw new ProtocolError("Chat tool_calls delta가 배열이 아닙니다.");
            }
            for (const rawCall of delta.tool_calls) tools.append(index, rawCall);
          }
          const reason = finishReason(choice.finish_reason);
          if (reason) tools.markChoiceFinished(index, reason);
        }
      }
      throw new ProtocolError("Chat stream 연결이 [DONE] 전에 종료됐습니다.");
    } catch (error) {
      if (signal.aborted || error instanceof CancelledError) {
        yield { type: "cancelled", reason: "모델 요청이 취소됐습니다." };
        return;
      }
      throw sanitizedProviderError(error, redactor);
    }
  }
}

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
  configurationJsonObject as requestJsonObject,
  configurationReasoningEffort,
  configurationString as requestString,
  configurationTemperature,
  isContextWindowFailure,
  providerDiagnostic,
  providerHttpFailure,
  safeProviderDiagnostic,
  sanitizedProviderError,
  validateProviderCapabilities,
} from "./shared.js";

const MAX_TOOL_CALLS = 128;
const MAX_TOOL_ARGUMENT_BYTES = 2 * 1024 * 1024;
const MAX_ALL_TOOL_ARGUMENT_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_ARGUMENT_CHUNKS = 65_536;
const MAX_MESSAGES = 10_000;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export interface ResponsesAdapterOptions {
  id: string;
  displayName: string;
  baseUrl: string;
  origin: string;
  generationPath: string;
  capabilities: ProviderCapabilities;
  credential: ProviderCredentialAccess;
  transport: ModelHttpTransport;
  allowInsecureHttp?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
}

interface PendingToolCall {
  order: number;
  callId?: string;
  name?: string;
  argumentChunks: string[];
  fullArguments?: string;
  argumentBytes: number;
  complete: boolean;
  emitted: boolean;
}

function validTimeout(value: number | undefined): number {
  const selected = value ?? 180_000;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 300_000) {
    throw new ConfigurationError("Responses adapter 제한 시간은 1–300000ms여야 합니다.");
  }
  return selected;
}

function validRetries(value: number | undefined): number {
  const selected = value ?? 2;
  if (!Number.isSafeInteger(selected) || selected < 0 || selected > 2) {
    throw new ConfigurationError("Responses adapter 재시도 횟수는 0–2여야 합니다.");
  }
  return selected;
}

function endpointUrl(
  baseUrl: string,
  path: string,
  origin: string,
  allowInsecureHttp: boolean,
): URL {
  const normalizedBase = normalizeProviderBaseUrl(
    baseUrl,
    "Responses base URL",
    allowInsecureHttp,
  );
  const normalizedPath = normalizeApiPath(path, "Responses generation 경로");
  if (normalizedBase.origin !== origin) {
    throw new ConfigurationError("Responses base URL과 credential origin이 일치하지 않습니다.");
  }
  const endpoint = new URL(`${normalizedBase.baseUrl}${normalizedPath}`);
  if (endpoint.origin !== origin) {
    throw new ConfigurationError("Responses endpoint가 credential origin 밖에 있습니다.");
  }
  return endpoint;
}

type ContentMessage = Exclude<ConversationMessage, { role: "tool" }>;

function messageText(message: ContentMessage): string {
  const texts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") texts.push(part.text);
  }
  return texts.join("\n");
}

function systemInstructions(messages: readonly ConversationMessage[]): string {
  const instructions: string[] = [];
  for (const message of messages) {
    if (message.role !== "system") continue;
    const text = messageText(message);
    if (text) instructions.push(text);
  }
  return instructions.join("\n\n");
}

function toolResultText(message: Extract<ConversationMessage, { role: "tool" }>): string {
  try {
    return JSON.stringify(requestJsonObject(message.result, "Tool 결과"));
  } catch {
    throw new ConfigurationError("Tool 결과를 Responses 입력으로 직렬화하지 못했습니다.");
  }
}

function toolInputText(input: JsonObject): string {
  try {
    return JSON.stringify(requestJsonObject(input, "Tool 입력"));
  } catch {
    throw new ConfigurationError("Tool 입력을 Responses 요청으로 직렬화하지 못했습니다.");
  }
}

function responsesInput(messages: readonly ConversationMessage[]): JsonObject[] {
  if (messages.length > MAX_MESSAGES) {
    throw new ConfigurationError("Responses 입력 message 수가 너무 많습니다.");
  }
  const input: JsonObject[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      input.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: messageText(message) }],
      });
      continue;
    }
    if (message.role === "assistant") {
      const texts = message.content
        .filter((part) => part.type === "text")
        .map((part) => ({ type: "output_text", text: part.text }));
      if (texts.length > 0) {
        input.push({ type: "message", role: "assistant", content: texts });
      }
      for (const part of message.content) {
        if (part.type !== "tool_call") continue;
        input.push({
          type: "function_call",
          call_id: requestString(part.callId, "Responses call ID", 512),
          name: requestString(part.name, "Responses tool 이름", 128),
          arguments: toolInputText(part.input),
        });
      }
      continue;
    }
    input.push({
      type: "function_call_output",
      call_id: requestString(message.callId, "Responses call ID", 512),
      output: toolResultText(message),
    });
  }
  return input;
}

function responsesTools(
  tools: readonly ProviderToolSpec[],
  capabilities: ProviderCapabilities,
): JsonObject[] {
  if (tools.length > MAX_TOOL_CALLS) {
    throw new ConfigurationError("Responses tool 수가 너무 많습니다.");
  }
  if (!capabilities.nativeToolCalls) return [];
  return tools.map((tool) => ({
    type: "function",
    name: requestString(tool.name, "Responses tool 이름", 128),
    description: requestString(tool.description, "Responses tool 설명", 8_192, true),
    parameters: requestJsonObject(tool.inputSchema, "Responses tool schema"),
    ...(capabilities.strictToolSchemas ? { strict: tool.strict } : {}),
  }));
}

function requestBody(
  request: ProviderRequest,
  capabilities: ProviderCapabilities,
): string {
  const model = requestString(request.model, "Responses model ID", 256);
  const tools = responsesTools(request.tools, capabilities);
  const instructions = systemInstructions(request.messages);
  const reasoningEffort = configurationReasoningEffort(request.reasoningEffort);
  const temperature = configurationTemperature(request.temperature);
  if (
    request.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(request.maxOutputTokens) ||
      request.maxOutputTokens < 1 ||
      request.maxOutputTokens > 1_000_000)
  ) {
    throw new ConfigurationError("Responses max output token 값이 올바르지 않습니다.");
  }
  const payload: JsonObject = {
    model,
    input: responsesInput(request.messages),
    stream: true,
    store: false,
    ...(instructions ? { instructions } : {}),
    ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
    ...(tools.length > 0 && capabilities.parallelToolCalls
      ? { parallel_tool_calls: true }
      : {}),
    ...(request.maxOutputTokens !== undefined
      ? { max_output_tokens: request.maxOutputTokens }
      : {}),
    ...(reasoningEffort && capabilities.reasoningParameter
      ? { reasoning: { effort: reasoningEffort } }
      : {}),
    ...(temperature !== undefined && capabilities.temperatureParameter
      ? { temperature }
      : {}),
  };
  try {
    return JSON.stringify(payload);
  } catch {
    throw new ConfigurationError("Responses 요청을 JSON으로 직렬화하지 못했습니다.");
  }
}

function eventKey(event: Record<string, unknown>): string | undefined {
  return eventKeys(event)[0];
}

function eventKeys(event: Record<string, unknown>): string[] {
  const keys: string[] = [];
  if (event.item_id !== undefined) {
    const itemId = protocolString(event.item_id, "Responses tool item ID", 512);
    keys.push(`item:${itemId}`);
  }
  if (event.output_index !== undefined && protocolInteger(event.output_index) === undefined) {
    throw new ProtocolError("Responses output index 형식이 올바르지 않습니다.");
  }
  const index = protocolInteger(event.output_index);
  if (index !== undefined) keys.push(`index:${index}`);
  return keys;
}

class ResponsesToolCollector {
  readonly #aliases = new Map<string, PendingToolCall>();
  readonly #calls: PendingToolCall[] = [];
  #nextOrder = 0;
  #totalArgumentBytes = 0;

  #call(keys: readonly string[]): PendingToolCall {
    const matches = new Set(
      keys.flatMap((key) => {
        const call = this.#aliases.get(key);
        return call ? [call] : [];
      }),
    );
    if (matches.size > 1) {
      throw new ProtocolError("Responses tool call 식별자가 서로 충돌합니다.");
    }
    let call = matches.values().next().value as PendingToolCall | undefined;
    if (!call) {
      if (this.#calls.length >= MAX_TOOL_CALLS) {
        throw new ProtocolError("Responses stream의 tool call 수가 너무 많습니다.");
      }
      call = {
        order: this.#nextOrder,
        argumentChunks: [],
        argumentBytes: 0,
        complete: false,
        emitted: false,
      };
      this.#nextOrder += 1;
      this.#calls.push(call);
    }
    for (const key of keys) {
      const existing = this.#aliases.get(key);
      if (existing && existing !== call) {
        throw new ProtocolError("Responses tool call 식별자가 서로 충돌합니다.");
      }
      this.#aliases.set(key, call);
    }
    return call;
  }

  #mergeIdentity(
    call: PendingToolCall,
    field: "callId" | "name",
    value: string,
    label: string,
    maximum: number,
  ): void {
    const selected = protocolString(value, label, maximum);
    const existing = call[field];
    if (existing !== undefined && existing !== selected) {
      throw new ProtocolError(`Responses ${label} 값이 stream 중 변경됐습니다.`);
    }
    call[field] = selected;
  }

  #replaceRetainedBytes(call: PendingToolCall, bytes: number): void {
    const nextTotal = this.#totalArgumentBytes - call.argumentBytes + bytes;
    if (nextTotal > MAX_ALL_TOOL_ARGUMENT_BYTES) {
      throw new ProtocolError("Responses tool 인자의 전체 크기가 허용 한도를 초과했습니다.");
    }
    this.#totalArgumentBytes = nextTotal;
    call.argumentBytes = bytes;
  }

  #setFullArguments(call: PendingToolCall, text: string): void {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_TOOL_ARGUMENT_BYTES) {
      throw new ProtocolError("Responses tool 인자가 허용 크기를 초과했습니다.");
    }
    const assembled = call.argumentChunks.join("");
    if (assembled && assembled !== text) {
      throw new ProtocolError("Responses tool argument 완료 값이 delta와 일치하지 않습니다.");
    }
    if (call.fullArguments !== undefined && call.fullArguments !== text) {
      throw new ProtocolError("Responses tool argument 완료 값이 stream 중 변경됐습니다.");
    }
    this.#replaceRetainedBytes(call, bytes);
    call.argumentChunks.length = 0;
    call.fullArguments = text;
  }

  #appendArguments(call: PendingToolCall, text: string): void {
    if (call.complete || call.fullArguments !== undefined || call.emitted) {
      throw new ProtocolError("완료된 Responses tool call에 argument delta가 추가됐습니다.");
    }
    const bytes = Buffer.byteLength(text, "utf8");
    const nextCallBytes = call.argumentBytes + bytes;
    if (nextCallBytes > MAX_TOOL_ARGUMENT_BYTES) {
      throw new ProtocolError("Responses tool 인자가 허용 크기를 초과했습니다.");
    }
    this.#replaceRetainedBytes(call, nextCallBytes);
    call.argumentChunks.push(text);
    if (call.argumentChunks.length > MAX_TOOL_ARGUMENT_CHUNKS) {
      throw new ProtocolError("Responses tool argument chunk 수가 너무 많습니다.");
    }
  }

  mergeItem(
    item: Record<string, unknown>,
    fallbackKey?: string,
    complete = false,
  ): PendingToolCall | undefined {
    if (item.type !== "function_call") return undefined;
    if (item.id !== undefined && (typeof item.id !== "string" || !item.id)) {
      throw new ProtocolError("Responses tool item ID 형식이 올바르지 않습니다.");
    }
    if (item.call_id !== undefined && (typeof item.call_id !== "string" || !item.call_id)) {
      throw new ProtocolError("Responses call ID 형식이 올바르지 않습니다.");
    }
    if (item.name !== undefined && (typeof item.name !== "string" || !item.name)) {
      throw new ProtocolError("Responses tool 이름 형식이 올바르지 않습니다.");
    }
    if (item.arguments !== undefined && typeof item.arguments !== "string") {
      throw new ProtocolError("Responses tool argument가 문자열이 아닙니다.");
    }
    const itemId = typeof item.id === "string"
      ? protocolString(item.id, "Responses tool item ID", 512)
      : undefined;
    const callId = typeof item.call_id === "string" && item.call_id
      ? protocolString(item.call_id, "Responses call ID", 512)
      : undefined;
    const keys = [
      ...(itemId ? [`item:${itemId}`] : []),
      ...(fallbackKey ? [fallbackKey] : []),
      ...(callId ? [`call:${callId}`] : []),
    ];
    if (keys.length === 0) throw new ProtocolError("Responses tool call 식별자가 없습니다.");
    const call = this.#call(keys);
    if (callId) this.#mergeIdentity(call, "callId", callId, "call ID", 512);
    if (typeof item.name === "string" && item.name) {
      this.#mergeIdentity(call, "name", item.name, "tool 이름", 128);
    }
    if (typeof item.arguments === "string") {
      if (complete) {
        if (!call.emitted) this.#setFullArguments(call, item.arguments);
      } else if (item.arguments) {
        this.#appendArguments(call, item.arguments);
      }
    }
    if (complete) call.complete = true;
    return call;
  }

  appendDelta(event: Record<string, unknown>): PendingToolCall {
    const keys = eventKeys(event);
    if (keys.length === 0) throw new ProtocolError("Responses tool argument delta 식별자가 없습니다.");
    if (typeof event.delta !== "string") {
      throw new ProtocolError("Responses tool argument delta가 문자열이 아닙니다.");
    }
    const call = this.#call(keys);
    this.#appendArguments(call, event.delta);
    return call;
  }

  completeArguments(event: Record<string, unknown>): PendingToolCall {
    const keys = eventKeys(event);
    if (keys.length === 0) throw new ProtocolError("Responses tool argument 완료 식별자가 없습니다.");
    const call = this.#call(keys);
    if (event.arguments !== undefined && typeof event.arguments !== "string") {
      throw new ProtocolError("Responses tool argument 완료 값이 문자열이 아닙니다.");
    }
    if (typeof event.arguments === "string") {
      this.#setFullArguments(call, event.arguments);
    }
    call.complete = true;
    return call;
  }

  finish(call: PendingToolCall): ProviderStreamEvent | undefined {
    if (call.emitted || !call.complete) return undefined;
    if (!call.callId || !call.name) {
      throw new ProtocolError("완료된 Responses tool call의 ID 또는 이름이 없습니다.");
    }
    const argumentsText = call.fullArguments ?? (call.argumentChunks.join("") || "{}");
    const event: ProviderStreamEvent = {
      type: "tool_call",
      callId: call.callId,
      name: call.name,
      input: parseProtocolJsonObject(argumentsText, `Responses tool ${call.name} 인자`),
    };
    call.emitted = true;
    return event;
  }

  finishAll(): ProviderStreamEvent[] {
    const result: ProviderStreamEvent[] = [];
    const calls = [...this.#calls].sort((left, right) => left.order - right.order);
    for (const call of calls) {
      if (!call.complete && !call.emitted) {
        throw new ProtocolError("Responses stream에 완료되지 않은 tool call이 있습니다.");
      }
      const event = this.finish(call);
      if (event) result.push(event);
    }
    return result;
  }
}

function usage(value: unknown): ProviderUsage | undefined {
  const raw = protocolRecord(value);
  if (!raw) return undefined;
  const inputTokens = protocolInteger(raw.input_tokens);
  const outputTokens = protocolInteger(raw.output_tokens);
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

function completedResponse(event: Record<string, unknown>): Record<string, unknown> {
  const response = protocolRecord(event.response);
  if (!response) throw new ProtocolError("Responses 완료 event에 response 객체가 없습니다.");
  return response;
}

function responseOutput(response: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(response.output)) {
    throw new ProtocolError("Responses 완료 응답에 output 배열이 없습니다.");
  }
  return response.output.map((rawItem) => {
    const item = protocolRecord(rawItem);
    if (!item || typeof item.type !== "string") {
      throw new ProtocolError("Responses 완료 응답의 output 항목이 올바르지 않습니다.");
    }
    return item;
  });
}

function outputText(output: readonly Record<string, unknown>[]): string[] {
  const result: string[] = [];
  for (const item of output) {
    if (item.type !== "message") continue;
    if (!Array.isArray(item.content)) {
      throw new ProtocolError("Responses 완료 message에 content 배열이 없습니다.");
    }
    for (const rawPart of item.content) {
      const part = protocolRecord(rawPart);
      if (!part || typeof part.type !== "string") {
        throw new ProtocolError("Responses 완료 message의 content가 올바르지 않습니다.");
      }
      if (part.type === "output_text") {
        if (typeof part.text !== "string") {
          throw new ProtocolError("Responses 완료 message의 text가 문자열이 아닙니다.");
        }
        if (part.text) result.push(part.text);
      }
    }
  }
  return result;
}

export class ResponsesProviderAdapter implements ProviderAdapter {
  readonly id: string;
  readonly protocol = "openai-responses" as const;
  readonly capabilities: ProviderCapabilities;
  readonly #displayName: string;
  readonly #endpoint: URL;
  readonly #credential: ProviderCredentialAccess;
  readonly #transport: ModelHttpTransport;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;

  constructor(options: ResponsesAdapterOptions) {
    const id = options.id.trim().toLowerCase();
    if (!PROVIDER_ID.test(id)) throw new ConfigurationError("Responses provider ID가 올바르지 않습니다.");
    if (options.credential.provider !== id || options.credential.origin !== options.origin) {
      throw new ConfigurationError("Responses credential이 provider endpoint와 일치하지 않습니다.");
    }
    this.id = id;
    this.#displayName = requestString(options.displayName, "Provider 표시 이름", 128);
    this.#endpoint = endpointUrl(
      options.baseUrl,
      options.generationPath,
      options.origin,
      options.allowInsecureHttp === true,
    );
    this.capabilities = validateProviderCapabilities(
      options.capabilities,
      "Responses provider",
    );
    this.#credential = options.credential;
    this.#transport = options.transport;
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
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "text/event-stream",
            "Content-Type": "application/json",
            "User-Agent": `${PRODUCT_NAME}/${VERSION}`,
          },
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

      const tools = new ResponsesToolCollector();
      let sawText = false;
      for await (const event of readServerSentEvents(response)) {
        if (event.data === "[DONE]") {
          throw new ProtocolError("Responses stream이 완료 event 전에 종료됐습니다.");
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data) as unknown;
        } catch {
          throw new ProtocolError("Responses stream event JSON이 올바르지 않습니다.");
        }
        const raw = protocolJsonObject(parsed, "Responses stream event");
        if (typeof raw.type !== "string") {
          throw new ProtocolError("Responses stream event 형식이 올바르지 않습니다.");
        }

        if (raw.type === "response.output_text.delta") {
          if (typeof raw.delta !== "string") {
            throw new ProtocolError("Responses text delta가 문자열이 아닙니다.");
          }
          if (raw.delta) {
            sawText = true;
            yield { type: "text_delta", text: raw.delta };
          }
          continue;
        }
        if (raw.type === "response.output_text.done") {
          if (raw.text !== undefined && typeof raw.text !== "string") {
            throw new ProtocolError("Responses 완료 text가 문자열이 아닙니다.");
          }
          if (!sawText && typeof raw.text === "string" && raw.text) {
            sawText = true;
            yield { type: "text_delta", text: raw.text };
          }
          continue;
        }
        if (raw.type === "response.output_item.added") {
          const item = protocolRecord(raw.item);
          if (!item) throw new ProtocolError("Responses 추가 output item이 객체가 아닙니다.");
          tools.mergeItem(item, eventKey(raw));
          continue;
        }
        if (raw.type === "response.function_call_arguments.delta") {
          tools.appendDelta(raw);
          continue;
        }
        if (raw.type === "response.function_call_arguments.done") {
          tools.completeArguments(raw);
          continue;
        }
        if (raw.type === "response.output_item.done") {
          const item = protocolRecord(raw.item);
          if (!item) throw new ProtocolError("Responses 완료 output item이 객체가 아닙니다.");
          tools.mergeItem(item, eventKey(raw), true);
          continue;
        }
        if (raw.type === "response.failed" || raw.type === "response.incomplete" || raw.type === "error") {
          const detail = safeProviderDiagnostic(
            redactor.redact(providerDiagnostic(raw.error) ?? providerDiagnostic(raw.response) ?? "모델 응답에 실패했습니다."),
          );
          throw isContextWindowFailure(detail)
            ? new ContextWindowError(detail)
            : new ProviderError(detail);
        }
        if (raw.type !== "response.completed") continue;

        const response = completedResponse(raw);
        const output = responseOutput(response);
        if (!sawText) {
          for (const text of outputText(output)) {
            sawText = true;
            yield { type: "text_delta", text };
          }
        }
        for (let index = 0; index < output.length; index += 1) {
          const item = output[index];
          if (item) tools.mergeItem(item, `index:${index}`, true);
        }
        for (const toolEvent of tools.finishAll()) yield toolEvent;
        const measured = usage(response.usage);
        if (measured) yield { type: "usage", usage: measured };
        const responseId = typeof response.id === "string" && response.id
          ? protocolString(response.id, "Responses response ID", 512)
          : undefined;
        yield {
          type: "completed",
          ...(responseId ? { responseId } : {}),
        };
        return;
      }
      throw new ProtocolError("Responses stream 연결이 완료 event 없이 종료됐습니다.");
    } catch (error) {
      if (signal.aborted || error instanceof CancelledError) {
        yield { type: "cancelled", reason: "모델 요청이 취소됐습니다." };
        return;
      }
      throw sanitizedProviderError(error, redactor);
    }
  }
}

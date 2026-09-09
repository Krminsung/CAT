import type { ConversationMessage } from "./messages.js";
import type { RetryBudgetPort } from "./execution.js";
import type { JsonObject } from "./json.js";

export type ProviderProtocol = "openai-responses" | "openai-chat";
export type ProviderReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface ProviderCapabilities {
  nativeToolCalls: boolean;
  strictToolSchemas: boolean;
  parallelToolCalls: boolean;
  reasoningParameter: boolean;
  temperatureParameter: boolean;
  streamUsage: boolean;
}

export interface ProviderToolSpec {
  name: string;
  description: string;
  inputSchema: JsonObject;
  strict: boolean;
}

export interface ProviderRequest {
  runId: string;
  model: string;
  messages: readonly ConversationMessage[];
  tools: readonly ProviderToolSpec[];
  maxOutputTokens?: number;
  reasoningEffort?: ProviderReasoningEffort;
  temperature?: number;
  retryBudget: RetryBudgetPort;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type ProviderStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; callId: string; name: string; input: JsonObject }
  | { type: "usage"; usage: ProviderUsage }
  | { type: "completed"; responseId?: string }
  | { type: "cancelled"; reason?: string };

export interface ProviderAdapter {
  readonly id: string;
  readonly protocol: ProviderProtocol;
  readonly capabilities: ProviderCapabilities;
  stream(
    request: ProviderRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderStreamEvent>;
}

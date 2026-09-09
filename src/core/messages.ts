import type { JsonObject } from "./json.js";
import type { ToolExecutionResult } from "./tools.js";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolCallContent {
  type: "tool_call";
  callId: string;
  name: string;
  input: JsonObject;
}

interface MessageBase {
  id: string;
  createdAt: number;
}

export interface SystemMessage extends MessageBase {
  role: "system";
  content: readonly TextContent[];
}

export interface UserMessage extends MessageBase {
  role: "user";
  content: readonly TextContent[];
}

export interface AssistantMessage extends MessageBase {
  role: "assistant";
  content: readonly (TextContent | ToolCallContent)[];
}

export interface ToolMessage extends MessageBase {
  role: "tool";
  callId: string;
  toolName: string;
  result: ToolExecutionResult;
}

export type ConversationMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

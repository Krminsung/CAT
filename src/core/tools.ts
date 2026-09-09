import type { ToolExecutionContext } from "./execution.js";
import type { JsonObject, JsonValue } from "./json.js";

export type ToolCategory = "read" | "edit" | "shell" | "web" | "external";

export type PermissionRequirement =
  | { kind: "none" }
  | { kind: "workspace"; access: "read" | "write" }
  | { kind: "command" }
  | { kind: "network"; destination: "public" | "provider" }
  | { kind: "external"; service: string };

export interface ToolOutput {
  content: JsonValue;
  truncated: boolean;
  omittedBytes?: number;
}

export interface ToolFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export type ToolExecutionResult =
  | {
      status: "success";
      output: ToolOutput;
    }
  | {
      status: "failure";
      error: ToolFailure;
      execution: "not_started" | "failed" | "unknown";
    }
  | {
      status: "denied";
      reason: string;
    }
  | {
      status: "cancelled";
      reason?: string;
    };

export type ToolHandler = (
  input: JsonObject,
  context: ToolExecutionContext,
) => Promise<ToolExecutionResult>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
  category: ToolCategory;
  permission: PermissionRequirement;
  outputLimitBytes: number;
  handler: ToolHandler;
}

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
  details?: JsonValue;
}

type ToolExecutionOutcome =
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

export type ToolExecutionResult = ToolExecutionOutcome & {
  /** 후처리 실패는 이미 끝난 handler를 다시 실행하지 않고 별도 경고로 보존한다. */
  warnings?: readonly ToolFailure[];
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

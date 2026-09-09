import type { RunTermination } from "./execution.js";
import type { JsonObject } from "./json.js";
import type { ProviderUsage } from "./provider.js";
import type {
  PermissionRequirement,
  ToolExecutionResult,
} from "./tools.js";

interface AgentEventBase {
  runId: string;
  sequence: number;
  occurredAt: number;
}

export type ApprovalChoice = "once" | "session" | "project" | "deny";

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface AgentPlanStep {
  readonly step: string;
  readonly status: PlanStepStatus;
}

export interface UserInputOption {
  readonly label: string;
  readonly description: string;
}

export type AgentEvent =
  | (AgentEventBase & {
      type: "run_start";
      sessionId: string;
    })
  | (AgentEventBase & {
      type: "text_delta";
      text: string;
    })
  | (AgentEventBase & {
      type: "tool_start";
      callId: string;
      toolName: string;
      input: JsonObject;
    })
  | (AgentEventBase & {
      type: "tool_result";
      callId: string;
      toolName: string;
      result: ToolExecutionResult;
    })
  | (AgentEventBase & {
      type: "approval_required";
      requestId: string;
      callId: string;
      summary: string;
      permission: PermissionRequirement;
      choices: readonly ApprovalChoice[];
    })
  | (AgentEventBase & {
      type: "plan_update";
      explanation: string;
      plan: readonly AgentPlanStep[];
    })
  | (AgentEventBase & {
      type: "user_input_required";
      requestId: string;
      callId: string;
      question: string;
      options: readonly UserInputOption[];
    })
  | (AgentEventBase & {
      type: "user_input_result";
      requestId: string;
      callId: string;
      answer?: string;
      cancelled: boolean;
    })
  | (AgentEventBase & {
      type: "usage";
      usage: ProviderUsage;
    })
  | (AgentEventBase & {
      type: "notice";
      level: "info" | "warning" | "error";
      code: string;
      message: string;
    })
  | (AgentEventBase & {
      type: "run_end";
      termination: RunTermination;
      message?: string;
    });

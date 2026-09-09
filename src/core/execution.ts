export type RunTermination =
  | "completed"
  | "cancelled"
  | "budget_exhausted"
  | "permission_denied"
  | "provider_error"
  | "protocol_error";

export interface RunBudget {
  modelRequests: number;
  toolCalls: number;
  recoveryAttempts: number;
  compactions: number;
  deadlineAt: number;
}

export interface RunIdentity {
  sessionId: string;
  runId: string;
}

export interface ToolExecutionContext extends RunIdentity {
  workspace: string;
  signal: AbortSignal;
}

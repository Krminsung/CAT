export type RunTermination =
  | "completed"
  | "cancelled"
  | "budget_exhausted"
  | "permission_denied"
  | "provider_error"
  | "protocol_error"
  | "concurrent_run"
  | "no_progress";

export interface RunBudget {
  readonly turns: number;
  readonly modelRequests: number;
  readonly toolCalls: number;
  readonly recoveryAttempts: number;
  readonly compactions: number;
  readonly stopContinuations: number;
  readonly deadlineAt: number;
}

export interface RunIdentity {
  sessionId: string;
  runId: string;
}

export type TransportRetryReason = "network_error" | "http_status";

export interface TransportRetryRequest {
  owner: "model_transport";
  attempt: number;
  reason: TransportRetryReason;
  statusCode?: number;
}

export interface RetryBudgetPort {
  tryConsumeRetry(request: TransportRetryRequest): boolean;
}

export interface ToolExecutionContext extends RunIdentity {
  workspace: string;
  workspaceTrusted: boolean;
  signal: AbortSignal;
}

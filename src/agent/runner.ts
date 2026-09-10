import {
  BudgetExhaustedError,
  CancelledError,
  CatError,
  ConfigurationError,
  PermissionDeniedError,
  ProtocolError,
  ProviderError,
} from "../core/errors.js";
import type { AgentEvent } from "../core/events.js";
import type {
  RunBudget,
  RunIdentity,
  RunTermination,
  ToolExecutionContext,
} from "../core/execution.js";
import type { JsonObject } from "../core/json.js";
import type {
  AssistantMessage,
  ConversationMessage,
  ToolCallContent,
  ToolMessage,
  UserMessage,
} from "../core/messages.js";
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderReasoningEffort,
  ProviderToolSpec,
  ProviderUsage,
} from "../core/provider.js";
import type { ToolExecutionResult } from "../core/tools.js";
import type { CentralToolExecutor } from "../tools/runtime.js";
import {
  RunBudgetController,
  type AgentRunLimits,
  resolveAgentRunLimits,
} from "./budget.js";
import {
  AgentEventJournal,
  type AgentEventSink,
} from "./events.js";
import {
  ToolCallExecutionLedger,
  type ToolCallExecutionRecord,
} from "./execution-records.js";
import type { TextToolFallbackMode } from "./fallback-parser.js";
import type {
  AgentInteractionHub,
  AgentInteractionLease,
} from "./interactive.js";
import {
  RunStateMachine,
  sharedSessionRunCoordinator,
  type SessionRunCoordinator,
} from "./run-state.js";
import { RepeatedToolExecutionGuard } from "./progress.js";
import {
  ToolCallNormalizer,
  type NativeToolCall,
  type NormalizedToolCall,
  type ToolCallNormalizationIssue,
} from "./tool-calls.js";

export interface AgentRunnerOptions {
  readonly provider: ProviderAdapter;
  readonly executor: CentralToolExecutor;
  readonly interactions: AgentInteractionHub;
  readonly model: string;
  readonly workspace: string;
  readonly workspaceTrusted: boolean;
  readonly limits?: Partial<AgentRunLimits>;
  readonly fallbackMode?: TextToolFallbackMode;
  readonly coordinator?: SessionRunCoordinator;
  readonly maxOutputTokens?: number;
  readonly reasoningEffort?: ProviderReasoningEffort;
  readonly temperature?: number;
  readonly now?: () => number;
}

export interface AgentRunRequest extends RunIdentity {
  readonly messages: readonly ConversationMessage[];
  readonly signal?: AbortSignal;
  readonly onEvent?: AgentEventSink;
  readonly allowTools?: boolean;
  /** 사전 compaction이 소비한 동일 run 예산의 소유권을 runner에 넘긴다. */
  readonly budget?: RunBudgetController;
}

export interface AgentRunResult extends RunIdentity {
  readonly termination: RunTermination;
  readonly message?: string;
  readonly text: string;
  readonly messages: readonly ConversationMessage[];
  readonly usage: ProviderUsage;
  readonly budget: RunBudget | undefined;
  readonly toolExecutions: readonly ToolCallExecutionRecord[];
  readonly events: readonly AgentEvent[];
  readonly responseId?: string;
}

interface ProviderTurn {
  readonly text: string;
  readonly nativeCalls: readonly NativeToolCall[];
  readonly cancelledReason: string | undefined;
  readonly responseId: string | undefined;
  readonly gate: TextDeltaGate;
}

interface LoopOutcome {
  readonly termination: RunTermination;
  readonly text: string;
  readonly message?: string;
  readonly responseId?: string;
}

interface OwnedRunContext {
  readonly identity: RunIdentity;
  readonly messages: ConversationMessage[];
  readonly budget: RunBudgetController;
  readonly state: RunStateMachine;
  readonly journal: AgentEventJournal;
  readonly ledger: ToolCallExecutionLedger;
  readonly normalizer: ToolCallNormalizer;
  readonly progress: RepeatedToolExecutionGuard;
  readonly appendedResults: Set<string>;
  readonly usage: ProviderUsage;
  readonly allowTools: boolean;
}

function sameRunLimits(left: AgentRunLimits, right: AgentRunLimits): boolean {
  return left.maxTurns === right.maxTurns &&
    left.maxModelRequests === right.maxModelRequests &&
    left.maxToolCalls === right.maxToolCalls &&
    left.maxRecoveryAttempts === right.maxRecoveryAttempts &&
    left.maxSameRecoveryKind === right.maxSameRecoveryKind &&
    left.maxCompactions === right.maxCompactions &&
    left.maxStopContinuations === right.maxStopContinuations &&
    left.wallClockMs === right.wallClockMs;
}

const MAX_INITIAL_MESSAGES = 1_000;
const MAX_INITIAL_MESSAGES_BYTES = 8 * 1024 * 1024;
const MAX_ASSISTANT_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_PROVIDER_EVENTS_PER_TURN = 100_000;
const MAX_NATIVE_TOOL_CALL_BYTES = 1024 * 1024;
const MAX_NATIVE_TOOL_CALLS_BYTES = 8 * 1024 * 1024;
const MAX_PROVIDER_RESPONSE_ID_BYTES = 1_024;
const MAX_PROVIDER_REASON_BYTES = 4_096;
const MODEL_TOOL_RESULTS_PER_TURN_BYTES = 512 * 1024;
const TEXT_TOOL_FALLBACK_PREFIX = "call:";

function cloneMessages(
  messages: readonly ConversationMessage[],
): ConversationMessage[] {
  if (messages.length < 1 || messages.length > MAX_INITIAL_MESSAGES) {
    throw new ConfigurationError(
      `초기 대화 message 수는 1–${MAX_INITIAL_MESSAGES} 범위여야 합니다.`,
    );
  }
  let serialized: string;
  try {
    const candidate = JSON.stringify(messages);
    if (candidate === undefined) {
      throw new Error("undefined_json");
    }
    serialized = candidate;
  } catch {
    throw new ConfigurationError("초기 대화 기록을 JSON으로 복제하지 못했습니다.");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_INITIAL_MESSAGES_BYTES) {
    throw new ConfigurationError("초기 대화 기록이 크기 제한을 초과했습니다.");
  }
  const cloned = JSON.parse(serialized) as unknown;
  if (!Array.isArray(cloned)) {
    throw new ConfigurationError("초기 대화 기록 형식이 올바르지 않습니다.");
  }
  return cloned as ConversationMessage[];
}

function boundedString(value: string, maximumBytes: number): {
  readonly text: string;
  readonly omittedBytes: number;
} {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return { text: value, omittedBytes: 0 };
  let end = maximumBytes;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) {
    end -= 1;
  }
  return {
    text: bytes.subarray(0, end).toString("utf8"),
    omittedBytes: bytes.byteLength - end,
  };
}

function resultForModel(
  result: ToolExecutionResult,
  maximumBytes: number,
): ToolExecutionResult {
  const serialized = JSON.stringify(result);
  if (serialized !== undefined && Buffer.byteLength(serialized, "utf8") <= maximumBytes) {
    return result;
  }
  const preview = boundedString(
    serialized ?? "[도구 결과 직렬화 실패]",
    Math.max(256, Math.floor((maximumBytes - 1_024) / 2)),
  );
  const notice = `모델 전달용 도구 결과에서 ${preview.omittedBytes} bytes를 생략했습니다.`;
  if (result.status === "success") {
    return {
      status: "success",
      output: {
        content: { preview: preview.text, output_notice: notice },
        truncated: true,
        omittedBytes: preview.omittedBytes,
      },
    };
  }
  if (result.status === "failure") {
    return {
      status: "failure",
      error: {
        ...result.error,
        message: boundedString(
          result.error.message,
          Math.max(256, Math.floor(maximumBytes / 4)),
        ).text,
        details: { preview: preview.text, output_notice: notice },
      },
      execution: result.execution,
    };
  }
  return result.status === "denied"
    ? { status: "denied", reason: boundedString(result.reason, maximumBytes).text }
    : {
        status: "cancelled",
        ...(result.reason
          ? { reason: boundedString(result.reason, maximumBytes).text }
          : {}),
      };
}

function mergeUsage(target: ProviderUsage, usage: ProviderUsage): void {
  if (usage.inputTokens !== undefined) {
    const total = (target.inputTokens ?? 0) + usage.inputTokens;
    if (!Number.isSafeInteger(total)) {
      throw new ProtocolError("provider usage 합계가 안전한 정수 범위를 벗어났습니다.");
    }
    target.inputTokens = total;
  }
  if (usage.outputTokens !== undefined) {
    const total = (target.outputTokens ?? 0) + usage.outputTokens;
    if (!Number.isSafeInteger(total)) {
      throw new ProtocolError("provider usage 합계가 안전한 정수 범위를 벗어났습니다.");
    }
    target.outputTokens = total;
  }
  if (usage.totalTokens !== undefined) {
    const total = (target.totalTokens ?? 0) + usage.totalTokens;
    if (!Number.isSafeInteger(total)) {
      throw new ProtocolError("provider usage 합계가 안전한 정수 범위를 벗어났습니다.");
    }
    target.totalTokens = total;
  }
}

function stableProviderUsage(usage: ProviderUsage): ProviderUsage {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    throw new ProtocolError("provider usage 값이 올바르지 않습니다.");
  }
  const values = [usage.inputTokens, usage.outputTokens, usage.totalTokens];
  for (const value of values) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new ProtocolError("provider usage 값이 올바르지 않습니다.");
    }
  }
  return Object.freeze({
    ...(usage.inputTokens === undefined
      ? {}
      : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined
      ? {}
      : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined
      ? {}
      : { totalTokens: usage.totalTokens }),
  });
}

function normalizationFeedback(
  issues: readonly ToolCallNormalizationIssue[],
): string {
  const details = issues.map((item) => ({
    kind: item.kind,
    call_id: item.callId ?? null,
    tool_name: item.toolName ?? null,
    message: item.message,
  }));
  return "도구 호출을 검증하는 동안 다음 오류를 확인했습니다. 같은 요청을 일반 텍스트로 " +
    `가장하지 말고 등록된 schema에 맞는 새 호출 ID로 고치세요:\n${JSON.stringify(details)}`;
}

function failureFromThrown(
  error: unknown,
  started: boolean,
): ToolExecutionResult {
  return {
    status: "failure",
    error: {
      code: "tool_execution_boundary_failed",
      message: error instanceof CatError
        ? error.message
        : "중앙 도구 실행 경계에서 처리하지 못한 오류가 발생했습니다.",
      retryable: false,
    },
    execution: started ? "unknown" : "not_started",
  };
}

function outcomeForError(
  error: unknown,
  budget: RunBudgetController,
  text: string,
): LoopOutcome {
  const exhaustion = budget.exhaustion;
  if (exhaustion) {
    return {
      termination: "budget_exhausted",
      text,
      message: `실행 예산이 소진되었습니다: ${exhaustion}`,
    };
  }
  if (error instanceof BudgetExhaustedError) {
    return {
      termination: "budget_exhausted",
      text,
      message: error.message,
    };
  }
  if (budget.callerCancelled || error instanceof CancelledError) {
    return {
      termination: "cancelled",
      text,
      message: error instanceof Error ? error.message : "실행이 취소됐습니다.",
    };
  }
  if (error instanceof PermissionDeniedError) {
    return { termination: "permission_denied", text, message: error.message };
  }
  if (error instanceof ProviderError) {
    return { termination: "provider_error", text, message: error.message };
  }
  if (error instanceof ProtocolError || error instanceof ConfigurationError) {
    return { termination: "protocol_error", text, message: error.message };
  }
  if (error instanceof CatError) {
    return {
      termination: "protocol_error",
      text,
      message: `agent 실행 경계 오류가 발생했습니다: ${error.code}`,
    };
  }
  return {
    termination: "protocol_error",
    text,
    message: "agent loop에서 알 수 없는 오류가 발생했습니다.",
  };
}

class TextDeltaGate {
  readonly #journal: AgentEventJournal;
  readonly #heldParts: string[] = [];
  #released = false;
  #sawNonWhitespace = false;
  #prefixIndex = 0;
  #prefixConfirmed = false;

  constructor(journal: AgentEventJournal, fallbackEnabled: boolean) {
    this.#journal = journal;
    this.#released = !fallbackEnabled;
  }

  push(text: string): void {
    if (this.#released) {
      this.#journal.emit({ type: "text_delta", text });
      return;
    }
    this.#heldParts.push(text);
    if (this.#prefixConfirmed) return;

    for (const character of text) {
      if (!this.#sawNonWhitespace) {
        if (character.trim().length === 0) continue;
        this.#sawNonWhitespace = true;
      }
      if (character === TEXT_TOOL_FALLBACK_PREFIX[this.#prefixIndex]) {
        this.#prefixIndex += 1;
        if (this.#prefixIndex === TEXT_TOOL_FALLBACK_PREFIX.length) {
          this.#prefixConfirmed = true;
          return;
        }
        continue;
      }
      this.#released = true;
      const buffered = this.#heldParts.join("");
      this.#heldParts.length = 0;
      if (buffered) this.#journal.emit({ type: "text_delta", text: buffered });
      return;
    }
  }

  finish(visibleText: string): void {
    if (!this.#released && visibleText) {
      this.#journal.emit({ type: "text_delta", text: visibleText });
    }
    this.#heldParts.length = 0;
    this.#released = true;
  }
}

export class AgentRunner {
  readonly #provider: ProviderAdapter;
  readonly #executor: CentralToolExecutor;
  readonly #interactions: AgentInteractionHub;
  readonly #model: string;
  readonly #workspace: string;
  readonly #workspaceTrusted: boolean;
  readonly #limits: AgentRunLimits;
  readonly #fallbackMode: TextToolFallbackMode;
  readonly #coordinator: SessionRunCoordinator;
  readonly #maxOutputTokens: number | undefined;
  readonly #reasoningEffort: ProviderReasoningEffort | undefined;
  readonly #temperature: number | undefined;
  readonly #now: () => number;

  constructor(options: AgentRunnerOptions) {
    if (!options.model.trim() || options.model.length > 256) {
      throw new ConfigurationError("agent model ID가 올바르지 않습니다.");
    }
    if (!options.workspace || typeof options.workspaceTrusted !== "boolean") {
      throw new ConfigurationError("agent workspace 설정이 올바르지 않습니다.");
    }
    this.#provider = options.provider;
    this.#executor = options.executor;
    this.#interactions = options.interactions;
    this.#model = options.model;
    this.#workspace = options.workspace;
    this.#workspaceTrusted = options.workspaceTrusted;
    this.#limits = resolveAgentRunLimits(options.limits);
    this.#fallbackMode = options.fallbackMode ?? "strict";
    if (!(["disabled", "strict", "relaxed"] as const).includes(this.#fallbackMode)) {
      throw new ConfigurationError("텍스트 도구 fallback 모드가 올바르지 않습니다.");
    }
    this.#coordinator = options.coordinator ?? sharedSessionRunCoordinator;
    this.#maxOutputTokens = options.maxOutputTokens;
    this.#reasoningEffort = options.reasoningEffort;
    this.#temperature = options.temperature;
    this.#now = options.now ?? Date.now;
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    let messages: ConversationMessage[];
    try {
      messages = cloneMessages(request.messages);
    } catch (error) {
      request.budget?.cleanup();
      throw error;
    }
    const identity: RunIdentity = Object.freeze({
      sessionId: request.sessionId,
      runId: request.runId,
    });
    let ownership: ReturnType<SessionRunCoordinator["acquire"]>;
    try {
      ownership = this.#coordinator.acquire(identity);
    } catch (error) {
      request.budget?.cleanup();
      throw error;
    }
    const journal = new AgentEventJournal(identity, request.onEvent, this.#now);
    if (!ownership.acquired) {
      request.budget?.cleanup();
      journal.start();
      const message = `이 session에서는 run ${ownership.activeRunId}이 이미 실행 중입니다.`;
      journal.emit({
        type: "notice",
        level: "warning",
        code: "concurrent_run",
        message,
      });
      journal.end("concurrent_run", message);
      return {
        ...identity,
        termination: "concurrent_run",
        message,
        text: "",
        messages: Object.freeze([...messages]),
        usage: Object.freeze({}),
        budget: undefined,
        toolExecutions: Object.freeze([]),
        events: journal.events(),
      };
    }

    const state = new RunStateMachine();
    const ledger = new ToolCallExecutionLedger(identity.runId, this.#now);
    const normalizer = new ToolCallNormalizer({ fallbackMode: this.#fallbackMode });
    let budget: RunBudgetController;
    let preparedBudget: RunBudgetController | undefined;
    try {
      preparedBudget = request.budget ?? new RunBudgetController({
        limits: this.#limits,
        ...(request.signal ? { signal: request.signal } : {}),
        now: this.#now,
      });
      budget = preparedBudget;
      if (request.budget && !sameRunLimits(preparedBudget.limits, this.#limits)) {
        throw new ConfigurationError("사전 실행 예산이 agent runner 제한과 일치하지 않습니다.");
      }
      budget.assertActive();
    } catch (error) {
      ownership.lease.release();
      preparedBudget?.cleanup();
      throw error;
    }
    const context: OwnedRunContext = {
      identity,
      messages,
      budget,
      state,
      journal,
      ledger,
      normalizer,
      progress: new RepeatedToolExecutionGuard(),
      appendedResults: new Set(),
      usage: {},
      allowTools: request.allowTools ?? true,
    };
    let latestText = "";
    let outcome: LoopOutcome | undefined;
    let interactionLease: AgentInteractionLease | undefined;
    try {
      journal.start();
      interactionLease = this.#interactions.attach(
        identity.sessionId,
        identity.runId,
        journal,
      );
      outcome = await this.#runLoop(context, (text) => {
        latestText = text;
      });
    } catch (error) {
      outcome = outcomeForError(error, budget, latestText);
    } finally {
      const rememberBoundaryFailure = (error: unknown): void => {
        if (!outcome || outcome.termination === "completed") {
          outcome = outcomeForError(error, budget, latestText);
        }
      };
      try {
        for (const record of ledger.interruptUnfinished(
          "run이 종료되어 도구 결과의 실행 여부를 더 확인할 수 없습니다.",
        )) {
          this.#emitAndAppendResult(context, record);
        }
      } catch (error) {
        rememberBoundaryFailure(error);
      }
      try {
        interactionLease?.release();
      } catch (error) {
        rememberBoundaryFailure(error);
      }
      try {
        budget.cleanup();
      } catch (error) {
        rememberBoundaryFailure(error);
      }
      try {
        ownership.lease.release();
      } catch (error) {
        rememberBoundaryFailure(error);
      }
      outcome ??= outcomeForError(
        new ProtocolError("agent loop가 종료 결과 없이 끝났습니다."),
        budget,
        latestText,
      );
      state.finish(outcome.termination);
      journal.end(outcome.termination, outcome.message);
    }

    if (!outcome) throw new Error("agent loop 종료 결과가 유실되었습니다.");

    return {
      ...identity,
      termination: outcome.termination,
      ...(outcome.message === undefined ? {} : { message: outcome.message }),
      text: outcome.text,
      messages: Object.freeze([...messages]),
      usage: Object.freeze({ ...context.usage }),
      budget: budget.snapshot(),
      toolExecutions: ledger.records(),
      events: journal.events(),
      ...(outcome.responseId === undefined ? {} : { responseId: outcome.responseId }),
    };
  }

  async #runLoop(
    context: OwnedRunContext,
    setLatestText: (text: string) => void,
  ): Promise<LoopOutcome> {
    let latestText = "";
    let responseId: string | undefined;
    context.state.transition("MODEL");
    while (context.state.state !== "FINISH") {
      context.budget.assertActive();
      context.budget.consumeTurn();
      context.budget.consumeModelRequest();
      const tools = context.allowTools ? this.#executor.providerTools() : [];
      const turn = await this.#collectProviderTurn(context, tools);
      if (turn.cancelledReason !== undefined) {
        return {
          termination: context.budget.exhaustion
            ? "budget_exhausted"
            : "cancelled",
          text: latestText,
          message: turn.cancelledReason,
          ...(turn.responseId === undefined ? {} : { responseId: turn.responseId }),
        };
      }
      responseId = turn.responseId ?? responseId;
      context.budget.assertActive();
      context.state.transition("NORMALIZE");
      const normalized = context.normalizer.normalize({
        runId: context.identity.runId,
        turn: context.budget.snapshot().turns,
        text: turn.text,
        nativeCalls: turn.nativeCalls,
        tools,
      });
      turn.gate.finish(normalized.visibleText);
      if (normalized.visibleText) {
        latestText = normalized.visibleText;
        setLatestText(latestText);
      }

      this.#appendAssistantMessage(
        context,
        turn.text,
        normalized.visibleText,
        normalized.calls,
        normalized.fallbackUsed,
      );

      const fatalIssue = normalized.issues.find((item) => !item.recoverable);
      if (fatalIssue) {
        return {
          termination: "protocol_error",
          text: latestText,
          message: fatalIssue.message,
          ...(responseId === undefined ? {} : { responseId }),
        };
      }
      if (normalized.calls.length === 0 && normalized.issues.length === 0) {
        if (!normalized.visibleText.trim()) {
          throw new ProtocolError("모델이 최종 답변이나 도구 호출을 반환하지 않았습니다.");
        }
        return {
          termination: "completed",
          text: normalized.visibleText,
          ...(responseId === undefined ? {} : { responseId }),
        };
      }

      context.state.transition("AUTHORIZE_TOOLS");
      context.ledger.register(normalized.calls);
      const allowance = Math.max(
        4_096,
        Math.floor(
          MODEL_TOOL_RESULTS_PER_TURN_BYTES /
            Math.max(1, normalized.calls.length),
        ),
      );
      for (let index = 0; index < normalized.calls.length; index += 1) {
        const call = normalized.calls[index];
        if (!call) continue;
        context.budget.assertActive();
        const repetition = context.progress.blockBefore(call);
        if (repetition) {
          context.journal.emit({
            type: "notice",
            level: "warning",
            code: "no_progress",
            message: repetition.message,
          });
          this.#closeReadyCalls(
            context,
            "no_progress",
            repetition.message,
            allowance,
          );
          return {
            termination: "no_progress",
            text: latestText,
            message: repetition.message,
            ...(responseId === undefined ? {} : { responseId }),
          };
        }
        context.budget.consumeToolCall();
        context.journal.emit({
          type: "tool_start",
          callId: call.callId,
          toolName: call.name,
          input: call.input as JsonObject,
        });
        const executionContext: ToolExecutionContext = {
          ...context.identity,
          workspace: this.#workspace,
          workspaceTrusted: this.#workspaceTrusted,
          signal: context.budget.signal,
        };
        let result: ToolExecutionResult;
        try {
          result = await this.#interactions.withToolCall(
            context.identity.runId,
            call.callId,
            async () => await this.#executor.execute(
              call.name,
              call.input,
              executionContext,
              {
                handlerStarted: () => {
                  context.ledger.markStarted(call.callId);
                },
              },
            ),
          );
        } catch (error) {
          result = failureFromThrown(
            error,
            context.ledger.get(call.callId)?.status === "started",
          );
        }
        const record = context.ledger.finish(call.callId, result);
        this.#emitAndAppendResult(context, record, allowance);
        context.progress.observe(record);

        if (result.status === "denied") {
          this.#closeReadyCalls(
            context,
            "denied",
            "앞선 도구 호출이 거부되어 같은 batch의 남은 도구를 실행하지 않았습니다.",
            allowance,
          );
          return {
            termination: "permission_denied",
            text: latestText,
            message: result.reason,
            ...(responseId === undefined ? {} : { responseId }),
          };
        }
        if (result.status === "cancelled" || context.budget.signal.aborted) {
          this.#closeReadyCalls(
            context,
            "cancelled",
            "run이 취소되어 같은 batch의 남은 도구를 실행하지 않았습니다.",
            allowance,
          );
          return {
            termination: context.budget.exhaustion
              ? "budget_exhausted"
              : "cancelled",
            text: latestText,
            message: result.status === "cancelled"
              ? result.reason ?? "도구 실행 중 작업이 취소됐습니다."
              : context.budget.exhaustion
                ? `실행 예산이 소진되었습니다: ${context.budget.exhaustion}`
                : "도구 완료 뒤 run 취소를 확인했습니다.",
            ...(responseId === undefined ? {} : { responseId }),
          };
        }
      }

      if (normalized.issues.length > 0) {
        context.budget.assertActive();
        if (!context.budget.tryConsumeRecovery("malformed_tool_call")) {
          return {
            termination: context.budget.exhaustion
              ? "budget_exhausted"
              : "cancelled",
            text: latestText,
            message: context.budget.exhaustion
              ? "잘못된 도구 호출을 교정하는 복구 예산이 소진되었습니다."
              : "잘못된 도구 호출을 교정하기 전에 run이 취소됐습니다.",
            ...(responseId === undefined ? {} : { responseId }),
          };
        }
        context.journal.emit({
          type: "notice",
          level: "warning",
          code: "malformed_tool_call_recovery",
          message: "잘못된 도구 호출에 대해 한 번의 제한된 교정 feedback을 전달합니다.",
        });
        this.#appendUserFeedback(context, normalizationFeedback(normalized.issues));
      }
      context.state.transition("MODEL");
    }
    throw new ProtocolError("종료 상태 밖에서 agent loop가 끝났습니다.");
  }

  async #collectProviderTurn(
    context: OwnedRunContext,
    tools: readonly ProviderToolSpec[],
  ): Promise<ProviderTurn> {
    const nativeCalls: NativeToolCall[] = [];
    const textParts: string[] = [];
    let textBytes = 0;
    let providerEventCount = 0;
    let nativeCallBytes = 0;
    let completed = false;
    let cancelledReason: string | undefined;
    let responseId: string | undefined;
    const gate = new TextDeltaGate(
      context.journal,
      context.normalizer.fallbackMode !== "disabled",
    );
    const request: ProviderRequest = {
      runId: context.identity.runId,
      model: this.#model,
      messages: context.messages,
      tools,
      retryBudget: context.budget,
      ...(this.#maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: this.#maxOutputTokens }),
      ...(this.#reasoningEffort === undefined
        ? {}
        : { reasoningEffort: this.#reasoningEffort }),
      ...(this.#temperature === undefined
        ? {}
        : { temperature: this.#temperature }),
    };

    for await (const event of this.#provider.stream(request, context.budget.signal)) {
      context.budget.assertActive();
      providerEventCount += 1;
      if (providerEventCount > MAX_PROVIDER_EVENTS_PER_TURN) {
        throw new ProtocolError("한 모델 turn의 provider 이벤트 수가 허용 한도를 초과했습니다.");
      }
      if (completed || cancelledReason !== undefined) {
        throw new ProtocolError("provider가 terminal event 뒤에 추가 event를 보냈습니다.");
      }
      switch (event.type) {
        case "text_delta": {
          textBytes += Buffer.byteLength(event.text, "utf8");
          if (textBytes > MAX_ASSISTANT_TEXT_BYTES) {
            throw new ProtocolError("모델 텍스트 응답이 크기 제한을 초과했습니다.");
          }
          textParts.push(event.text);
          gate.push(event.text);
          break;
        }
        case "tool_call": {
          if (nativeCalls.length >= context.normalizer.maximumCallsPerResponse) {
            throw new ProtocolError(
              "한 응답의 native 도구 호출 수가 허용 한도를 초과했습니다.",
            );
          }
          let serializedCall: string;
          try {
            const serialized = JSON.stringify({
              callId: event.callId,
              name: event.name,
              input: event.input,
            });
            if (serialized === undefined) throw new Error("undefined_json");
            serializedCall = serialized;
          } catch {
            throw new ProtocolError("native 도구 호출을 JSON으로 읽지 못했습니다.");
          }
          const callBytes = Buffer.byteLength(serializedCall, "utf8");
          if (callBytes > MAX_NATIVE_TOOL_CALL_BYTES) {
            throw new ProtocolError("native 도구 호출 하나가 크기 제한을 초과했습니다.");
          }
          nativeCallBytes += callBytes;
          if (nativeCallBytes > MAX_NATIVE_TOOL_CALLS_BYTES) {
            throw new ProtocolError("native 도구 호출 전체가 크기 제한을 초과했습니다.");
          }
          const parsedCall = JSON.parse(serializedCall) as unknown;
          if (
            typeof parsedCall !== "object" ||
            parsedCall === null ||
            Array.isArray(parsedCall)
          ) {
            throw new ProtocolError("native 도구 호출 형식이 올바르지 않습니다.");
          }
          const snapshot = parsedCall as Record<string, unknown>;
          if (
            typeof snapshot.callId !== "string" ||
            typeof snapshot.name !== "string" ||
            typeof snapshot.input !== "object" ||
            snapshot.input === null ||
            Array.isArray(snapshot.input)
          ) {
            throw new ProtocolError("native 도구 호출 형식이 올바르지 않습니다.");
          }
          nativeCalls.push({
            callId: snapshot.callId,
            name: snapshot.name,
            input: snapshot.input as JsonObject,
          });
          break;
        }
        case "usage": {
          const usage = stableProviderUsage(event.usage);
          mergeUsage(context.usage, usage);
          context.journal.emit({ type: "usage", usage });
          break;
        }
        case "completed":
          if (
            event.responseId !== undefined &&
            (typeof event.responseId !== "string" ||
              !event.responseId ||
              Buffer.byteLength(event.responseId, "utf8") >
                MAX_PROVIDER_RESPONSE_ID_BYTES ||
              /[\u0000-\u001f\u007f]/u.test(event.responseId))
          ) {
            throw new ProtocolError("provider 응답 ID가 올바르지 않습니다.");
          }
          completed = true;
          responseId = event.responseId;
          break;
        case "cancelled": {
          const reason = event.reason ?? "모델 요청이 취소됐습니다.";
          if (typeof reason !== "string") {
            throw new ProtocolError("provider 취소 사유가 올바르지 않습니다.");
          }
          cancelledReason = boundedString(reason, MAX_PROVIDER_REASON_BYTES).text;
          break;
        }
      }
    }
    if (!completed && cancelledReason === undefined) {
      throw new ProtocolError("provider stream이 terminal event 없이 끝났습니다.");
    }
    return {
      text: textParts.join(""),
      nativeCalls: Object.freeze(nativeCalls),
      cancelledReason,
      responseId,
      gate,
    };
  }

  #appendAssistantMessage(
    context: OwnedRunContext,
    rawText: string,
    visibleText: string,
    calls: readonly NormalizedToolCall[],
    fallbackUsed: boolean,
  ): void {
    const content: Array<{ type: "text"; text: string } | ToolCallContent> = [];
    const retainedText = fallbackUsed ? rawText : visibleText;
    if (retainedText) content.push({ type: "text", text: retainedText });
    if (!fallbackUsed) {
      for (const call of calls) {
        content.push({
          type: "tool_call",
          callId: call.callId,
          name: call.name,
          input: call.input as JsonObject,
        });
      }
    }
    if (content.length === 0) return;
    const message: AssistantMessage = {
      role: "assistant",
      id: `message:${context.identity.runId}:assistant:${context.budget.snapshot().turns}`,
      createdAt: this.#timestamp(),
      content,
    };
    context.messages.push(message);
  }

  #appendUserFeedback(context: OwnedRunContext, text: string): void {
    const message: UserMessage = {
      role: "user",
      id: `message:${context.identity.runId}:feedback:${context.messages.length}`,
      createdAt: this.#timestamp(),
      content: [{ type: "text", text }],
    };
    context.messages.push(message);
  }

  #emitAndAppendResult(
    context: OwnedRunContext,
    record: ToolCallExecutionRecord,
    maximumBytes = 64 * 1024,
  ): void {
    if (!record.result || context.appendedResults.has(record.callId)) return;
    context.appendedResults.add(record.callId);
    context.journal.emit({
      type: "tool_result",
      callId: record.callId,
      toolName: record.toolName,
      result: record.result,
    });
    const modelResult = resultForModel(record.result, maximumBytes);
    if (record.source === "native") {
      const message: ToolMessage = {
        role: "tool",
        id: `message:${context.identity.runId}:tool:${record.callId}`,
        createdAt: this.#timestamp(),
        callId: record.callId,
        toolName: record.toolName,
        result: modelResult,
      };
      context.messages.push(message);
      return;
    }
    this.#appendUserFeedback(
      context,
      `Tool result for ${record.toolName}:\n${JSON.stringify(modelResult)}\n` +
        "Continue the original task. Do not repeat this call as plain text.",
    );
  }

  #closeReadyCalls(
    context: OwnedRunContext,
    status: "denied" | "cancelled" | "no_progress",
    reason: string,
    maximumBytes: number,
  ): void {
    for (const record of context.ledger.records()) {
      if (record.status !== "ready") continue;
      const result: ToolExecutionResult = status === "denied"
        ? { status: "denied", reason }
        : status === "cancelled"
          ? { status: "cancelled", reason }
          : {
              status: "failure",
              error: {
                code: "repeated_tool_call",
                message: reason,
                retryable: false,
              },
              execution: "not_started",
            };
      this.#emitAndAppendResult(
        context,
        context.ledger.finish(record.callId, result),
        maximumBytes,
      );
    }
  }

  #timestamp(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ConfigurationError("agent message 시간이 올바르지 않습니다.");
    }
    return value;
  }
}

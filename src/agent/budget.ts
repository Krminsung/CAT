import {
  BudgetExhaustedError,
  CancelledError,
  ConfigurationError,
} from "../core/errors.js";
import type {
  RetryBudgetPort,
  RunBudget,
  TransportRetryRequest,
} from "../core/execution.js";

export type RecoveryKind =
  | "malformed_tool_call"
  | "compaction"
  | "stop_hook"
  | "web";

export type RunBudgetExhaustion =
  | "turns"
  | "model_requests"
  | "tool_calls"
  | "recovery_attempts"
  | "compactions"
  | "stop_continuations"
  | "wall_clock";

export interface AgentRunLimits {
  readonly maxTurns: number;
  readonly maxModelRequests: number;
  readonly maxToolCalls: number;
  readonly maxRecoveryAttempts: number;
  readonly maxSameRecoveryKind: number;
  readonly maxCompactions: number;
  readonly maxStopContinuations: number;
  readonly wallClockMs: number;
}

export const DEFAULT_AGENT_RUN_LIMITS: AgentRunLimits = Object.freeze({
  maxTurns: 12,
  maxModelRequests: 24,
  maxToolCalls: 40,
  maxRecoveryAttempts: 2,
  maxSameRecoveryKind: 1,
  maxCompactions: 1,
  maxStopContinuations: 1,
  wallClockMs: 10 * 60 * 1_000,
});

const LIMIT_BOUNDS = Object.freeze({
  maxTurns: [1, 100],
  maxModelRequests: [1, 200],
  maxToolCalls: [1, 1_000],
  maxRecoveryAttempts: [0, 20],
  maxSameRecoveryKind: [0, 20],
  maxCompactions: [0, 10],
  maxStopContinuations: [0, 10],
  wallClockMs: [1_000, 60 * 60 * 1_000],
} satisfies Record<keyof AgentRunLimits, readonly [number, number]>);

function boundedInteger(
  value: number,
  name: keyof AgentRunLimits,
): number {
  const [minimum, maximum] = LIMIT_BOUNDS[name];
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(
      `${name}은 ${minimum}–${maximum} 범위의 정수여야 합니다.`,
    );
  }
  return value;
}

export function resolveAgentRunLimits(
  overrides: Partial<AgentRunLimits> = {},
): AgentRunLimits {
  const merged = { ...DEFAULT_AGENT_RUN_LIMITS, ...overrides };
  return Object.freeze({
    maxTurns: boundedInteger(merged.maxTurns, "maxTurns"),
    maxModelRequests: boundedInteger(
      merged.maxModelRequests,
      "maxModelRequests",
    ),
    maxToolCalls: boundedInteger(merged.maxToolCalls, "maxToolCalls"),
    maxRecoveryAttempts: boundedInteger(
      merged.maxRecoveryAttempts,
      "maxRecoveryAttempts",
    ),
    maxSameRecoveryKind: boundedInteger(
      merged.maxSameRecoveryKind,
      "maxSameRecoveryKind",
    ),
    maxCompactions: boundedInteger(
      merged.maxCompactions,
      "maxCompactions",
    ),
    maxStopContinuations: boundedInteger(
      merged.maxStopContinuations,
      "maxStopContinuations",
    ),
    wallClockMs: boundedInteger(merged.wallClockMs, "wallClockMs"),
  });
}

export interface RunBudgetControllerOptions {
  readonly limits?: Partial<AgentRunLimits>;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

interface MutableRunBudget {
  turns: number;
  modelRequests: number;
  toolCalls: number;
  recoveryAttempts: number;
  compactions: number;
  stopContinuations: number;
}

const RECOVERY_KIND_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

export class RunBudgetController implements RetryBudgetPort {
  readonly limits: AgentRunLimits;
  readonly #now: () => number;
  readonly #startedAt: number;
  readonly #deadlineAt: number;
  readonly #controller = new AbortController();
  readonly #callerSignal: AbortSignal | undefined;
  readonly #callerAbortListener: (() => void) | undefined;
  readonly #timer: NodeJS.Timeout;
  readonly #used: MutableRunBudget = {
    turns: 0,
    modelRequests: 0,
    toolCalls: 0,
    recoveryAttempts: 0,
    compactions: 0,
    stopContinuations: 0,
  };
  readonly #recoveryByKind = new Map<string, number>();
  #exhaustion: RunBudgetExhaustion | undefined;
  #callerCancelled = false;
  #cleaned = false;

  constructor(options: RunBudgetControllerOptions = {}) {
    this.limits = resolveAgentRunLimits(options.limits);
    this.#now = options.now ?? Date.now;
    this.#startedAt = this.#now();
    if (!Number.isSafeInteger(this.#startedAt) || this.#startedAt < 0) {
      throw new ConfigurationError("실행 시작 시간이 올바르지 않습니다.");
    }
    this.#deadlineAt = this.#startedAt + this.limits.wallClockMs;
    this.#callerSignal = options.signal;
    this.#callerAbortListener = options.signal
      ? () => {
          this.#callerCancelled = true;
          this.#controller.abort();
        }
      : undefined;
    if (options.signal?.aborted) {
      this.#callerAbortListener?.();
    } else if (options.signal && this.#callerAbortListener) {
      options.signal.addEventListener("abort", this.#callerAbortListener, {
        once: true,
      });
    }
    this.#timer = setTimeout(() => {
      this.#markExhausted("wall_clock");
    }, this.limits.wallClockMs);
    this.#timer.unref();
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get startedAt(): number {
    return this.#startedAt;
  }

  get deadlineAt(): number {
    return this.#deadlineAt;
  }

  get exhaustion(): RunBudgetExhaustion | undefined {
    this.#refreshDeadline();
    return this.#exhaustion;
  }

  get callerCancelled(): boolean {
    return this.#callerCancelled;
  }

  get cleaned(): boolean {
    return this.#cleaned;
  }

  snapshot(): RunBudget {
    this.#refreshDeadline();
    return Object.freeze({
      ...this.#used,
      deadlineAt: this.#deadlineAt,
    });
  }

  recoveryCount(kind: RecoveryKind): number {
    return this.#recoveryByKind.get(kind) ?? 0;
  }

  assertActive(): void {
    this.#refreshDeadline();
    if (this.#exhaustion) {
      throw new BudgetExhaustedError(
        `실행 예산이 소진되었습니다: ${this.#exhaustion}`,
      );
    }
    if (this.#controller.signal.aborted || this.#cleaned) {
      throw new CancelledError("실행이 취소됐습니다.");
    }
  }

  consumeTurn(): void {
    this.#consume("turns", this.limits.maxTurns, "turns");
  }

  consumeModelRequest(): void {
    this.#consume(
      "modelRequests",
      this.limits.maxModelRequests,
      "model_requests",
    );
  }

  consumeToolCall(): void {
    this.#consume("toolCalls", this.limits.maxToolCalls, "tool_calls");
  }

  tryConsumeRetry(request: TransportRetryRequest): boolean {
    if (
      request.owner !== "model_transport" ||
      !Number.isSafeInteger(request.attempt) ||
      request.attempt < 1
    ) {
      return false;
    }
    return this.#tryConsume(
      "modelRequests",
      this.limits.maxModelRequests,
      "model_requests",
    );
  }

  tryConsumeRecovery(kind: RecoveryKind): boolean {
    return this.#tryConsumeRecovery(kind);
  }

  tryConsumeCompaction(): boolean {
    if (this.#used.compactions >= this.limits.maxCompactions) {
      this.#markExhausted("compactions");
      return false;
    }
    if (!this.#tryConsumeRecovery("compaction")) return false;
    this.#used.compactions += 1;
    return true;
  }

  tryConsumeStopContinuation(): boolean {
    if (this.#used.stopContinuations >= this.limits.maxStopContinuations) {
      this.#markExhausted("stop_continuations");
      return false;
    }
    if (!this.#tryConsumeRecovery("stop_hook")) return false;
    this.#used.stopContinuations += 1;
    return true;
  }

  cleanup(): boolean {
    if (this.#cleaned) return false;
    this.#cleaned = true;
    clearTimeout(this.#timer);
    if (this.#callerSignal && this.#callerAbortListener) {
      this.#callerSignal.removeEventListener(
        "abort",
        this.#callerAbortListener,
      );
    }
    if (!this.#controller.signal.aborted) this.#controller.abort();
    return true;
  }

  #tryConsumeRecovery(kind: RecoveryKind): boolean {
    if (!RECOVERY_KIND_PATTERN.test(kind)) return false;
    this.#refreshDeadline();
    if (this.#controller.signal.aborted || this.#cleaned) return false;
    if (
      this.#used.recoveryAttempts >= this.limits.maxRecoveryAttempts ||
      (this.#recoveryByKind.get(kind) ?? 0) >=
        this.limits.maxSameRecoveryKind
    ) {
      this.#markExhausted("recovery_attempts");
      return false;
    }
    this.#used.recoveryAttempts += 1;
    this.#recoveryByKind.set(kind, (this.#recoveryByKind.get(kind) ?? 0) + 1);
    return true;
  }

  #consume(
    counter: "turns" | "modelRequests" | "toolCalls",
    maximum: number,
    exhaustion: RunBudgetExhaustion,
  ): void {
    this.assertActive();
    if (this.#used[counter] >= maximum) {
      this.#markExhausted(exhaustion);
      throw new BudgetExhaustedError(
        `실행 예산이 소진되었습니다: ${exhaustion}`,
      );
    }
    this.#used[counter] += 1;
  }

  #tryConsume(
    counter: "modelRequests",
    maximum: number,
    exhaustion: RunBudgetExhaustion,
  ): boolean {
    this.#refreshDeadline();
    if (this.#controller.signal.aborted || this.#cleaned) return false;
    if (this.#used[counter] >= maximum) {
      this.#markExhausted(exhaustion);
      return false;
    }
    this.#used[counter] += 1;
    return true;
  }

  #refreshDeadline(): void {
    if (
      !this.#exhaustion &&
      !this.#cleaned &&
      this.#now() >= this.#deadlineAt
    ) {
      this.#markExhausted("wall_clock");
    }
  }

  #markExhausted(exhaustion: RunBudgetExhaustion): void {
    if (this.#callerCancelled) return;
    this.#exhaustion ??= exhaustion;
    if (!this.#controller.signal.aborted) this.#controller.abort();
  }
}

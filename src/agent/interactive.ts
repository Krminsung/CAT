import { createHash } from "node:crypto";
import { CancelledError, ConfigurationError } from "../core/errors.js";
import type {
  AgentPlanStep,
  ApprovalChoice,
  PlanStepStatus,
  UserInputOption,
} from "../core/events.js";
import type { JsonObject } from "../core/json.js";
import type { ToolExecutionResult } from "../core/tools.js";
import type {
  ApprovalPromptPort,
  ApprovalRequest,
} from "../security/permissions.js";
import type { ToolRegistry } from "../tools/runtime.js";
import type { AgentEventWriter } from "./events.js";

export interface ApprovalDecisionPort {
  decideApproval(
    request: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<ApprovalChoice>;
}

export interface UserInputRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly callId: string;
  readonly question: string;
  readonly options: readonly UserInputOption[];
}

export interface UserInputDecisionPort {
  requestInput(
    request: UserInputRequest,
    signal: AbortSignal,
  ): Promise<string>;
}

export interface AgentInteractionHubOptions {
  readonly approvals?: ApprovalDecisionPort;
  readonly userInput?: UserInputDecisionPort;
}

interface AttachedRun {
  readonly sessionId: string;
  readonly events: AgentEventWriter;
  activeCallId: string | undefined;
  readonly token: symbol;
}

export class AgentInteractionLease {
  readonly #releaseOwned: () => boolean;
  #released = false;

  constructor(releaseOwned: () => boolean) {
    this.#releaseOwned = releaseOwned;
  }

  release(): boolean {
    if (this.#released) return false;
    this.#released = true;
    return this.#releaseOwned();
  }
}

export class AgentInteractionHub implements ApprovalPromptPort {
  readonly #approvals: ApprovalDecisionPort | undefined;
  readonly #userInput: UserInputDecisionPort | undefined;
  readonly #runs = new Map<string, AttachedRun>();

  constructor(options: AgentInteractionHubOptions = {}) {
    this.#approvals = options.approvals;
    this.#userInput = options.userInput;
  }

  get supportsUserInput(): boolean {
    return this.#userInput !== undefined;
  }

  attach(
    sessionId: string,
    runId: string,
    events: AgentEventWriter,
  ): AgentInteractionLease {
    if (this.#runs.has(runId)) {
      throw new Error(`run 상호작용이 이미 연결되었습니다: ${runId}`);
    }
    const token = Symbol(runId);
    this.#runs.set(runId, {
      sessionId,
      events,
      activeCallId: undefined,
      token,
    });
    return new AgentInteractionLease(() => {
      const attached = this.#runs.get(runId);
      if (!attached || attached.token !== token) return false;
      this.#runs.delete(runId);
      return true;
    });
  }

  async withToolCall<Result>(
    runId: string,
    callId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const attached = this.#required(runId);
    if (attached.activeCallId !== undefined) {
      throw new Error("동일 run에서 도구 상호작용을 중첩할 수 없습니다.");
    }
    attached.activeCallId = callId;
    try {
      return await operation();
    } finally {
      if (attached.activeCallId === callId) attached.activeCallId = undefined;
    }
  }

  async requestApproval(
    request: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<ApprovalChoice> {
    const attached = this.#required(request.runId);
    const callId = this.#activeCall(attached);
    if (attached.sessionId !== request.sessionId) {
      throw new Error("승인 요청의 session이 활성 run과 일치하지 않습니다.");
    }
    if (signal.aborted) throw new CancelledError("승인 요청이 취소됐습니다.");
    attached.events.emit({
      type: "approval_required",
      requestId: request.requestId,
      callId,
      summary: request.summary,
      permission: request.permission,
      choices: request.choices,
    });
    if (!this.#approvals) {
      throw new Error("사용자 승인 decision port가 연결되지 않았습니다.");
    }
    const decision = await this.#approvals.decideApproval(request, signal);
    if (!request.choices.includes(decision)) {
      throw new Error("승인 decision port가 올바르지 않은 선택을 반환했습니다.");
    }
    return decision;
  }

  planUpdated(
    runId: string,
    explanation: string,
    plan: readonly AgentPlanStep[],
  ): void {
    this.#required(runId).events.emit({
      type: "plan_update",
      explanation,
      plan,
    });
  }

  async requestUserInput(
    runId: string,
    question: string,
    options: readonly UserInputOption[],
    signal: AbortSignal,
  ): Promise<string> {
    const attached = this.#required(runId);
    const callId = this.#activeCall(attached);
    if (!this.#userInput) {
      throw new Error("사용자 입력 decision port가 연결되지 않았습니다.");
    }
    const digest = createHash("sha256")
      .update(`${runId}\0${callId}\0${question}`, "utf8")
      .digest("hex")
      .slice(0, 16);
    const request: UserInputRequest = Object.freeze({
      requestId: `input:${runId}:${digest}`,
      sessionId: attached.sessionId,
      runId,
      callId,
      question,
      options,
    });
    if (signal.aborted) throw new CancelledError("사용자 입력 요청이 취소됐습니다.");
    attached.events.emit({
      type: "user_input_required",
      requestId: request.requestId,
      callId,
      question,
      options,
    });
    try {
      const answer = await this.#userInput.requestInput(request, signal);
      if (signal.aborted) throw new CancelledError("사용자 입력 대기 중 작업이 취소됐습니다.");
      if (!options.some((option) => option.label === answer)) {
        throw new Error("사용자 입력 결과가 제공된 선택지와 일치하지 않습니다.");
      }
      attached.events.emit({
        type: "user_input_result",
        requestId: request.requestId,
        callId,
        answer,
        cancelled: false,
      });
      return answer;
    } catch (error) {
      attached.events.emit({
        type: "user_input_result",
        requestId: request.requestId,
        callId,
        cancelled: true,
      });
      throw error;
    }
  }

  #required(runId: string): AttachedRun {
    const attached = this.#runs.get(runId);
    if (!attached) throw new Error(`활성 상호작용 run을 찾을 수 없습니다: ${runId}`);
    return attached;
  }

  #activeCall(attached: AttachedRun): string {
    if (!attached.activeCallId) {
      throw new Error("활성 도구 호출 없이 사용자 상호작용을 요청할 수 없습니다.");
    }
    return attached.activeCallId;
  }
}

export class AgentPlanStore {
  readonly #plans = new Map<string, readonly AgentPlanStep[]>();

  update(sessionId: string, plan: readonly AgentPlanStep[]): void {
    this.#plans.set(
      sessionId,
      Object.freeze(plan.map((step) => Object.freeze({ ...step }))),
    );
  }

  get(sessionId: string): readonly AgentPlanStep[] | undefined {
    return this.#plans.get(sessionId);
  }

  clear(sessionId: string): void {
    this.#plans.delete(sessionId);
  }
}

export interface AgentControlToolOptions {
  readonly interactions: AgentInteractionHub;
  readonly plans?: AgentPlanStore;
}

const CONTROL_TOOL_OUTPUT_BYTES = 64 * 1024;
const PLAN_STATUSES = new Set<PlanStepStatus>([
  "pending",
  "in_progress",
  "completed",
]);

function objectSchema(properties: JsonObject, required: readonly string[]): JsonObject {
  return {
    type: "object",
    properties,
    required: [...required],
    additionalProperties: false,
  };
}

function success(content: JsonObject): ToolExecutionResult {
  return { status: "success", output: { content, truncated: false } };
}

function parsePlan(input: JsonObject): {
  explanation: string;
  plan: readonly AgentPlanStep[];
} {
  const explanation = input.explanation;
  const rawPlan = input.plan;
  if (typeof explanation !== "string" || !Array.isArray(rawPlan)) {
    throw new ConfigurationError("계획 입력 형식이 올바르지 않습니다.");
  }
  const plan = rawPlan.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ConfigurationError("각 계획 단계는 객체여야 합니다.");
    }
    const step = value.step;
    const status = value.status;
    if (
      typeof step !== "string" ||
      !step.trim() ||
      typeof status !== "string" ||
      !PLAN_STATUSES.has(status as PlanStepStatus)
    ) {
      throw new ConfigurationError("계획 단계의 내용 또는 상태가 올바르지 않습니다.");
    }
    return Object.freeze({ step: step.trim(), status: status as PlanStepStatus });
  });
  if (plan.filter((step) => step.status === "in_progress").length > 1) {
    throw new ConfigurationError("in_progress 계획 단계는 한 번에 하나만 둘 수 있습니다.");
  }
  return {
    explanation: explanation.trim(),
    plan: Object.freeze(plan),
  };
}

function parseOptions(input: JsonObject): {
  question: string;
  options: readonly UserInputOption[];
} {
  const question = input.question;
  const rawOptions = input.options;
  if (typeof question !== "string" || !question.trim() || !Array.isArray(rawOptions)) {
    throw new ConfigurationError("사용자 입력 요청 형식이 올바르지 않습니다.");
  }
  const options = rawOptions.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ConfigurationError("각 사용자 선택지는 객체여야 합니다.");
    }
    const label = value.label;
    const description = value.description;
    if (
      typeof label !== "string" ||
      !label.trim() ||
      typeof description !== "string" ||
      !description.trim()
    ) {
      throw new ConfigurationError("사용자 선택지의 label과 description이 필요합니다.");
    }
    return Object.freeze({
      label: label.trim(),
      description: description.trim(),
    });
  });
  const labels = options.map((option) => option.label);
  if (new Set(labels).size !== labels.length) {
    throw new ConfigurationError("사용자 선택지 label은 서로 달라야 합니다.");
  }
  return { question: question.trim(), options: Object.freeze(options) };
}

export function registerAgentControlTools(
  registry: ToolRegistry,
  options: AgentControlToolOptions,
): AgentPlanStore {
  const plans = options.plans ?? new AgentPlanStore();
  registry.register({
    definition: {
      name: "update_plan",
      description: "Create or update the visible execution plan; at most one step may be in_progress.",
      inputSchema: objectSchema(
        {
          explanation: { type: "string", maxLength: 4_096 },
          plan: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: objectSchema(
              {
                step: { type: "string", minLength: 1, maxLength: 4_096 },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                },
              },
              ["step", "status"],
            ),
          },
        },
        ["explanation", "plan"],
      ),
      category: "read",
      permission: { kind: "none" },
      outputLimitBytes: CONTROL_TOOL_OUTPUT_BYTES,
      handler: async (input, context) => {
        const update = parsePlan(input);
        plans.update(context.sessionId, update.plan);
        options.interactions.planUpdated(
          context.runId,
          update.explanation,
          update.plan,
        );
        return success({
          explanation: update.explanation,
          plan: update.plan.map((step) => ({ ...step })),
        });
      },
    },
  });

  if (options.interactions.supportsUserInput) {
    registry.register({
      definition: {
        name: "request_user_input",
        description: "Ask one necessary multiple-choice question when a material decision blocks progress.",
        inputSchema: objectSchema(
          {
            question: { type: "string", minLength: 1, maxLength: 4_096 },
            options: {
              type: "array",
              minItems: 2,
              maxItems: 4,
              items: objectSchema(
                {
                  label: { type: "string", minLength: 1, maxLength: 128 },
                  description: { type: "string", minLength: 1, maxLength: 1_024 },
                },
                ["label", "description"],
              ),
            },
          },
          ["question", "options"],
        ),
        category: "read",
        permission: { kind: "none" },
        outputLimitBytes: CONTROL_TOOL_OUTPUT_BYTES,
        handler: async (input, context) => {
          const request = parseOptions(input);
          try {
            const answer = await options.interactions.requestUserInput(
              context.runId,
              request.question,
              request.options,
              context.signal,
            );
            return success({ question: request.question, answer });
          } catch (error) {
            if (context.signal.aborted || error instanceof CancelledError) {
              return { status: "cancelled", reason: "사용자 입력 요청이 취소됐습니다." };
            }
            return {
              status: "failure",
              error: {
                code: "user_input_failed",
                message: error instanceof Error
                  ? error.message
                  : "사용자 입력을 받지 못했습니다.",
                retryable: false,
              },
              execution: "not_started",
            };
          }
        },
      },
    });
  }
  return plans;
}

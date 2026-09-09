import { createHash } from "node:crypto";
import type { ApprovalChoice } from "../core/events.js";
import type { RunIdentity } from "../core/execution.js";
import type { JsonObject, JsonValue } from "../core/json.js";
import type {
  PermissionRequirement,
  ToolCategory,
} from "../core/tools.js";

export type PermissionMode = "ask" | "auto-edit" | "full-auto" | "plan";

export interface ApprovalScope {
  kind: "workspace" | "path" | "paths" | "command" | "network" | "external" | "invocation";
  target: JsonObject;
}

export interface ApprovalRequest extends RunIdentity {
  requestId: string;
  toolName: string;
  category: ToolCategory;
  permission: PermissionRequirement;
  summary: string;
  rule: string;
  choices: readonly ApprovalChoice[];
}

export interface ApprovalPromptPort {
  requestApproval(
    request: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<ApprovalChoice>;
}

export interface ProjectApprovalPort {
  saveProjectApproval(rule: string): Promise<void>;
}

export interface PermissionPolicyOptions {
  mode?: PermissionMode;
  interactive?: boolean;
  enabledTools?: readonly string[];
  allowedTools?: readonly string[];
  deniedTools?: readonly string[];
  projectApprovals?: readonly string[];
  projectDenials?: readonly string[];
  prompt?: ApprovalPromptPort;
  projectStore?: ProjectApprovalPort;
}

export interface PermissionCheck {
  toolName: string;
  category: ToolCategory;
  permission: PermissionRequirement;
  summary: string;
  scope: ApprovalScope;
  workspace: string;
  sessionId: string;
  runId: string;
  signal: AbortSignal;
}

export type AuthorizationResult =
  | { allowed: true; source: "automatic" | "configured" | "once" | "session" | "project" }
  | { allowed: false; cancelled: boolean; reason: string };

const APPROVAL_CHOICES = ["once", "session", "project", "deny"] as const;

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("승인 범위를 JSON으로 표현할 수 없습니다.");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(",")}}`;
}

function ruleFor(check: PermissionCheck): string {
  const material = canonicalJson({
    category: check.category,
    permission: check.permission as unknown as JsonValue,
    scope: check.scope as unknown as JsonValue,
    tool: check.toolName,
    workspace: check.workspace,
  });
  const digest = createHash("sha256").update(material, "utf8").digest("hex");
  return `tool:${check.toolName}:${check.scope.kind}:${digest}`;
}

function automaticCategory(category: ToolCategory): boolean {
  return category === "read" || category === "web";
}

function modeAllows(mode: PermissionMode, category: ToolCategory): boolean {
  return mode === "full-auto" ||
    automaticCategory(category) ||
    (mode === "auto-edit" && category === "edit");
}

function mutationBlockedInPlan(category: ToolCategory): boolean {
  return category !== "read" && category !== "web";
}

function safeSet(values: readonly string[] | undefined): Set<string> {
  return new Set((values ?? []).filter((value) => value.length > 0 && value.length <= 512));
}

export class PermissionPolicy {
  #mode: PermissionMode;
  readonly #interactive: boolean;
  readonly #enabledTools: Set<string> | undefined;
  readonly #allowedTools: Set<string>;
  readonly #deniedTools: Set<string>;
  readonly #projectApprovals: Set<string>;
  readonly #projectDenials: Set<string>;
  readonly #sessionApprovals = new Map<string, Set<string>>();
  readonly #sessionDenials = new Map<string, Set<string>>();
  readonly #prompt: ApprovalPromptPort | undefined;
  readonly #projectStore: ProjectApprovalPort | undefined;

  constructor(options: PermissionPolicyOptions = {}) {
    this.#mode = options.mode ?? "ask";
    this.#interactive = options.interactive ?? false;
    this.#enabledTools = options.enabledTools
      ? safeSet(options.enabledTools)
      : undefined;
    this.#allowedTools = safeSet(options.allowedTools);
    this.#deniedTools = safeSet(options.deniedTools);
    this.#projectApprovals = safeSet(options.projectApprovals);
    this.#projectDenials = safeSet(options.projectDenials);
    this.#prompt = options.prompt;
    this.#projectStore = options.projectStore;
  }

  get mode(): PermissionMode {
    return this.#mode;
  }

  setMode(mode: PermissionMode): void {
    this.#mode = mode;
  }

  exposes(toolName: string, category: ToolCategory): boolean {
    if (this.#deniedTools.has(toolName)) return false;
    if (this.#enabledTools && !this.#enabledTools.has(toolName)) return false;
    return this.#mode !== "plan" || !mutationBlockedInPlan(category);
  }

  hardDenial(toolName: string): string | undefined {
    if (this.#deniedTools.has(toolName)) {
      return `${toolName} 도구는 명시적으로 차단되어 있습니다.`;
    }
    if (this.#enabledTools && !this.#enabledTools.has(toolName)) {
      return `${toolName} 도구는 현재 허용 목록에 없습니다.`;
    }
    return undefined;
  }

  resetSession(sessionId: string): void {
    this.#sessionApprovals.delete(sessionId);
    this.#sessionDenials.delete(sessionId);
  }

  async authorize(check: PermissionCheck): Promise<AuthorizationResult> {
    if (check.signal.aborted) {
      return { allowed: false, cancelled: true, reason: "승인 전에 작업이 취소되었습니다." };
    }
    const hardDenial = this.hardDenial(check.toolName);
    if (hardDenial) return { allowed: false, cancelled: false, reason: hardDenial };
    if (this.#mode === "plan" && mutationBlockedInPlan(check.category)) {
      return {
        allowed: false,
        cancelled: false,
        reason: "plan 모드에서는 읽기와 공개 웹 도구만 사용할 수 있습니다.",
      };
    }

    const rule = ruleFor(check);
    const sessionDenials = this.#sessionDenials.get(check.sessionId);
    if (this.#projectDenials.has(rule) || sessionDenials?.has(rule)) {
      return { allowed: false, cancelled: false, reason: "이 작업 범위는 이전 결정으로 거부되었습니다." };
    }
    if (modeAllows(this.#mode, check.category)) {
      return { allowed: true, source: "automatic" };
    }
    if (this.#allowedTools.has(check.toolName)) {
      return { allowed: true, source: "configured" };
    }
    if (this.#projectApprovals.has(rule)) {
      return { allowed: true, source: "project" };
    }
    if (this.#sessionApprovals.get(check.sessionId)?.has(rule)) {
      return { allowed: true, source: "session" };
    }
    if (!this.#interactive || !this.#prompt) {
      return {
        allowed: false,
        cancelled: false,
        reason: "비대화형 실행에서는 승인이 필요한 작업을 실행하지 않습니다.",
      };
    }

    let decision: ApprovalChoice;
    try {
      decision = await this.#prompt.requestApproval(
        {
          requestId: `approval:${check.runId}:${createHash("sha256").update(rule).digest("hex").slice(0, 16)}`,
          sessionId: check.sessionId,
          runId: check.runId,
          toolName: check.toolName,
          category: check.category,
          permission: check.permission,
          summary: check.summary,
          rule,
          choices: APPROVAL_CHOICES,
        },
        check.signal,
      );
    } catch {
      return {
        allowed: false,
        cancelled: check.signal.aborted,
        reason: check.signal.aborted
          ? "승인 대기 중 작업이 취소되었습니다."
          : "사용자 승인 요청이 취소되었거나 실패했습니다.",
      };
    }
    if (check.signal.aborted) {
      return { allowed: false, cancelled: true, reason: "승인 뒤 작업이 취소되었습니다." };
    }
    if (decision === "once") return { allowed: true, source: "once" };
    if (decision === "session") {
      const approvals = this.#sessionApprovals.get(check.sessionId) ?? new Set<string>();
      approvals.add(rule);
      this.#sessionApprovals.set(check.sessionId, approvals);
      return { allowed: true, source: "session" };
    }
    if (decision === "project") {
      if (!this.#projectStore) {
        return {
          allowed: false,
          cancelled: false,
          reason: "프로젝트 승인 저장소가 연결되지 않아 영구 승인을 적용하지 않았습니다.",
        };
      }
      try {
        await this.#projectStore.saveProjectApproval(rule);
      } catch {
        return {
          allowed: false,
          cancelled: false,
          reason: "프로젝트 승인을 저장하지 못해 작업을 실행하지 않았습니다.",
        };
      }
      this.#projectApprovals.add(rule);
      return { allowed: true, source: "project" };
    }

    const denials = sessionDenials ?? new Set<string>();
    denials.add(rule);
    this.#sessionDenials.set(check.sessionId, denials);
    return { allowed: false, cancelled: false, reason: "사용자가 이 작업을 거부했습니다." };
  }
}

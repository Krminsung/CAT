import type {
  ApprovalDecisionPort,
  UserInputDecisionPort,
  UserInputRequest,
} from "../agent/interactive.js";
import { CancelledError, ConfigurationError } from "../core/errors.js";
import type { ApprovalChoice } from "../core/events.js";
import type { ProviderUsage } from "../core/provider.js";
import type {
  ProviderDefinition,
  ProviderModel,
} from "../providers/catalog.js";
import type { BackgroundTaskOverview } from "../process/index.js";
import { PROVIDER_CATALOG } from "../providers/catalog.js";
import type {
  ApprovalPromptPort,
  ApprovalRequest,
  PermissionMode,
} from "../security/permissions.js";
import type { AuthStatus } from "./auth-service.js";
import type { CatTerminalScreen } from "../tui/screen.js";

const PERMISSION_MODES: readonly PermissionMode[] = Object.freeze([
  "ask",
  "auto-edit",
  "full-auto",
  "plan",
]);
const MAX_OVERLAY_MESSAGE_BYTES = 15 * 1024;

const APPROVAL_PRESENTATION: Readonly<
  Record<ApprovalChoice, { readonly label: string; readonly description: string }>
> = Object.freeze({
  once: {
    label: "이번만 허용",
    description: "이 호출 한 번에만 적용합니다.",
  },
  session: {
    label: "현재 세션에서 허용",
    description: "이 세션의 동일한 도구·범위 규칙에 적용합니다.",
  },
  project: {
    label: "이 프로젝트에 저장",
    description: "현재 프로젝트의 동일한 도구·범위 규칙을 영구 저장합니다.",
  },
  deny: {
    label: "거부",
    description: "도구를 실행하지 않습니다.",
  },
});

const PERMISSION_PRESENTATION: Readonly<
  Record<PermissionMode, { readonly label: string; readonly description: string }>
> = Object.freeze({
  ask: {
    label: "승인 요청 (ask)",
    description: "읽기는 자동 허용하고 파일 변경·명령은 범위별 승인을 요청합니다.",
  },
  "auto-edit": {
    label: "파일 변경 자동 (auto-edit)",
    description: "workspace 파일 변경은 자동 허용하고 셸·외부 작업은 승인받습니다.",
  },
  "full-auto": {
    label: "허용 범위 자동 (full-auto)",
    description: "hard deny와 trust·경로 경계 안에서 도구를 자동 허용합니다.",
  },
  plan: {
    label: "계획 전용 (plan)",
    description: "읽기와 공개 웹만 허용하고 변경 가능한 도구는 차단합니다.",
  },
});

export interface TerminalSessionChoice {
  readonly sessionId: string;
  readonly label: string;
  readonly description: string;
}

export interface TerminalConfigurationSummary {
  readonly workspace: string;
  readonly permissionMode: PermissionMode;
  readonly maxTurns: number;
  readonly verbose: boolean;
  readonly provider?: string;
  readonly profile?: string;
  readonly model?: string;
  readonly sources: readonly string[];
  readonly projectSettingsSkipped: boolean;
}

export interface TerminalStatusSummary {
  readonly sessionId: string;
  readonly workspace: string;
  readonly provider: string;
  readonly profile: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly responseId?: string;
  readonly usage: ProviderUsage;
  readonly backgroundTasks: BackgroundTaskOverview;
  readonly contextTokens?: number;
  readonly contextWindow?: number;
}

function permissionRequirement(request: ApprovalRequest): string {
  const requirement = request.permission;
  if (requirement.kind === "none") return "추가 권한 없음";
  if (requirement.kind === "workspace") {
    return requirement.access === "read" ? "workspace 읽기" : "workspace 쓰기";
  }
  if (requirement.kind === "command") return "셸 명령 실행";
  if (requirement.kind === "network") {
    return requirement.destination === "public"
      ? "공개 네트워크 요청"
      : "provider endpoint 요청";
  }
  return `외부 서비스: ${requirement.service}`;
}

function knownTokenCount(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConfigurationError(`${label} token 사용량이 올바르지 않습니다.`);
  }
  return value;
}

function tokenText(value: number | undefined): string {
  return value === undefined ? "알 수 없음" : value.toLocaleString("ko-KR");
}

function boundedUtf8(value: string, maximumBytes = MAX_OVERLAY_MESSAGE_BYTES): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return value;
  const marker = Buffer.from("\n[크기 제한으로 생략됨]", "utf8");
  let end = Math.max(0, maximumBytes - marker.byteLength);
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return Buffer.concat([bytes.subarray(0, end), marker]).toString("utf8");
}

export class TerminalInteractionPort
  implements ApprovalDecisionPort, ApprovalPromptPort, UserInputDecisionPort
{
  constructor(readonly screen: CatTerminalScreen) {}

  async decideApproval(
    request: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<ApprovalChoice> {
    if (request.choices.length < 1 || new Set(request.choices).size !== request.choices.length) {
      throw new ConfigurationError("승인 선택지가 비어 있거나 중복되었습니다.");
    }
    const selected = await this.screen.requestSelection({
      title: "도구 실행 승인",
      message: boundedUtf8(
        `도구: ${request.toolName}\n` +
        `필요 권한: ${permissionRequirement(request)}\n` +
        `범위 규칙: ${request.rule}\n\n` +
        `실행 요약:\n${request.summary}\n\n` +
        "프로젝트 저장은 현재 프로젝트의 이 규칙에만 적용됩니다.",
      ),
      options: request.choices.map((choice) => ({
        value: choice,
        label: APPROVAL_PRESENTATION[choice].label,
        description: APPROVAL_PRESENTATION[choice].description,
      })),
      signal,
    });
    if (!request.choices.includes(selected as ApprovalChoice)) {
      throw new ConfigurationError("승인 화면이 올바르지 않은 결정을 반환했습니다.");
    }
    return selected as ApprovalChoice;
  }

  async requestApproval(
    request: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<ApprovalChoice> {
    return await this.decideApproval(request, signal);
  }

  async requestInput(
    request: UserInputRequest,
    signal: AbortSignal,
  ): Promise<string> {
    if (
      request.options.length < 2 ||
      request.options.length > 4 ||
      new Set(request.options.map((option) => option.label)).size !== request.options.length
    ) {
      throw new ConfigurationError("사용자 질문에는 서로 다른 선택지 2–4개가 필요합니다.");
    }
    return await this.screen.requestSelection({
      title: "확인이 필요합니다",
      message: request.question,
      options: request.options.map((option) => ({
        value: option.label,
        label: option.label,
        description: option.description,
      })),
      signal,
    });
  }
}

export class TerminalOverlayController {
  constructor(readonly screen: CatTerminalScreen) {}

  async chooseProvider(
    signal?: AbortSignal,
    providers: readonly ProviderDefinition[] = PROVIDER_CATALOG,
  ): Promise<string | undefined> {
    return await this.#chooseOptional(
      "LLM provider 선택",
      providers.map((provider) => ({
        value: provider.id,
        label: provider.displayName,
        description: provider.defaults
          ? `${provider.id} · ${provider.defaults.protocol}`
          : `${provider.id} · endpoint와 protocol 직접 지정`,
      })),
      signal,
    );
  }

  async chooseProfile(
    statuses: readonly AuthStatus[],
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (statuses.length === 0) return undefined;
    return await this.#chooseOptional(
      "Provider profile 선택",
      statuses.map((status) => ({
        value: status.profile.name,
        label: `${status.active ? "● " : ""}${status.profile.name}`,
        description:
          `${status.profile.provider} · ${status.profile.model ?? "model 미선택"} · ` +
          `${status.credentialAvailable ? "API key 연결됨" : "API key 없음"}`,
      })),
      signal,
    );
  }

  async chooseModel(
    models: readonly ProviderModel[],
    current?: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (models.length === 0) return undefined;
    const currentModel = current === undefined
      ? undefined
      : models.find((model) => model.id === current);
    const visible = (
      currentModel === undefined
        ? models
        : [currentModel, ...models.filter((model) => model.id !== currentModel.id)]
    ).slice(0, 128);
    const omitted = models.length > visible.length
      ? ` · ${models.length}개 중 ${visible.length}개 표시`
      : "";
    return await this.#chooseOptional(
      "Model 선택",
      visible.map((model) => ({
        value: model.id,
        label: `${model.id === current ? "● " : ""}${model.id}`,
        description: model.contextWindow === undefined
          ? `context window 알 수 없음${omitted}`
          : `context ${model.contextWindow.toLocaleString("ko-KR")} tokens${omitted}`,
      })),
      signal,
    );
  }

  async chooseSession(
    sessions: readonly TerminalSessionChoice[],
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (sessions.length === 0) return undefined;
    return await this.#chooseOptional(
      "대화 세션 선택",
      sessions.map((session) => ({
        value: session.sessionId,
        label: session.label,
        description: session.description,
      })),
      signal,
    );
  }

  async choosePermissionMode(
    current: PermissionMode,
    signal?: AbortSignal,
  ): Promise<PermissionMode | undefined> {
    const selected = await this.#chooseOptional(
      "권한 모드 선택",
      PERMISSION_MODES.map((mode) => ({
        value: mode,
        label: `${mode === current ? "● " : ""}${PERMISSION_PRESENTATION[mode].label}`,
        description: PERMISSION_PRESENTATION[mode].description,
      })),
      signal,
    );
    return selected as PermissionMode | undefined;
  }

  async requestApiKey(
    providerName: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return await this.screen.requestSecret({
      label: `${providerName} API key`,
      message: `${providerName} API key를 연결합니다. OAuth나 구독 cookie는 사용하지 않습니다.`,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async showConfiguration(
    summary: TerminalConfigurationSummary,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.screen.showInformation({
      title: "현재 설정",
      message: boundedUtf8(
        `Workspace     ${summary.workspace}\n` +
        `Provider      ${summary.provider ?? "미선택"}\n` +
        `Profile       ${summary.profile ?? "미선택"}\n` +
        `Model         ${summary.model ?? "미선택"}\n` +
        `Permission    ${summary.permissionMode}\n` +
        `Max turns     ${summary.maxTurns}\n` +
        `Details       ${summary.verbose ? "켜짐" : "꺼짐"}\n` +
        `Sources       ${summary.sources.join(" → ")}\n` +
        `Project file  ${summary.projectSettingsSkipped ? "trust 없음으로 생략" : "적용 가능"}`,
      ),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async showCost(usage: ProviderUsage, signal?: AbortSignal): Promise<void> {
    const input = knownTokenCount(usage.inputTokens, "입력");
    const output = knownTokenCount(usage.outputTokens, "출력");
    const inferredTotal = input !== undefined && output !== undefined
      ? knownTokenCount(input + output, "합산")
      : undefined;
    const total = knownTokenCount(usage.totalTokens, "전체") ?? inferredTotal;
    await this.screen.showInformation({
      title: "Token 사용량",
      message:
        `Input    ${tokenText(input)}\n` +
        `Output   ${tokenText(output)}\n` +
        `Total    ${tokenText(total)}\n` +
        "Cost     가격 정보가 없어 알 수 없음",
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async showStatus(
    summary: TerminalStatusSummary,
    signal?: AbortSignal,
  ): Promise<void> {
    const contextTokens = knownTokenCount(summary.contextTokens, "현재 context");
    const contextWindow = knownTokenCount(summary.contextWindow, "Context window");
    const context = contextTokens === undefined || contextWindow === undefined
      ? "알 수 없음"
      : `${contextTokens.toLocaleString("ko-KR")} / ${contextWindow.toLocaleString("ko-KR")}`;
    await this.screen.showInformation({
      title: "현재 상태",
      message:
        `Session      ${summary.sessionId}\n` +
        `Response     ${summary.responseId ?? "—"}\n` +
        `Provider     ${summary.provider} (${summary.profile})\n` +
        `Model        ${summary.model}\n` +
        `Permission   ${summary.permissionMode}\n` +
        `Directory    ${summary.workspace}\n` +
        `Tasks        ${summary.backgroundTasks.active} active / ` +
        `${summary.backgroundTasks.total} recorded${
          summary.backgroundTasks.unconfirmed > 0
            ? ` · ${summary.backgroundTasks.unconfirmed} unconfirmed`
            : ""
        }${summary.backgroundTasks.scanTruncated ? " · scan truncated" : ""}\n` +
        `Input        ${tokenText(knownTokenCount(summary.usage.inputTokens, "입력"))}\n` +
        `Output       ${tokenText(knownTokenCount(summary.usage.outputTokens, "출력"))}\n` +
        `Context      ${context}`,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async #chooseOptional(
    title: string,
    options: readonly {
      readonly value: string;
      readonly label: string;
      readonly description: string;
    }[],
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      return await this.screen.requestSelection({
        title,
        options,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof CancelledError && signal?.aborted !== true) return undefined;
      throw error;
    }
  }
}

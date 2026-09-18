import { CancelledError, ConfigurationError } from "../core/errors.js";
import type { ProviderProtocol } from "../core/provider.js";
import { createModelCatalog, requireProviderDefinition, type ProviderModel } from "../providers/index.js";
import { normalizeApiPath, normalizeProviderBaseUrl } from "../security/endpoints.js";
import { validateApiKey } from "../storage/credentials.js";
import { FixedRetryBudget, type ModelHttpTransport } from "../transport/index.js";
import type { CatTerminalScreen } from "../tui/screen.js";
import { type AuthService, type ResolvedProviderAuth } from "./auth-service.js";
import { TerminalOverlayController } from "./terminal-ui.js";

export interface InteractiveProviderSetup {
  readonly screen: CatTerminalScreen;
  readonly auth: AuthService;
  readonly provider: string;
  readonly profile: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onSecret: (apiKey: string) => void | Promise<void>;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly activate: boolean;
  readonly signal?: AbortSignal;
}

export async function configureProviderInteractively(
  options: InteractiveProviderSetup,
): Promise<ResolvedProviderAuth> {
  const { screen } = options;
  const signal = options.signal === undefined ? {} : { signal: options.signal };
  const definition = requireProviderDefinition(options.provider);
  let baseUrl = options.baseUrl ?? definition.defaults?.baseUrl ?? "";
  let protocol: ProviderProtocol = definition.defaults?.protocol ?? "openai-chat";
  let modelsPath = definition.defaults?.modelsPath ?? "/models";
  let generationPath = definition.defaults?.generationPath ?? "/chat/completions";
  let allowInsecureHttp = false;
  if (!definition.defaults) {
    // Retrying here always requires another explicit user input; no network call is made.
    while (true) {
      baseUrl = await screen.requestText({
        label: "서버 주소 (Base URL)",
        message: "API 서버의 기본 주소를 입력하세요. 예: https://api.example.com/v1",
        initialValue: baseUrl,
        validate: (value) => normalizeProviderBaseUrl(value, "서버 주소", true).baseUrl,
        ...signal,
      });
      if (!baseUrl.startsWith("http:")) break;
      const choice = await screen.requestSelection({
        title: "HTTP 연결 확인",
        message: "HTTP는 API key와 대화 내용을 암호화하지 않습니다. 신뢰하는 내부 개발 서버인 경우에만 허용하세요.",
        options: [
          { value: "edit", label: "주소 다시 입력" },
          { value: "allow", label: "이 내부 개발 서버의 HTTP 허용" },
        ],
        ...signal,
      });
      if (choice === "allow") { allowInsecureHttp = true; break; }
    }
    const selectedProtocol = await screen.requestSelection({
      title: "통신 방식 선택",
      options: [
        { value: "openai-chat", label: "Chat Completions", description: "OpenAI 호환 /chat/completions" },
        { value: "openai-responses", label: "Responses", description: "OpenAI 호환 /responses" },
      ],
      ...signal,
    });
    if (selectedProtocol !== "openai-chat" && selectedProtocol !== "openai-responses") {
      throw new ConfigurationError("지원하지 않는 통신 방식입니다.");
    }
    protocol = selectedProtocol;
    generationPath = protocol === "openai-chat" ? "/chat/completions" : "/responses";
    const paths = await screen.requestSelection({
      title: "API 경로 설정",
      options: [
        { value: "default", label: "표준 API 경로 사용", description: `${modelsPath} · ${generationPath}` },
        { value: "custom", label: "경로 직접 지정" },
      ],
      ...signal,
    });
    if (paths === "custom") {
      modelsPath = await screen.requestText({
        label: "모델 목록 경로", initialValue: modelsPath,
        validate: (value) => normalizeApiPath(value, "모델 목록 경로"), ...signal,
      });
      generationPath = await screen.requestText({
        label: "대화 API 경로", initialValue: generationPath,
        validate: (value) => normalizeApiPath(value, "대화 API 경로"), ...signal,
      });
    }
  }
  const apiKey = validateApiKey(await new TerminalOverlayController(screen).requestApiKey(
    definition.displayName, options.signal,
  ));
  await options.onSecret(apiKey);
  await options.auth.configure({
    name: options.profile,
    provider: definition.id,
    protocol, baseUrl, modelsPath, generationPath, apiKey, allowInsecureHttp,
    endpointSource: definition.defaults && options.baseUrl === undefined ? "provider_default" : "user",
    ...(options.model === undefined ? {} : { model: options.model }),
    activate: options.activate,
  });
  return await options.auth.resolve({
    profile: options.profile, provider: definition.id, environment: options.environment,
  });
}

export async function selectProviderModel(
  screen: CatTerminalScreen,
  auth: ResolvedProviderAuth,
  transport: ModelHttpTransport,
  signal: AbortSignal,
  current?: string,
): Promise<{ model: string; models: readonly ProviderModel[] } | undefined> {
  let models: readonly ProviderModel[] = [];
  let message: string | undefined;
  await auth.credential.withValue(async (apiKey) => { screen.addKnownSecrets([apiKey]); });
  screen.setStatus("모델 목록을 확인하는 중입니다…");
  try {
    models = await createModelCatalog({
      profile: auth.profile, credential: auth.credential, transport,
    }).list({ signal, retryBudget: new FixedRetryBudget(2) });
  } catch (error) {
    if (signal.aborted || error instanceof CancelledError) throw error;
    message = `모델 목록 조회 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}\n모델 ID를 직접 입력할 수 있습니다.`;
  }
  const model = await new TerminalOverlayController(screen).chooseModel(models, current, signal, message);
  return model === undefined ? undefined : {
    model,
    // Manually entered model IDs need not be present in an optional server catalog.
    models: models.some((item) => item.id === model) ? models : [],
  };
}

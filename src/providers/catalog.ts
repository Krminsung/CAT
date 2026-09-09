import {
  CancelledError,
  ConfigurationError,
  ProviderError,
  ProtocolError,
} from "../core/errors.js";
import type { RetryBudgetPort } from "../core/execution.js";
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderProtocol,
} from "../core/provider.js";
import { PRODUCT_NAME, VERSION } from "../core/version.js";
import { normalizeApiPath, normalizeProviderBaseUrl } from "../security/endpoints.js";
import { Redactor } from "../security/redaction.js";
import {
  PROVIDER_IDS,
  type ProviderId,
  type ProviderProfile,
} from "../storage/profiles.js";
import {
  readResponseJson,
  type ModelHttpTransport,
} from "../transport/model-http.js";
import {
  ChatProviderAdapter,
  type ChatAuthenticationStyle,
} from "./chat-adapter.js";
import type { ProviderCredentialAccess } from "./credential-access.js";
import { protocolJsonObject, protocolRecord, protocolString } from "./protocol-json.js";
import { ResponsesProviderAdapter } from "./responses-adapter.js";
import {
  configurationString,
  providerHttpFailure,
  sanitizedProviderError,
} from "./shared.js";

const MAX_MODELS_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 10_000;
const MAX_CONTEXT_WINDOW = 1_000_000_000;
const MAX_MODEL_TIMEOUT_MS = 30_000;

export interface ProviderDefaultEndpoint {
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly modelsPath: string;
  readonly generationPath: string;
}

export interface ProviderDefinition {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly defaults: ProviderDefaultEndpoint | null;
  readonly environmentKeys: readonly string[];
  readonly authentication: ChatAuthenticationStyle;
  readonly capabilities: Readonly<
    Record<ProviderProtocol, Readonly<ProviderCapabilities>>
  >;
}

const CONSERVATIVE_RESPONSES = Object.freeze<ProviderCapabilities>({
  nativeToolCalls: true,
  strictToolSchemas: false,
  parallelToolCalls: false,
  reasoningParameter: false,
  temperatureParameter: false,
  streamUsage: true,
});

const INTERNAL_RESPONSES = Object.freeze<ProviderCapabilities>({
  ...CONSERVATIVE_RESPONSES,
  strictToolSchemas: true,
});

const OPENAI_RESPONSES = Object.freeze<ProviderCapabilities>({
  ...CONSERVATIVE_RESPONSES,
  strictToolSchemas: true,
  parallelToolCalls: true,
  reasoningParameter: true,
});

const CONSERVATIVE_CHAT = Object.freeze<ProviderCapabilities>({
  nativeToolCalls: true,
  strictToolSchemas: false,
  parallelToolCalls: false,
  reasoningParameter: false,
  temperatureParameter: true,
  streamUsage: false,
});

const OPENAI_CHAT = Object.freeze<ProviderCapabilities>({
  ...CONSERVATIVE_CHAT,
  strictToolSchemas: true,
  parallelToolCalls: true,
  streamUsage: true,
});

const CUSTOM_RESPONSES = Object.freeze<ProviderCapabilities>({
  ...CONSERVATIVE_RESPONSES,
  streamUsage: false,
});

const CUSTOM_CHAT = Object.freeze<ProviderCapabilities>({
  ...CONSERVATIVE_CHAT,
  temperatureParameter: false,
});

function protocolCapabilities(
  responses: Readonly<ProviderCapabilities>,
  chat: Readonly<ProviderCapabilities>,
): Readonly<Record<ProviderProtocol, Readonly<ProviderCapabilities>>> {
  return Object.freeze({
    "openai-responses": responses,
    "openai-chat": chat,
  });
}

const STANDARD_PROTOCOLS = protocolCapabilities(
  CONSERVATIVE_RESPONSES,
  CONSERVATIVE_CHAT,
);

const definitions: { readonly [Key in ProviderId]: ProviderDefinition } = {
  internal: {
    id: "internal",
    displayName: "사내 LLM",
    defaults: {
      protocol: "openai-responses",
      baseUrl: "https://ai-api-priv.cloudv.kr",
      modelsPath: "/models",
      generationPath: "/openai/v1/responses",
    },
    environmentKeys: ["SMILECODE_API_KEY", "SMILESERV_API_KEY"],
    authentication: "bearer",
    capabilities: protocolCapabilities(INTERNAL_RESPONSES, CONSERVATIVE_CHAT),
  },
  openai: {
    id: "openai",
    displayName: "OpenAI",
    defaults: {
      protocol: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      modelsPath: "/models",
      generationPath: "/responses",
    },
    environmentKeys: ["OPENAI_API_KEY"],
    authentication: "bearer",
    capabilities: protocolCapabilities(OPENAI_RESPONSES, OPENAI_CHAT),
  },
  anthropic: {
    id: "anthropic",
    displayName: "Anthropic",
    defaults: {
      protocol: "openai-chat",
      baseUrl: "https://api.anthropic.com/v1",
      modelsPath: "/models",
      generationPath: "/chat/completions",
    },
    environmentKeys: ["ANTHROPIC_API_KEY"],
    authentication: "anthropic",
    capabilities: STANDARD_PROTOCOLS,
  },
  google: {
    id: "google",
    displayName: "Google Gemini",
    defaults: {
      protocol: "openai-chat",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      modelsPath: "/models",
      generationPath: "/chat/completions",
    },
    environmentKeys: [
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
    ],
    authentication: "bearer",
    capabilities: STANDARD_PROTOCOLS,
  },
  openrouter: {
    id: "openrouter",
    displayName: "OpenRouter",
    defaults: {
      protocol: "openai-chat",
      baseUrl: "https://openrouter.ai/api/v1",
      modelsPath: "/models",
      generationPath: "/chat/completions",
    },
    environmentKeys: ["OPENROUTER_API_KEY"],
    authentication: "bearer",
    capabilities: STANDARD_PROTOCOLS,
  },
  xai: {
    id: "xai",
    displayName: "xAI",
    defaults: {
      protocol: "openai-chat",
      baseUrl: "https://api.x.ai/v1",
      modelsPath: "/models",
      generationPath: "/chat/completions",
    },
    environmentKeys: ["XAI_API_KEY"],
    authentication: "bearer",
    capabilities: STANDARD_PROTOCOLS,
  },
  groq: {
    id: "groq",
    displayName: "Groq",
    defaults: {
      protocol: "openai-chat",
      baseUrl: "https://api.groq.com/openai/v1",
      modelsPath: "/models",
      generationPath: "/chat/completions",
    },
    environmentKeys: ["GROQ_API_KEY"],
    authentication: "bearer",
    capabilities: STANDARD_PROTOCOLS,
  },
  deepseek: {
    id: "deepseek",
    displayName: "DeepSeek",
    defaults: {
      protocol: "openai-chat",
      baseUrl: "https://api.deepseek.com/v1",
      modelsPath: "/models",
      generationPath: "/chat/completions",
    },
    environmentKeys: ["DEEPSEEK_API_KEY"],
    authentication: "bearer",
    capabilities: STANDARD_PROTOCOLS,
  },
  mistral: {
    id: "mistral",
    displayName: "Mistral AI",
    defaults: {
      protocol: "openai-chat",
      baseUrl: "https://api.mistral.ai/v1",
      modelsPath: "/models",
      generationPath: "/chat/completions",
    },
    environmentKeys: ["MISTRAL_API_KEY"],
    authentication: "bearer",
    capabilities: STANDARD_PROTOCOLS,
  },
  together: {
    id: "together",
    displayName: "Together AI",
    defaults: {
      protocol: "openai-chat",
      baseUrl: "https://api.together.xyz/v1",
      modelsPath: "/models",
      generationPath: "/chat/completions",
    },
    environmentKeys: ["TOGETHER_API_KEY"],
    authentication: "bearer",
    capabilities: STANDARD_PROTOCOLS,
  },
  cerebras: {
    id: "cerebras",
    displayName: "Cerebras",
    defaults: {
      protocol: "openai-chat",
      baseUrl: "https://api.cerebras.ai/v1",
      modelsPath: "/models",
      generationPath: "/chat/completions",
    },
    environmentKeys: ["CEREBRAS_API_KEY"],
    authentication: "bearer",
    capabilities: STANDARD_PROTOCOLS,
  },
  fireworks: {
    id: "fireworks",
    displayName: "Fireworks AI",
    defaults: {
      protocol: "openai-chat",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      modelsPath: "/models",
      generationPath: "/chat/completions",
    },
    environmentKeys: ["FIREWORKS_API_KEY"],
    authentication: "bearer",
    capabilities: STANDARD_PROTOCOLS,
  },
  custom: {
    id: "custom",
    displayName: "Custom provider",
    defaults: null,
    environmentKeys: [],
    authentication: "bearer",
    capabilities: protocolCapabilities(CUSTOM_RESPONSES, CUSTOM_CHAT),
  },
};

function freezeDefinition(definition: ProviderDefinition): ProviderDefinition {
  if (definition.defaults) Object.freeze(definition.defaults);
  Object.freeze(definition.environmentKeys);
  Object.freeze(definition.capabilities);
  return Object.freeze(definition);
}

export const PROVIDER_CATALOG: readonly ProviderDefinition[] = Object.freeze(
  PROVIDER_IDS.map((id) => freezeDefinition(definitions[id])),
);

const PROVIDER_ALIASES: Readonly<Record<string, ProviderId>> = Object.freeze({
  smile: "internal",
  smileserv: "internal",
  company: "internal",
  claude: "anthropic",
  gemini: "google",
  "google-gemini": "google",
  "open-router": "openrouter",
});

export function getProviderDefinition(id: string): ProviderDefinition | undefined {
  const normalized = id.trim().toLowerCase();
  const selected = PROVIDER_ALIASES[normalized] ?? normalized;
  return PROVIDER_CATALOG.find((definition) => definition.id === selected);
}

export function requireProviderDefinition(id: string): ProviderDefinition {
  const definition = getProviderDefinition(id);
  if (!definition) {
    throw new ConfigurationError(
      `지원하지 않는 provider입니다. 지원: ${PROVIDER_IDS.join(", ")}`,
    );
  }
  return definition;
}

export function providerEnvironmentKeys(id: string): readonly string[] {
  return getProviderDefinition(id)?.environmentKeys ?? [];
}

export function defaultProviderEndpoint(id: string): ProviderDefaultEndpoint {
  const definition = requireProviderDefinition(id);
  if (!definition.defaults) {
    throw new ConfigurationError("Custom provider에는 기본 endpoint가 없습니다.");
  }
  return { ...definition.defaults };
}

function assertProfileCatalogBinding(
  profile: ProviderProfile,
  definition: ProviderDefinition,
): void {
  if (profile.provider !== definition.id) {
    throw new ConfigurationError("Provider profile과 catalog ID가 일치하지 않습니다.");
  }
  if (profile.endpointSource !== "provider_default" && profile.endpointSource !== "user") {
    throw new ConfigurationError("Provider profile endpoint source가 올바르지 않습니다.");
  }
  if (definition.defaults && profile.protocol !== definition.defaults.protocol) {
    throw new ConfigurationError("기본 provider의 protocol은 catalog 값과 일치해야 합니다.");
  }
  if (profile.endpointSource === "provider_default") {
    const defaults = definition.defaults;
    if (
      !defaults ||
      profile.protocol !== defaults.protocol ||
      profile.baseUrl !== defaults.baseUrl ||
      profile.modelsPath !== defaults.modelsPath ||
      profile.generationPath !== defaults.generationPath ||
      profile.insecureHttp
    ) {
      throw new ConfigurationError("Provider 기본 endpoint profile이 catalog와 일치하지 않습니다.");
    }
  }
  if (definition.id === "custom" && profile.endpointSource !== "user") {
    throw new ConfigurationError("Custom provider endpoint는 사용자가 명시해야 합니다.");
  }
}

export function validateProviderProfileCatalog(
  profile: ProviderProfile,
): ProviderDefinition {
  const definition = requireProviderDefinition(profile.provider);
  assertProfileCatalogBinding(profile, definition);
  return definition;
}

export interface CreateProviderAdapterOptions {
  profile: ProviderProfile;
  credential: ProviderCredentialAccess;
  transport: ModelHttpTransport;
  timeoutMs?: number;
  maxRetries?: number;
}

export function createProviderAdapter(
  options: CreateProviderAdapterOptions,
): ProviderAdapter {
  const definition = validateProviderProfileCatalog(options.profile);
  const common = {
    id: definition.id,
    displayName: definition.displayName,
    baseUrl: options.profile.baseUrl,
    origin: options.profile.origin,
    generationPath: options.profile.generationPath,
    capabilities: { ...definition.capabilities[options.profile.protocol] },
    credential: options.credential,
    transport: options.transport,
    allowInsecureHttp: options.profile.insecureHttp,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
  };
  return options.profile.protocol === "openai-responses"
    ? new ResponsesProviderAdapter(common)
    : new ChatProviderAdapter({
        ...common,
        authentication: definition.authentication,
      });
}

export interface ProviderModel {
  readonly id: string;
  readonly contextWindow?: number;
}

export interface ModelCatalogRequest {
  signal: AbortSignal;
  retryBudget: RetryBudgetPort;
}

export interface ModelCatalog {
  list(request: ModelCatalogRequest): Promise<readonly ProviderModel[]>;
}

function modelTimeout(value: number | undefined): number {
  const selected = value ?? MAX_MODEL_TIMEOUT_MS;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 300_000) {
    throw new ConfigurationError("Model catalog 제한 시간은 1–300000ms여야 합니다.");
  }
  return Math.min(selected, MAX_MODEL_TIMEOUT_MS);
}

function modelRetries(value: number | undefined): number {
  const selected = value ?? 2;
  if (!Number.isSafeInteger(selected) || selected < 0 || selected > 2) {
    throw new ConfigurationError("Model catalog 재시도 횟수는 0–2여야 합니다.");
  }
  return selected;
}

function profileEndpoint(profile: ProviderProfile): URL {
  const normalizedBase = normalizeProviderBaseUrl(
    profile.baseUrl,
    "Model catalog base URL",
    profile.insecureHttp,
  );
  const path = normalizeApiPath(profile.modelsPath, "Model catalog 경로");
  if (
    normalizedBase.baseUrl !== profile.baseUrl ||
    normalizedBase.origin !== profile.origin
  ) {
    throw new ConfigurationError("Model catalog endpoint와 profile origin이 일치하지 않습니다.");
  }
  const endpoint = new URL(`${normalizedBase.baseUrl}${path}`);
  if (endpoint.origin !== profile.origin) {
    throw new ConfigurationError("Model catalog endpoint가 credential origin 밖에 있습니다.");
  }
  return endpoint;
}

function modelHeaders(
  apiKey: string,
  authentication: ChatAuthenticationStyle,
): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": `${PRODUCT_NAME}/${VERSION}`,
    ...(authentication === "anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : {}),
  };
}

function modelArray(payload: unknown): unknown[] {
  const raw = protocolJsonObject(payload, "Model catalog 응답");
  const selected = Array.isArray(raw.data)
    ? raw.data
    : Array.isArray(raw.models)
      ? raw.models
      : undefined;
  if (!selected) {
    throw new ProtocolError("Model catalog 응답에 data 또는 models 배열이 없습니다.");
  }
  if (selected.length > MAX_MODELS) {
    throw new ProtocolError("Model catalog 응답의 model 수가 너무 많습니다.");
  }
  return selected;
}

function usableModel(provider: ProviderId, id: string): boolean {
  const lower = id.toLowerCase();
  if (provider === "openai") {
    return !/(?:embedding|moderation|transcri|tts|whisper|dall-e|image|realtime|audio)/u.test(lower);
  }
  if (provider === "google") {
    return /^(?:gemini|gemma)-/u.test(lower) && !/(?:embedding|imagen|veo|aqa)/u.test(lower);
  }
  if (provider === "mistral") {
    return !/(?:embed|moderation|ocr)/u.test(lower);
  }
  return true;
}

function contextWindow(item: Record<string, unknown>): number | undefined {
  const details = protocolRecord(item.model_info);
  const candidates = [
    item.context_window,
    item.context_length,
    item.max_input_tokens,
    item.max_context_length,
    item.inputTokenLimit,
    details?.context_window,
    details?.context_length,
    details?.max_input_tokens,
    details?.max_context_length,
    details?.inputTokenLimit,
  ];
  for (const value of candidates) {
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value > 0 &&
      value <= MAX_CONTEXT_WINDOW
    ) {
      return value;
    }
  }
  return undefined;
}

function parseModels(payload: unknown, provider: ProviderId): ProviderModel[] {
  const result: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const value of modelArray(payload)) {
    const item = protocolRecord(value);
    if (!item) continue;
    const rawId = typeof item.id === "string"
      ? item.id
      : typeof item.name === "string"
        ? item.name
        : "";
    const candidate = (provider === "google"
      ? rawId.replace(/^models\//u, "")
      : rawId).trim();
    let id: string;
    try {
      id = protocolString(candidate, "Model ID", 256);
    } catch {
      continue;
    }
    if (seen.has(id) || !usableModel(provider, id)) continue;
    seen.add(id);
    const window = contextWindow(item);
    result.push({
      id,
      ...(window !== undefined ? { contextWindow: window } : {}),
    });
  }
  return result;
}

export function validateManualModelId(value: unknown): string {
  return configurationString(value, "수동 Model ID", 256);
}

export interface CreateModelCatalogOptions {
  profile: ProviderProfile;
  credential: ProviderCredentialAccess;
  transport: ModelHttpTransport;
  timeoutMs?: number;
  maxRetries?: number;
}

interface HttpModelCatalogOptions extends CreateModelCatalogOptions {
  definition: ProviderDefinition;
}

class HttpModelCatalog implements ModelCatalog {
  readonly #provider: ProviderId;
  readonly #displayName: string;
  readonly #endpoint: URL;
  readonly #authentication: ChatAuthenticationStyle;
  readonly #credential: ProviderCredentialAccess;
  readonly #transport: ModelHttpTransport;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;

  constructor(options: HttpModelCatalogOptions) {
    assertProfileCatalogBinding(options.profile, options.definition);
    if (
      options.credential.provider !== options.profile.provider ||
      options.credential.origin !== options.profile.origin
    ) {
      throw new ConfigurationError("Model catalog credential이 profile과 일치하지 않습니다.");
    }
    this.#provider = options.profile.provider;
    this.#displayName = options.definition.displayName;
    this.#endpoint = profileEndpoint(options.profile);
    this.#authentication = options.definition.authentication;
    this.#credential = options.credential;
    this.#transport = options.transport;
    this.#timeoutMs = modelTimeout(options.timeoutMs);
    this.#maxRetries = modelRetries(options.maxRetries);
  }

  async list(request: ModelCatalogRequest): Promise<readonly ProviderModel[]> {
    let redactor = new Redactor();
    try {
      const response = await this.#credential.withValue(async (apiKey) => {
        redactor = new Redactor([apiKey]);
        return await this.#transport.request({
          url: this.#endpoint,
          expectedOrigin: this.#credential.origin,
          method: "GET",
          headers: modelHeaders(apiKey, this.#authentication),
          signal: request.signal,
          timeoutMs: this.#timeoutMs,
          retryBudget: request.retryBudget,
          maxRetries: this.#maxRetries,
        });
      });
      if (!response.ok) {
        throw await providerHttpFailure(
          response,
          `${this.#displayName} 모델 목록`,
          redactor,
        );
      }
      const models = parseModels(
        await readResponseJson(response, MAX_MODELS_BYTES),
        this.#provider,
      );
      if (models.length === 0) {
        throw new ProviderError(
          `이 API key로 사용할 수 있는 ${this.#displayName} 모델이 없습니다. 수동 Model ID를 지정할 수 있습니다.`,
        );
      }
      return Object.freeze(models.map((model) => Object.freeze(model)));
    } catch (error) {
      if (request.signal.aborted || error instanceof CancelledError) {
        throw new CancelledError("Model catalog 요청이 취소됐습니다.");
      }
      throw sanitizedProviderError(error, redactor);
    }
  }
}

export function createModelCatalog(
  options: CreateModelCatalogOptions,
): ModelCatalog {
  const definition = validateProviderProfileCatalog(options.profile);
  return new HttpModelCatalog({ ...options, definition });
}

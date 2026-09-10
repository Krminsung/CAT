import { ConfigurationError } from "../core/errors.js";
import type { ProviderProtocol } from "../core/provider.js";
import {
  defaultProviderEndpoint,
  requireProviderDefinition,
  validateManualModelId,
} from "../providers/catalog.js";
import { normalizeProfileName } from "../storage/profiles.js";
import type { AuthService } from "../app/auth-service.js";
import { CliUsageError } from "./args.js";
import type { CliOutput } from "./output.js";

const AUTH_COMMANDS = ["setup", "status", "use", "remove"] as const;
type AuthCommand = (typeof AUTH_COMMANDS)[number];

const SETUP_VALUE_OPTIONS = new Set([
  "--provider",
  "--profile",
  "--base-url",
  "--protocol",
  "--models-path",
  "--response-path",
  "--generation-path",
  "--model",
]);
const SETUP_FLAG_OPTIONS = new Set([
  "--allow-insecure-http",
  "--no-activate",
]);
const MAX_AUTH_ARGUMENT_BYTES = 64 * 1024;

export interface AuthSecretPromptPort {
  requestSecret(options: {
    readonly label: string;
    readonly message?: string;
    readonly signal?: AbortSignal;
  }): Promise<string>;
}

export interface AuthManagementControllerOptions {
  readonly auth: AuthService;
  readonly secrets?: AuthSecretPromptPort;
}

interface AuthSetupArguments {
  readonly provider: string;
  readonly profile: string;
  readonly baseUrl: string;
  readonly protocol: ProviderProtocol;
  readonly modelsPath: string;
  readonly generationPath: string;
  readonly model?: string;
  readonly endpointSource: "provider_default" | "user";
  readonly allowInsecureHttp: boolean;
  readonly activate: boolean;
}

export function authHelp(): string {
  return "usage: cat-tui auth <setup|status|use|remove> ...\n\n" +
    "API key profile을 안전한 사용자 저장소에서 관리합니다.\n\n" +
    "commands:\n" +
    "  setup    masked 입력으로 API key와 endpoint profile 저장\n" +
    "  status   secret을 제외한 profile 상태 표시\n" +
    "  use      활성 profile 변경\n" +
    "  remove   profile과 사용하지 않는 credential 제거\n";
}

export function authSetupHelp(): string {
  return "usage: cat-tui auth setup [options]\n\n" +
    "options:\n" +
    "  --provider ID              provider ID (기본: internal)\n" +
    "  --profile NAME             저장할 profile 이름\n" +
    "  --base-url URL             사용자 지정 HTTPS endpoint\n" +
    "  --protocol PROTOCOL        openai-responses|openai-chat\n" +
    "  --models-path PATH         model 목록 API 경로\n" +
    "  --response-path PATH       generation API 경로\n" +
    "  --model ID                 model 목록 조회 없이 저장할 model ID\n" +
    "  --allow-insecure-http      내부 개발용 HTTP endpoint 명시 허용\n" +
    "  --no-activate              저장 뒤 활성 profile로 바꾸지 않음\n";
}

function boundedArgument(value: string, label: string, maximumBytes: number): string {
  const selected = value.trim();
  if (
    !selected ||
    Buffer.byteLength(selected, "utf8") > maximumBytes ||
    /[\u0000-\u001f\u007f]/u.test(selected)
  ) {
    throw new CliUsageError(`${label} 값의 형식 또는 크기가 올바르지 않습니다.`);
  }
  return selected;
}

function assertAuthArguments(args: readonly string[]): void {
  let bytes = 0;
  for (const value of args) {
    bytes += Buffer.byteLength(value, "utf8") + 1;
    if (value.includes("\0") || bytes > MAX_AUTH_ARGUMENT_BYTES) {
      throw new CliUsageError("auth 인자의 형식 또는 전체 크기가 올바르지 않습니다.");
    }
  }
}

function isAuthCommand(value: string): value is AuthCommand {
  return (AUTH_COMMANDS as readonly string[]).includes(value);
}

function setupArguments(args: readonly string[]): AuthSetupArguments {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    let option = args[index] ?? "";
    let inlineValue: string | undefined;
    const assignment = option.match(/^(--[^=]+)=(.*)$/su);
    if (assignment) {
      option = assignment[1] ?? "";
      inlineValue = assignment[2] ?? "";
    }
    if (option === "--generation-path") option = "--response-path";
    if (SETUP_FLAG_OPTIONS.has(option)) {
      if (inlineValue !== undefined) {
        throw new CliUsageError(`${option} 옵션에는 값을 지정할 수 없습니다.`);
      }
      if (flags.has(option)) throw new CliUsageError(`${option} 옵션을 중복 지정할 수 없습니다.`);
      flags.add(option);
      continue;
    }
    if (!SETUP_VALUE_OPTIONS.has(option) && option !== "--response-path") {
      throw new CliUsageError(`auth setup의 알 수 없는 인자입니다: ${option || "(빈 인자)"}`);
    }
    if (values.has(option)) throw new CliUsageError(`${option} 옵션을 중복 지정할 수 없습니다.`);
    let value = inlineValue;
    if (value === undefined) {
      const candidate = args[index + 1];
      if (candidate === undefined || candidate.startsWith("-")) {
        throw new CliUsageError(`${option} 옵션에 값이 필요합니다.`);
      }
      value = candidate;
      index += 1;
    }
    values.set(option, boundedArgument(value, option, 4_096));
  }

  const requestedProvider = values.get("--provider") ?? "internal";
  const definition = requireProviderDefinition(requestedProvider);
  const profile = normalizeProfileName(values.get("--profile") ?? definition.id);
  const requestedProtocol = values.get("--protocol");
  if (
    requestedProtocol !== undefined &&
    requestedProtocol !== "openai-responses" &&
    requestedProtocol !== "openai-chat"
  ) {
    throw new CliUsageError("--protocol은 openai-responses 또는 openai-chat이어야 합니다.");
  }

  const customBaseUrl = values.get("--base-url");
  let baseUrl: string;
  let protocol: ProviderProtocol;
  let modelsPath: string;
  let generationPath: string;
  let endpointSource: "provider_default" | "user";
  if (definition.id === "custom") {
    if (!customBaseUrl || !requestedProtocol) {
      throw new CliUsageError("custom provider에는 --base-url과 --protocol을 함께 지정해야 합니다.");
    }
    baseUrl = customBaseUrl;
    protocol = requestedProtocol;
    modelsPath = values.get("--models-path") ?? "/models";
    generationPath = values.get("--response-path") ??
      (protocol === "openai-responses" ? "/responses" : "/chat/completions");
    endpointSource = "user";
  } else {
    const defaults = defaultProviderEndpoint(definition.id);
    if (requestedProtocol !== undefined && requestedProtocol !== defaults.protocol) {
      throw new CliUsageError(
        `${definition.id} provider protocol은 ${defaults.protocol}이어야 합니다.`,
      );
    }
    baseUrl = customBaseUrl ?? defaults.baseUrl;
    protocol = defaults.protocol;
    modelsPath = values.get("--models-path") ?? defaults.modelsPath;
    generationPath = values.get("--response-path") ?? defaults.generationPath;
    endpointSource = customBaseUrl === undefined ? "provider_default" : "user";
    if (
      endpointSource === "provider_default" &&
      (modelsPath !== defaults.modelsPath || generationPath !== defaults.generationPath)
    ) {
      throw new CliUsageError(
        "기본 provider API 경로를 바꾸려면 --base-url도 명시해 credential origin을 다시 묶어야 합니다.",
      );
    }
  }
  if (flags.has("--allow-insecure-http") && customBaseUrl === undefined) {
    throw new CliUsageError("--allow-insecure-http는 --base-url과 함께 사용해야 합니다.");
  }
  const rawModel = values.get("--model");
  const model = rawModel === undefined ? undefined : validateManualModelId(rawModel);
  return Object.freeze({
    provider: definition.id,
    profile,
    baseUrl,
    protocol,
    modelsPath,
    generationPath,
    ...(model === undefined ? {} : { model }),
    endpointSource,
    allowInsecureHttp: flags.has("--allow-insecure-http"),
    activate: !flags.has("--no-activate"),
  });
}

function singleProfileArgument(
  command: "use" | "remove",
  args: readonly string[],
): string {
  if (args.length !== 1) {
    throw new CliUsageError(`auth ${command}에는 PROFILE 하나를 지정해야 합니다.`);
  }
  try {
    return normalizeProfileName(args[0] ?? "");
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw new CliUsageError(error.message, { cause: error });
    }
    throw error;
  }
}

export class AuthManagementController {
  readonly #auth: AuthService;
  readonly #secrets: AuthSecretPromptPort | undefined;

  constructor(options: AuthManagementControllerOptions) {
    this.#auth = options.auth;
    this.#secrets = options.secrets;
  }

  async run(args: readonly string[], output: CliOutput): Promise<number> {
    assertAuthArguments(args);
    const command = args[0];
    if (command === undefined || command === "-h" || command === "--help") {
      output.writeTrustedText(authHelp());
      return 0;
    }
    if (!isAuthCommand(command)) {
      throw new CliUsageError(`auth 명령을 찾을 수 없습니다: ${command}`);
    }
    const commandArgs = args.slice(1);
    if (commandArgs.includes("-h") || commandArgs.includes("--help")) {
      output.writeTrustedText(command === "setup"
        ? authSetupHelp()
        : `usage: cat-tui auth ${command} PROFILE\n`);
      return 0;
    }
    if (command === "status") {
      if (commandArgs.length !== 0) {
        throw new CliUsageError("auth status에는 추가 인자를 사용할 수 없습니다.");
      }
      const statuses = await this.#auth.status();
      if (statuses.length === 0) {
        output.writeText("저장된 API key profile이 없습니다.");
        return 1;
      }
      output.writeText([
        "Active  Profile · Provider · Model · Credential · API URL",
        ...statuses.map((status) =>
          `${status.active ? "●" : " "}       ${status.profile.name} · ` +
          `${status.profile.provider} · ${status.profile.model ?? "—"} · ` +
          `${status.credentialAvailable ? "연결됨" : "없음"} · ${status.profile.baseUrl}`,
        ),
      ].join("\n"));
      return 0;
    }
    if (command === "use") {
      const selected = await this.#auth.use(singleProfileArgument(command, commandArgs));
      output.writeText(`활성 API key profile을 ${selected.name} (${selected.provider})(으)로 변경했습니다.`);
      return 0;
    }
    if (command === "remove") {
      const profile = singleProfileArgument(command, commandArgs);
      const removed = await this.#auth.remove(profile);
      output.writeText(removed
        ? `API key profile을 삭제했습니다: ${profile}`
        : `API key profile을 찾을 수 없습니다: ${profile}`);
      return removed ? 0 : 1;
    }

    let setup: AuthSetupArguments;
    try {
      setup = setupArguments(commandArgs);
    } catch (error) {
      if (error instanceof CliUsageError) throw error;
      if (error instanceof ConfigurationError) {
        throw new CliUsageError(error.message, { cause: error });
      }
      throw error;
    }
    if (!this.#secrets) {
      throw new ConfigurationError(
        "auth setup은 API key를 masking할 수 있는 대화형 TTY에서 실행해야 합니다.",
      );
    }
    const provider = requireProviderDefinition(setup.provider);
    const apiKey = await this.#secrets.requestSecret({
      label: `${provider.displayName} API key`,
      message: "API key만 저장합니다. OAuth나 구독 cookie는 지원하지 않습니다.",
    });
    const profile = await this.#auth.configure({
      name: setup.profile,
      provider: setup.provider,
      protocol: setup.protocol,
      baseUrl: setup.baseUrl,
      modelsPath: setup.modelsPath,
      generationPath: setup.generationPath,
      ...(setup.model === undefined ? {} : { model: setup.model }),
      apiKey,
      endpointSource: setup.endpointSource,
      allowInsecureHttp: setup.allowInsecureHttp,
      activate: setup.activate,
    });
    output.writeText(
      `API key profile을 저장했습니다: ${profile.name} · ${profile.provider} · ` +
      `${profile.model ?? "model 미선택"}${profile.insecureHttp ? " · HTTP 명시 허용" : ""}`,
    );
    return 0;
  }
}

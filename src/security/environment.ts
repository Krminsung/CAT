import { ConfigurationError, PermissionDeniedError } from "../core/errors.js";

const DEFAULT_CHILD_ENVIRONMENT = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "TMPDIR",
  "TEMP",
  "TMP",
] as const;

const EXACT_SENSITIVE_NAMES = new Set([
  "CAT_API_KEY",
  "SMILECODE_API_KEY",
  "SMILESERV_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "TOGETHER_API_KEY",
  "CEREBRAS_API_KEY",
  "FIREWORKS_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "SSH_AUTH_SOCK",
]);

const INJECTION_ENVIRONMENT_NAMES = new Set([
  "BASH_ENV",
  "BASHOPTS",
  "CDPATH",
  "ENV",
  "GLOBIGNORE",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_ASKPASS",
  "GIT_DIR",
  "GIT_EXEC_PATH",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_WORK_TREE",
  "IFS",
  "PROMPT_COMMAND",
  "PS4",
  "SHELLOPTS",
  "SSH_ASKPASS",
  "SUDO_ASKPASS",
  "ZDOTDIR",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "PYTHONINSPECT",
  "PYTHONBREAKPOINT",
  "PERL5OPT",
  "PERL5LIB",
  "RUBYOPT",
  "RUBYLIB",
  "LUA_INIT",
  "LUA_PATH",
  "LUA_CPATH",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
]);

const SENSITIVE_NAME_PATTERN = /(?:API.?KEY|ACCESS.?TOKEN|AUTH.?TOKEN|PASSWORD|PASSWD|SECRET|PRIVATE.?KEY|COOKIE|CREDENTIAL)/u;
const INJECTION_NAME_PATTERN = /^(?:BASH_FUNC_.+%%|GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|SYSTEM|GLOBAL)|LD_.+|DYLD_.+)$/u;
const VALID_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MAX_ENVIRONMENT_VALUE_BYTES = 32 * 1024;
const MAX_ENVIRONMENT_TOTAL_BYTES = 128 * 1024;

export interface ChildEnvironmentOptions {
  source?: NodeJS.ProcessEnv;
  passThrough?: readonly string[];
  additions?: Readonly<Record<string, string>>;
}

function canonicalName(name: string): string {
  return process.platform === "win32" ? name.toUpperCase() : name;
}

export function isSensitiveEnvironmentName(name: string): boolean {
  const normalized = name.toUpperCase();
  return EXACT_SENSITIVE_NAMES.has(normalized) || SENSITIVE_NAME_PATTERN.test(normalized);
}

export function isInjectionEnvironmentName(name: string): boolean {
  const normalized = name.toUpperCase();
  return INJECTION_ENVIRONMENT_NAMES.has(normalized) ||
    INJECTION_NAME_PATTERN.test(normalized);
}

function assertEnvironmentName(name: string): void {
  if (!VALID_ENVIRONMENT_NAME.test(name)) {
    throw new ConfigurationError("Child environment 변수 이름이 올바르지 않습니다.");
  }
  if (isSensitiveEnvironmentName(name) || isInjectionEnvironmentName(name)) {
    throw new PermissionDeniedError(
      `Child environment에 보호된 변수 ${name}을 전달할 수 없습니다.`,
    );
  }
}

function assertEnvironmentValue(name: string, value: string): void {
  if (value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_ENVIRONMENT_VALUE_BYTES) {
    throw new ConfigurationError(`Child environment 변수 ${name}의 값이 너무 크거나 잘못됐습니다.`);
  }
}

export function buildChildEnvironment(
  options: ChildEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const source = options.source ?? process.env;
  const selectedNames = new Map<string, string>();
  for (const name of [...DEFAULT_CHILD_ENVIRONMENT, ...(options.passThrough ?? [])]) {
    assertEnvironmentName(name);
    selectedNames.set(canonicalName(name), name);
  }

  const result: NodeJS.ProcessEnv = {};
  let totalBytes = 0;
  const append = (name: string, value: string): void => {
    assertEnvironmentName(name);
    assertEnvironmentValue(name, value);
    totalBytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8");
    if (totalBytes > MAX_ENVIRONMENT_TOTAL_BYTES) {
      throw new ConfigurationError("Child environment 전체 크기 제한을 초과했습니다.");
    }
    result[name] = value;
  };

  for (const [sourceName, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const requestedName = selectedNames.get(canonicalName(sourceName));
    if (requestedName) append(requestedName, value);
  }
  for (const [name, value] of Object.entries(options.additions ?? {})) {
    append(name, value);
  }
  return result;
}

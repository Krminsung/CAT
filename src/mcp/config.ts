import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { PermissionDeniedError } from "../core/errors.js";
import type { JsonObject, JsonValue } from "../core/json.js";
import {
  buildChildEnvironment,
  isInjectionEnvironmentName,
  isSensitiveEnvironmentName,
} from "../security/environment.js";
import {
  readJsonObject,
  writeJsonObjectAtomic,
} from "../storage/json-file.js";
import type { StoragePaths } from "../storage/paths.js";
import {
  loadSettings,
  parseSettingsValues,
  SETTINGS_SCHEMA_VERSION,
  type LoadedSettings,
} from "../storage/settings.js";
import { McpError } from "./errors.js";
import {
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSIONS,
  type McpProtocolVersion,
} from "./protocol.js";

export type McpConfigScope = "user" | "project" | "local";

export interface McpEnvironmentReference {
  readonly source: "environment";
  readonly name: string;
}

export interface McpServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly protocolVersion: McpProtocolVersion;
  readonly disabled: boolean;
  readonly env: Readonly<Record<string, McpEnvironmentReference>>;
  readonly configVersion: string;
}

export interface McpConfigurationSnapshot {
  readonly raw: Readonly<JsonObject>;
  readonly configs: readonly McpServerConfig[];
  readonly version: string;
  readonly settings: LoadedSettings;
}

export interface ResolvedMcpEnvironment {
  readonly environment: NodeJS.ProcessEnv;
  readonly secrets: readonly string[];
  readonly version: string;
}

export interface ResolvedMcpCwd {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

export interface PreparedMcpServerExecution {
  readonly config: McpServerConfig;
  readonly cwd: ResolvedMcpCwd;
  readonly environment: ResolvedMcpEnvironment;
}

export interface McpExecutionPlan {
  readonly workspace: string;
  readonly configurationVersion: string;
  readonly version: string;
  readonly targets: readonly Readonly<JsonObject>[];
  readonly executions: readonly PreparedMcpServerExecution[];
}

const MAX_MCP_SERVERS = 32;
const MAX_SERVER_NAME_LENGTH = 64;
const MAX_COMMAND_BYTES = 4_096;
const MAX_CWD_BYTES = 4_096;
const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_BYTES = 32 * 1024;
const MAX_ARGUMENT_TOTAL_BYTES = 512 * 1024;
const MAX_ENVIRONMENT_REFERENCES = 64;
const MAX_ENVIRONMENT_NAME_BYTES = 256;
const MAX_ENVIRONMENT_VALUE_BYTES = 32 * 1024;
const MAX_ENVIRONMENT_TOTAL_BYTES = 256 * 1024;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const DANGEROUS_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SENSITIVE_ARGUMENT_PATTERN = /^--?(?:[a-z0-9]+[-_])*(?:api[-_]?key|access[-_]?token|auth(?:orization)?[-_]?token|authorization|token|password|passwd|secret|credential|cookie)(?:[-_=]|$)/iu;
const SENSITIVE_INLINE_VALUE_PATTERN = /(?:^|[^A-Za-z0-9_])(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|access[-_]?token|auth[-_]?token|token|password|passwd|secret|credential)\s*[:=]/iu;
const TOKEN_VALUE_PATTERN = /(?:\bsk-[A-Za-z0-9_-]{8,}|\bgh[opsu]_[A-Za-z0-9_]{8,}|\bgithub_pat_[A-Za-z0-9_]{8,})/u;
const MODEL_CREDENTIAL_ENVIRONMENTS = new Set([
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
]);

export function mcpModelCredentialValues(source: NodeJS.ProcessEnv): readonly string[] {
  const values = [...MODEL_CREDENTIAL_ENVIRONMENTS].flatMap((name) => {
    const value = source[name]?.trim();
    if (!value) return [];
    const bytes = Buffer.byteLength(value, "utf8");
    return bytes >= 8 && bytes <= 8 * 1024 && !/[\u0000-\u001f\u007f]/u.test(value)
      ? [value]
      : [];
  });
  return Object.freeze([...new Set(values)]);
}
const RESERVED_CHILD_ENVIRONMENTS = new Set([
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
]);

function containsInlineEnvironmentSecret(argument: string): boolean {
  const assignment = argument.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su);
  return assignment !== null &&
    isSensitiveEnvironmentName(assignment[1] ?? "") &&
    Boolean(assignment[2]);
}

function containsInlineHeaderSecret(argument: string): boolean {
  return SENSITIVE_INLINE_VALUE_PATTERN.test(argument) ||
    /^-H(?:=)?(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key)\s*:/iu.test(argument);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const permitted = new Set(allowed);
  return Object.keys(value).every((key) => permitted.has(key));
}

function unicodeCompare(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const difference = (leftPoints[index]?.codePointAt(0) ?? 0) -
      (rightPoints[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new McpError("MCP 설정을 직렬화하지 못했습니다.");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort(unicodeCompare)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(",")}}`;
}

function digest(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function boundedText(value: unknown, label: string, maximumBytes: number, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  ) {
    throw new McpError(`${label}의 형식 또는 크기가 올바르지 않습니다.`);
  }
  return value;
}

function environmentReference(value: unknown, serverName: string, target: string): McpEnvironmentReference {
  if (
    !record(value) ||
    !exactKeys(value, ["source", "name"]) ||
    value.source !== "environment" ||
    typeof value.name !== "string" ||
    !ENVIRONMENT_NAME_PATTERN.test(value.name) ||
    Buffer.byteLength(value.name, "utf8") > MAX_ENVIRONMENT_NAME_BYTES ||
    DANGEROUS_OBJECT_KEYS.has(value.name) ||
    isInjectionEnvironmentName(value.name) ||
    MODEL_CREDENTIAL_ENVIRONMENTS.has(value.name.toUpperCase())
  ) {
    throw new McpError(
      `${serverName}.env.${target}에는 model credential과 분리된 environment secret 참조가 필요합니다.`,
    );
  }
  return Object.freeze({ source: "environment", name: value.name });
}

function parseEnvironment(value: unknown, serverName: string): Readonly<Record<string, McpEnvironmentReference>> {
  if (value === undefined) return Object.freeze({});
  if (!record(value) || Object.keys(value).length > MAX_ENVIRONMENT_REFERENCES) {
    throw new McpError(`${serverName}.env는 최대 ${MAX_ENVIRONMENT_REFERENCES}개의 secret 참조 객체여야 합니다.`);
  }
  const result = Object.create(null) as Record<string, McpEnvironmentReference>;
  const normalizedTargets = new Set<string>();
  for (const [target, reference] of Object.entries(value).sort(([left], [right]) => unicodeCompare(left, right))) {
    const normalized = target.toUpperCase();
    if (
      !ENVIRONMENT_NAME_PATTERN.test(target) ||
      Buffer.byteLength(target, "utf8") > MAX_ENVIRONMENT_NAME_BYTES ||
      DANGEROUS_OBJECT_KEYS.has(target) ||
      isInjectionEnvironmentName(target) ||
      RESERVED_CHILD_ENVIRONMENTS.has(normalized) ||
      normalizedTargets.has(normalized)
    ) {
      throw new McpError(`${serverName}.env의 child 변수 이름이 보호됐거나 중복됐거나 올바르지 않습니다: ${target}`);
    }
    normalizedTargets.add(normalized);
    result[target] = environmentReference(reference, serverName, target);
  }
  return Object.freeze(result);
}

function configMaterial(config: Omit<McpServerConfig, "configVersion">): JsonObject {
  const environment = Object.create(null) as JsonObject;
  for (const [target, reference] of Object.entries(config.env)) {
    environment[target] = { source: reference.source, name: reference.name };
  }
  return {
    name: config.name,
    command: config.command,
    args: [...config.args],
    cwd: config.cwd ?? null,
    protocolVersion: config.protocolVersion,
    disabled: config.disabled,
    env: environment,
  };
}

function parseServerConfig(name: string, value: unknown): McpServerConfig {
  if (!SERVER_NAME_PATTERN.test(name) || [...name].length > MAX_SERVER_NAME_LENGTH) {
    throw new McpError(`MCP 서버 이름이 올바르지 않습니다: ${name}`);
  }
  if (
    !record(value) ||
    !exactKeys(value, ["command", "args", "cwd", "protocolVersion", "disabled", "env"])
  ) {
    throw new McpError(`MCP 서버 설정에 알 수 없는 field가 있습니다: ${name}`);
  }
  const command = boundedText(value.command, `${name}.command`, MAX_COMMAND_BYTES);
  if (TOKEN_VALUE_PATTERN.test(command)) {
    throw new McpError(`${name}.command에는 secret 값을 직접 넣을 수 없습니다.`);
  }
  const rawArgs = value.args ?? [];
  if (!Array.isArray(rawArgs) || rawArgs.length > MAX_ARGUMENTS) {
    throw new McpError(`${name}.args는 최대 ${MAX_ARGUMENTS}개의 문자열 배열이어야 합니다.`);
  }
  let argumentBytes = 0;
  const args = rawArgs.map((raw, index) => {
    const argument = boundedText(raw, `${name}.args[${index}]`, MAX_ARGUMENT_BYTES, true);
    argumentBytes += Buffer.byteLength(argument, "utf8") + 1;
    if (
      argumentBytes > MAX_ARGUMENT_TOTAL_BYTES ||
      SENSITIVE_ARGUMENT_PATTERN.test(argument) ||
      containsInlineHeaderSecret(argument) ||
      containsInlineEnvironmentSecret(argument) ||
      TOKEN_VALUE_PATTERN.test(argument)
    ) {
      throw new McpError(`${name}.args에는 secret flag/value를 직접 넣을 수 없습니다.`);
    }
    return argument;
  });
  const cwd = value.cwd === undefined
    ? undefined
    : boundedText(value.cwd, `${name}.cwd`, MAX_CWD_BYTES);
  const protocolVersion = value.protocolVersion ?? MCP_LEGACY_PROTOCOL_VERSION;
  if (
    typeof protocolVersion !== "string" ||
    !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(protocolVersion)
  ) {
    throw new McpError(`지원하지 않는 MCP protocol version입니다: ${name}`);
  }
  if (value.disabled !== undefined && typeof value.disabled !== "boolean") {
    throw new McpError(`${name}.disabled는 boolean이어야 합니다.`);
  }
  const base = {
    name,
    command,
    args: Object.freeze(args),
    ...(cwd === undefined ? {} : { cwd }),
    protocolVersion: protocolVersion as McpProtocolVersion,
    disabled: value.disabled === true,
    env: parseEnvironment(value.env, name),
  };
  return Object.freeze({ ...base, configVersion: digest(configMaterial(base)) });
}

export function parseMcpServerConfigs(raw: JsonValue | undefined): readonly McpServerConfig[] {
  if (raw === undefined || raw === null) return Object.freeze([]);
  if (!record(raw) || Object.keys(raw).length > MAX_MCP_SERVERS) {
    throw new McpError(`mcpServers는 최대 ${MAX_MCP_SERVERS}개의 설정 객체여야 합니다.`);
  }
  return Object.freeze(
    Object.entries(raw)
      .sort(([left], [right]) => unicodeCompare(left, right))
      .map(([name, value]) => parseServerConfig(name, value)),
  );
}

export function createMcpServerConfig(name: string, value: JsonObject): McpServerConfig {
  return parseServerConfig(name, value);
}

export function mcpConfigContainsSecret(
  config: McpServerConfig,
  forbiddenSecrets: ReadonlySet<string>,
): boolean {
  const values = [
    config.command,
    ...config.args,
    ...(config.cwd === undefined ? [] : [config.cwd]),
    ...Object.entries(config.env).flatMap(([target, reference]) => [target, reference.name]),
  ];
  const secrets = [...forbiddenSecrets].filter((secret) => secret.length >= 8);
  return values.some((value) => secrets.some((secret) => value.includes(secret)));
}

export function assertMcpConfigSecretSeparation(
  config: McpServerConfig,
  forbiddenSecrets: ReadonlySet<string>,
): void {
  if (mcpConfigContainsSecret(config, forbiddenSecrets)) {
    throw new PermissionDeniedError(
      `MCP command/args/cwd에 model credential 값을 직접 넣을 수 없습니다: ${config.name}`,
    );
  }
}

export function mcpServerConfigJson(config: McpServerConfig): JsonObject {
  const environment = Object.create(null) as JsonObject;
  for (const [target, reference] of Object.entries(config.env)) {
    environment[target] = { source: reference.source, name: reference.name };
  }
  return {
    command: config.command,
    args: [...config.args],
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    protocolVersion: config.protocolVersion,
    disabled: config.disabled,
    ...(Object.keys(environment).length === 0 ? {} : { env: environment }),
  };
}

export async function resolveMcpCwd(
  workspace: string,
  config: McpServerConfig,
): Promise<ResolvedMcpCwd> {
  let root: string;
  let candidate: string;
  let information: Awaited<ReturnType<typeof stat>>;
  try {
    root = await realpath(workspace);
    candidate = await realpath(resolve(root, config.cwd ?? "."));
    information = await stat(candidate);
    if (
      !information.isDirectory() ||
      !Number.isSafeInteger(information.dev) ||
      !Number.isSafeInteger(information.ino) ||
      information.dev < 0 ||
      information.ino < 0
    ) {
      throw new Error("not a safely identifiable directory");
    }
  } catch (error) {
    throw new McpError(`MCP 서버 cwd를 확인하지 못했습니다: ${config.name}`, { cause: error });
  }
  const child = relative(root, candidate);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new PermissionDeniedError(`MCP 서버 cwd는 workspace 안에 있어야 합니다: ${config.name}`);
  }
  return Object.freeze({
    path: candidate,
    device: information.dev,
    inode: information.ino,
  });
}

export async function revalidateMcpCwd(expected: ResolvedMcpCwd): Promise<void> {
  let candidate: string;
  let information: Awaited<ReturnType<typeof stat>>;
  try {
    candidate = await realpath(expected.path);
    information = await stat(candidate);
  } catch (error) {
    throw new PermissionDeniedError("승인 뒤 MCP cwd를 다시 확인하지 못했습니다.", { cause: error });
  }
  const inodeMatches = process.platform === "win32" && (information.ino === 0 || expected.inode === 0)
    ? true
    : information.ino === expected.inode;
  if (
    candidate !== expected.path ||
    !information.isDirectory() ||
    information.dev !== expected.device ||
    !inodeMatches
  ) {
    throw new PermissionDeniedError("승인 뒤 MCP cwd filesystem identity가 변경됐습니다.");
  }
}

export function resolveMcpEnvironment(
  config: McpServerConfig,
  source: NodeJS.ProcessEnv,
  forbiddenSecrets: ReadonlySet<string> = new Set(),
): ResolvedMcpEnvironment {
  const environment = buildChildEnvironment({ source });
  const secretSet = new Set<string>();
  const blockedValues = [...forbiddenSecrets].filter((secret) => secret.length >= 8);
  let totalBytes = Object.entries(environment).reduce(
    (total, [name, value]) => total + Buffer.byteLength(name, "utf8") + Buffer.byteLength(value ?? "", "utf8"),
    0,
  );
  for (const [target, reference] of Object.entries(config.env)) {
    const value = source[reference.name];
    if (value === undefined || value.length === 0) {
      throw new McpError(`MCP secret environment 참조를 찾을 수 없습니다: ${config.name}.${target}`);
    }
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes < 8 || bytes > MAX_ENVIRONMENT_VALUE_BYTES || value.includes("\0")) {
      throw new McpError(`MCP secret environment 값의 크기 또는 형식이 올바르지 않습니다: ${config.name}.${target}`);
    }
    if (blockedValues.some((secret) => value.includes(secret))) {
      throw new PermissionDeniedError(
        `Model credential과 같은 값을 MCP child에 전달할 수 없습니다: ${config.name}.${target}`,
      );
    }
    totalBytes += Buffer.byteLength(target, "utf8") + bytes;
    if (totalBytes > MAX_ENVIRONMENT_TOTAL_BYTES) {
      throw new McpError(`MCP child environment 전체 크기 제한을 초과했습니다: ${config.name}`);
    }
    environment[target] = value;
    secretSet.add(value);
  }
  const fingerprints = Object.create(null) as JsonObject;
  for (const [name, value] of Object.entries(environment).sort(([left], [right]) => unicodeCompare(left, right))) {
    if (value === undefined) continue;
    fingerprints[name] = createHash("sha256").update(value, "utf8").digest("hex");
  }
  Object.freeze(environment);
  return Object.freeze({
    environment,
    secrets: Object.freeze([...secretSet]),
    version: digest({ configVersion: config.configVersion, childEnvironment: fingerprints }),
  });
}

export function mcpConfigurationVersion(configs: readonly McpServerConfig[]): string {
  return digest(configs.map((config) => ({
    name: config.name,
    configVersion: config.configVersion,
    disabled: config.disabled,
  })));
}

export async function prepareMcpExecutionPlan(
  workspace: string,
  configs: readonly McpServerConfig[],
  source: NodeJS.ProcessEnv,
  forbiddenSecrets: ReadonlySet<string> = new Set(),
): Promise<McpExecutionPlan> {
  const targets: JsonObject[] = [];
  const executions: PreparedMcpServerExecution[] = [];
  for (const config of configs) {
    if (config.disabled) {
      targets.push(Object.freeze({
        name: config.name,
        configVersion: config.configVersion,
        disabled: true,
      }));
      continue;
    }
    const environment = resolveMcpEnvironment(config, source, forbiddenSecrets);
    const cwd = await resolveMcpCwd(workspace, config);
    const target: JsonObject = {
      name: config.name,
      command: config.command,
      argsHash: digest([...config.args]),
      cwd: Object.freeze({
        path: cwd.path,
        device: String(cwd.device),
        inode: String(cwd.inode),
      }),
      protocolVersion: config.protocolVersion,
      configVersion: config.configVersion,
      environmentVersion: environment.version,
      disabled: false,
    };
    targets.push(Object.freeze(target));
    executions.push(Object.freeze({ config, cwd, environment }));
  }
  const stableTargets = Object.freeze(targets);
  return Object.freeze({
    workspace,
    configurationVersion: mcpConfigurationVersion(configs),
    version: digest(stableTargets as unknown as JsonValue),
    targets: stableTargets,
    executions: Object.freeze(executions),
  });
}

function cloneObject(value: JsonObject): JsonObject {
  return structuredClone(value) as JsonObject;
}

export class McpConfigStore {
  readonly #paths: StoragePaths;
  readonly #projectTrusted: boolean;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: {
    readonly paths: StoragePaths;
    readonly projectTrusted: boolean;
    readonly environment: NodeJS.ProcessEnv;
  }) {
    this.#paths = options.paths;
    this.#projectTrusted = options.projectTrusted;
    this.#environment = options.environment;
  }

  pathForScope(scope: McpConfigScope): string {
    if ((scope === "project" || scope === "local") && !this.#projectTrusted) {
      throw new PermissionDeniedError("신뢰하지 않은 workspace의 프로젝트 MCP 설정은 변경할 수 없습니다.");
    }
    return scope === "user"
      ? this.#paths.userSettings
      : scope === "project"
        ? this.#paths.projectSettings
        : this.#paths.projectLocalSettings;
  }

  async snapshot(): Promise<McpConfigurationSnapshot> {
    const settings = await loadSettings(this.#paths, {
      projectTrusted: this.#projectTrusted,
      environment: this.#environment,
    });
    const raw = settings.values.mcpServers === undefined
      ? {}
      : cloneObject(settings.values.mcpServers);
    const configs = parseMcpServerConfigs(raw);
    return Object.freeze({
      raw: Object.freeze(raw),
      configs,
      version: digest(raw),
      settings,
    });
  }

  async layerRevision(scope: McpConfigScope): Promise<{ readonly path: string; readonly revision: string }> {
    const path = this.pathForScope(scope);
    const document = await this.#readLayer(path);
    return Object.freeze({ path, revision: digest(document) });
  }

  async upsert(
    scope: McpConfigScope,
    config: McpServerConfig,
    expectedRevision?: string,
  ): Promise<string> {
    const path = this.pathForScope(scope);
    const document = await this.#readLayer(path);
    if (expectedRevision !== undefined && digest(document) !== expectedRevision) {
      throw new McpError("승인 뒤 MCP 설정 파일이 변경됐습니다.");
    }
    const current = document.mcpServers;
    if (current !== undefined && !record(current)) {
      throw new McpError(`${path}의 mcpServers 설정은 객체여야 합니다.`);
    }
    const servers = current === undefined ? {} : cloneObject(current as JsonObject);
    servers[config.name] = mcpServerConfigJson(config);
    document.mcpServers = servers;
    await this.#writeLayer(path, document);
    return path;
  }

  async remove(
    scope: McpConfigScope,
    name: string,
    expectedRevision?: string,
  ): Promise<{ readonly path: string; readonly removed: boolean }> {
    if (!SERVER_NAME_PATTERN.test(name)) throw new McpError(`MCP 서버 이름이 올바르지 않습니다: ${name}`);
    const path = this.pathForScope(scope);
    const document = await this.#readLayer(path);
    if (expectedRevision !== undefined && digest(document) !== expectedRevision) {
      throw new McpError("승인 뒤 MCP 설정 파일이 변경됐습니다.");
    }
    const current = document.mcpServers;
    if (current === undefined) return Object.freeze({ path, removed: false });
    if (!record(current)) throw new McpError(`${path}의 mcpServers 설정은 객체여야 합니다.`);
    if (!Object.hasOwn(current, name)) return Object.freeze({ path, removed: false });
    const servers = cloneObject(current as JsonObject);
    delete servers[name];
    if (Object.keys(servers).length === 0) delete document.mcpServers;
    else document.mcpServers = servers;
    await this.#writeLayer(path, document);
    return Object.freeze({ path, removed: true });
  }

  async #readLayer(path: string): Promise<JsonObject> {
    const existing = await readJsonObject(path, {
      label: `MCP 설정 파일 ${path}`,
      maxBytes: MAX_SETTINGS_BYTES,
      requireOwner: true,
    });
    const document = existing === undefined
      ? { schemaVersion: SETTINGS_SCHEMA_VERSION }
      : cloneObject(existing);
    parseSettingsValues(document, path, true);
    return document;
  }

  async #writeLayer(path: string, document: JsonObject): Promise<void> {
    parseSettingsValues(document, path, true);
    parseMcpServerConfigs(document.mcpServers);
    await this.#assertProspectiveConfiguration(path, document);
    await writeJsonObjectAtomic(path, document, {
      label: `MCP 설정 파일 ${path}`,
      maxBytes: MAX_SETTINGS_BYTES,
      directoryMode: 0o700,
      fileMode: 0o600,
      requireOwner: true,
    });
  }

  async #assertProspectiveConfiguration(
    replacedPath: string,
    replacement: JsonObject,
  ): Promise<void> {
    const merged = Object.create(null) as JsonObject;
    const applyLayer = async (path: string, requireOwner: boolean): Promise<void> => {
      const document = path === replacedPath
        ? replacement
        : await readJsonObject(path, {
            label: `MCP 설정 파일 ${path}`,
            maxBytes: MAX_SETTINGS_BYTES,
            requireOwner,
          });
      if (document === undefined) return;
      const layer = parseSettingsValues(document, path, true).mcpServers;
      if (layer === undefined) return;
      for (const [name, config] of Object.entries(layer)) merged[name] = structuredClone(config);
    };

    await applyLayer(this.#paths.userSettings, true);
    if (this.#projectTrusted) {
      await applyLayer(this.#paths.projectSettings, false);
      await applyLayer(this.#paths.projectLocalSettings, false);
    }
    parseMcpServerConfigs(merged);
  }
}

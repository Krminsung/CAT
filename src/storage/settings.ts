import { basename } from "node:path";
import { ConfigurationError } from "../core/errors.js";
import type { JsonObject, JsonValue } from "../core/json.js";
import type { PermissionMode } from "../security/permissions.js";
import { readJsonObject, writeJsonObjectAtomic } from "./json-file.js";
import type { StoragePaths } from "./paths.js";

export type { PermissionMode } from "../security/permissions.js";

export const SETTINGS_SCHEMA_VERSION = 1;

export interface WorktreeSettings {
  baseRef?: string;
}

export interface SettingsValues {
  permissionMode: PermissionMode;
  maxTurns: number;
  contextWindow?: number;
  autoCompactThreshold: number;
  verbose: boolean;
  allowedTools: string[];
  disallowedTools: string[];
  tools: string;
  projectDocMaxBytes: number;
  projectDocFallbackFilenames: string[];
  hooks?: JsonObject;
  mcpServers?: JsonObject;
  worktree?: WorktreeSettings;
  provider?: string;
  profile?: string;
  model?: string;
}

export type SettingsOverrides = Partial<SettingsValues>;

export interface LoadedSettings {
  values: SettingsValues;
  sources: readonly string[];
  projectSettingsSkipped: boolean;
}

export interface LoadSettingsOptions {
  projectTrusted: boolean;
  environment?: NodeJS.ProcessEnv;
  cli?: JsonObject;
}

const DEFAULT_SETTINGS: SettingsValues = {
  permissionMode: "ask",
  maxTurns: 12,
  autoCompactThreshold: 0.85,
  verbose: false,
  allowedTools: [],
  disallowedTools: [],
  tools: "default",
  projectDocMaxBytes: 32_768,
  projectDocFallbackFilenames: ["SMILESERV.md", "CAGENT.md"],
};

const SETTING_KEYS = new Set([
  "permissionMode",
  "maxTurns",
  "contextWindow",
  "autoCompactThreshold",
  "verbose",
  "allowedTools",
  "disallowedTools",
  "tools",
  "projectDocMaxBytes",
  "projectDocFallbackFilenames",
  "hooks",
  "mcpServers",
  "worktree",
  "provider",
  "profile",
  "model",
]);

const SECRET_SETTING_PATTERN = /(?:api.?key|password|passwd|token|secret|cookie)/iu;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

function fail(source: string, key: string, expectation: string): never {
  throw new ConfigurationError(`${source}의 ${key} 설정은 ${expectation}.`);
}

function optionalString(
  raw: JsonObject,
  key: "provider" | "profile" | "model",
  source: string,
  maxLength: number,
): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /\p{Cc}/u.test(value) ||
    [...value.trim()].length > maxLength
  ) {
    return fail(
      source,
      key,
      `제어 문자가 없는 1–${maxLength}자의 문자열이어야 합니다`,
    );
  }
  return value.trim();
}

function stringList(raw: JsonObject, key: string, source: string): string[] | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        !item.trim() ||
        [...item].length > 256 ||
        /\p{Cc}/u.test(item),
    )
  ) {
    return fail(
      source,
      key,
      "제어 문자가 없는 문자열을 최대 256개 담은 배열이어야 합니다",
    );
  }
  return value.map((item) => String(item).trim());
}

function worktreeSettings(raw: JsonObject, source: string): WorktreeSettings | undefined {
  const value = raw.worktree;
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(source, "worktree", "객체여야 합니다");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "baseRef")) {
    return fail(source, "worktree", "baseRef만 포함할 수 있습니다");
  }
  const baseRef = value.baseRef;
  if (baseRef === undefined) return {};
  if (
    typeof baseRef !== "string" ||
    !baseRef.trim() ||
    baseRef.trim().startsWith("-") ||
    /[\p{Cc}\p{Cf}]/u.test(baseRef) ||
    Buffer.byteLength(baseRef.trim(), "utf8") > 1_024
  ) {
    return fail(
      source,
      "worktree.baseRef",
      "-로 시작하지 않는 제어 문자 없는 1–1024 bytes Git ref여야 합니다",
    );
  }
  return { baseRef: baseRef.trim() };
}

function integer(
  raw: JsonObject,
  key: string,
  source: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return fail(source, key, `${minimum}–${maximum} 범위의 정수여야 합니다`);
  }
  return Number(value);
}

export function parseSettingsValues(
  raw: JsonObject,
  source: string,
  requireSchemaVersion: boolean,
): SettingsOverrides {
  for (const key of Object.keys(raw)) {
    if (key === "schemaVersion") continue;
    if (SECRET_SETTING_PATTERN.test(key)) {
      throw new ConfigurationError(`${source}에는 secret 설정 ${key}을 저장할 수 없습니다.`);
    }
    if (!SETTING_KEYS.has(key)) {
      throw new ConfigurationError(`${source}에 알 수 없는 설정 ${key}이 있습니다.`);
    }
  }
  if (requireSchemaVersion && raw.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    throw new ConfigurationError(
      `${source}의 schemaVersion은 ${SETTINGS_SCHEMA_VERSION}이어야 합니다.`,
    );
  }

  const result: SettingsOverrides = {};
  const permissionMode = raw.permissionMode;
  if (permissionMode !== undefined) {
    if (
      permissionMode !== "ask" &&
      permissionMode !== "auto-edit" &&
      permissionMode !== "full-auto" &&
      permissionMode !== "plan"
    ) {
      fail(source, "permissionMode", "ask, auto-edit, full-auto, plan 중 하나여야 합니다");
    }
    result.permissionMode = permissionMode;
  }
  const maxTurns = integer(raw, "maxTurns", source, 1, 100);
  if (maxTurns !== undefined) result.maxTurns = maxTurns;
  const contextWindow = integer(raw, "contextWindow", source, 1_024, 2_000_000);
  if (contextWindow !== undefined) result.contextWindow = contextWindow;
  const threshold = raw.autoCompactThreshold;
  if (threshold !== undefined) {
    if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0.5 || threshold > 0.95) {
      fail(source, "autoCompactThreshold", "0.5–0.95 범위의 유한한 숫자여야 합니다");
    }
    result.autoCompactThreshold = threshold;
  }
  if (raw.verbose !== undefined) {
    if (typeof raw.verbose !== "boolean") fail(source, "verbose", "boolean이어야 합니다");
    result.verbose = raw.verbose;
  }
  const allowedTools = stringList(raw, "allowedTools", source);
  if (allowedTools !== undefined) result.allowedTools = allowedTools;
  const disallowedTools = stringList(raw, "disallowedTools", source);
  if (disallowedTools !== undefined) result.disallowedTools = disallowedTools;
  if (raw.tools !== undefined) {
    if (
      typeof raw.tools !== "string" ||
      !raw.tools.trim() ||
      /\p{Cc}/u.test(raw.tools) ||
      [...raw.tools].length > 2_048
    ) {
      fail(source, "tools", "제어 문자가 없는 1–2048자의 문자열이어야 합니다");
    }
    result.tools = raw.tools.trim();
  }
  const documentBytes = integer(raw, "projectDocMaxBytes", source, 1_024, 1_000_000);
  if (documentBytes !== undefined) result.projectDocMaxBytes = documentBytes;
  const fallbackNames = stringList(raw, "projectDocFallbackFilenames", source);
  if (fallbackNames !== undefined) {
    if (
      fallbackNames.some(
        (name) =>
          basename(name) !== name ||
          name === "." ||
          name === ".." ||
          name.includes("/") ||
          name.includes("\\"),
      )
    ) {
      fail(source, "projectDocFallbackFilenames", "경로가 아닌 파일 이름만 포함해야 합니다");
    }
    result.projectDocFallbackFilenames = fallbackNames;
  }
  if (raw.hooks !== undefined) {
    if (typeof raw.hooks !== "object" || raw.hooks === null || Array.isArray(raw.hooks)) {
      fail(source, "hooks", "객체여야 합니다");
    }
    result.hooks = structuredClone(raw.hooks) as JsonObject;
  }
  if (raw.mcpServers !== undefined) {
    if (typeof raw.mcpServers !== "object" || raw.mcpServers === null || Array.isArray(raw.mcpServers)) {
      fail(source, "mcpServers", "객체여야 합니다");
    }
    result.mcpServers = structuredClone(raw.mcpServers) as JsonObject;
  }
  const worktree = worktreeSettings(raw, source);
  if (worktree !== undefined) result.worktree = worktree;
  const provider = optionalString(raw, "provider", source, 64);
  if (provider !== undefined) {
    if (!IDENTIFIER_PATTERN.test(provider)) fail(source, "provider", "안전한 식별자여야 합니다");
    result.provider = provider;
  }
  const profile = optionalString(raw, "profile", source, 64);
  if (profile !== undefined) {
    if (!IDENTIFIER_PATTERN.test(profile)) fail(source, "profile", "안전한 식별자여야 합니다");
    result.profile = profile;
  }
  const model = optionalString(raw, "model", source, 256);
  if (model !== undefined) result.model = model;
  return result;
}

function environmentSettings(environment: NodeJS.ProcessEnv): JsonObject {
  const result: JsonObject = {};
  const copy = (environmentName: string, key: string): void => {
    const value = environment[environmentName]?.trim();
    if (value) result[key] = value;
  };
  copy("CAT_PROVIDER", "provider");
  copy("CAT_PROFILE", "profile");
  copy("CAT_MODEL", "model");
  copy("CAT_PERMISSION_MODE", "permissionMode");
  copy("CAT_TOOLS", "tools");
  const maxTurns = environment.CAT_MAX_TURNS?.trim();
  if (maxTurns) result.maxTurns = /^\d+$/u.test(maxTurns) ? Number(maxTurns) : maxTurns;
  const verbose = environment.CAT_VERBOSE?.trim().toLowerCase();
  if (verbose) {
    result.verbose = verbose === "true" ? true : verbose === "false" ? false : verbose;
  }
  return result;
}

function mergeSettings(base: SettingsValues, overlay: SettingsOverrides): SettingsValues {
  const mergedMcpServers = overlay.mcpServers === undefined
    ? base.mcpServers === undefined
      ? undefined
      : structuredClone(base.mcpServers)
    : {
        ...(base.mcpServers === undefined ? {} : structuredClone(base.mcpServers)),
        ...structuredClone(overlay.mcpServers),
      };
  return {
    ...base,
    ...overlay,
    allowedTools: overlay.allowedTools ? [...overlay.allowedTools] : [...base.allowedTools],
    disallowedTools: overlay.disallowedTools
      ? [...overlay.disallowedTools]
      : [...base.disallowedTools],
    projectDocFallbackFilenames: overlay.projectDocFallbackFilenames
      ? [...overlay.projectDocFallbackFilenames]
      : [...base.projectDocFallbackFilenames],
    ...(mergedMcpServers === undefined ? {} : { mcpServers: mergedMcpServers }),
    ...(overlay.worktree === undefined
      ? base.worktree === undefined
        ? {}
        : { worktree: { ...base.worktree } }
      : { worktree: { ...overlay.worktree } }),
  };
}

export async function loadSettings(
  paths: StoragePaths,
  options: LoadSettingsOptions,
): Promise<LoadedSettings> {
  let values = mergeSettings(DEFAULT_SETTINGS, {});
  const sources: string[] = ["defaults"];
  const applyFile = async (path: string, requireOwner = false): Promise<void> => {
    const document = await readJsonObject(path, {
      label: `설정 파일 ${path}`,
      maxBytes: 1024 * 1024,
      requireOwner,
    });
    if (!document) return;
    values = mergeSettings(values, parseSettingsValues(document, path, true));
    sources.push(path);
  };

  await applyFile(paths.userSettings, true);
  if (options.projectTrusted) {
    await applyFile(paths.projectSettings);
    await applyFile(paths.projectLocalSettings);
  }
  const environment = environmentSettings(options.environment ?? process.env);
  if (Object.keys(environment).length > 0) {
    values = mergeSettings(
      values,
      parseSettingsValues(environment, "CAT_* 환경변수", false),
    );
    sources.push("environment");
  }
  if (options.cli && Object.keys(options.cli).length > 0) {
    values = mergeSettings(values, parseSettingsValues(options.cli, "CLI 인자", false));
    sources.push("cli");
  }
  return {
    values,
    sources,
    projectSettingsSkipped: !options.projectTrusted,
  };
}

function overridesToJson(overrides: SettingsOverrides): JsonObject {
  const result: JsonObject = { schemaVersion: SETTINGS_SCHEMA_VERSION };
  const assign = (key: string, value: JsonValue | undefined): void => {
    if (value !== undefined) result[key] = Array.isArray(value) ? [...value] : value;
  };
  assign("permissionMode", overrides.permissionMode);
  assign("maxTurns", overrides.maxTurns);
  assign("contextWindow", overrides.contextWindow);
  assign("autoCompactThreshold", overrides.autoCompactThreshold);
  assign("verbose", overrides.verbose);
  assign("allowedTools", overrides.allowedTools);
  assign("disallowedTools", overrides.disallowedTools);
  assign("tools", overrides.tools);
  assign("projectDocMaxBytes", overrides.projectDocMaxBytes);
  assign("projectDocFallbackFilenames", overrides.projectDocFallbackFilenames);
  assign("hooks", overrides.hooks);
  assign("mcpServers", overrides.mcpServers);
  assign("worktree", overrides.worktree === undefined ? undefined : { ...overrides.worktree });
  assign("provider", overrides.provider);
  assign("profile", overrides.profile);
  assign("model", overrides.model);
  return result;
}

export async function saveSettings(
  path: string,
  overrides: SettingsOverrides,
): Promise<void> {
  const document = overridesToJson(overrides);
  parseSettingsValues(document, path, true);
  await writeJsonObjectAtomic(path, document, {
    label: `설정 파일 ${path}`,
    maxBytes: 1024 * 1024,
    directoryMode: 0o700,
    fileMode: 0o600,
    requireOwner: true,
  });
}

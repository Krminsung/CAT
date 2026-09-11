import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { ConfigurationError, StorageError } from "../core/errors.js";
import type { JsonObject, JsonValue } from "../core/json.js";
import type { ProviderProtocol } from "../core/provider.js";
import {
  conversationMessageFromJson,
  transcriptMessageRequest,
} from "../context/transcript.js";
import {
  defaultProviderEndpoint,
  requireProviderDefinition,
  validateProviderProfileCatalog,
} from "../providers/catalog.js";
import { normalizeProviderBaseUrl } from "../security/endpoints.js";
import {
  CredentialStore,
  MAX_STORED_CREDENTIALS,
  MAX_STORED_PROFILES,
  ProviderProfileStore,
  SessionJsonlStore,
  assertLegacyDataSourceCurrent,
  createProviderProfile,
  openLegacyDataSource,
  parseSettingsValues,
  readJsonObject,
  readLegacyCredentials,
  readLegacyProviderCredentials,
  readLegacySessionIndexPage,
  readLegacySettings,
  readLegacyTranscriptPage,
  saveSettings,
  validateApiKey,
  normalizeProfileName,
  type LegacyDataEntryName,
  type LegacyDataSource,
  type SessionMetadata,
  type SessionTranscriptWriter,
  type SettingsOverrides,
  type StoragePaths,
  type TranscriptAppendRequest,
} from "../storage/index.js";
import { BUILTIN_TOOL_NAMES } from "../tools/runtime.js";
import { assertApiKeySeparatedFromValues } from "./auth-service.js";

const LEGACY_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MAX_SOURCE_SESSION_INDEX_BYTES = 256 * 1024 * 1024;
const MAX_SOURCE_SESSION_RECORDS = 50_000;
const MAX_SOURCE_SESSION_PAGES = 512;
const MAX_SOURCE_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_TRANSCRIPT_RECORDS = 100_000;
const MAX_SOURCE_TRANSCRIPT_PAGES = 512;
const MAX_TOTAL_TRANSCRIPT_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_TRANSCRIPT_RECORDS = 250_000;
const MAX_IMPORTED_EVENT_BYTES = 3 * 1024 * 1024;
const MAX_IMPORTED_MESSAGE_BYTES = 1536 * 1024;
const MAX_REPORTED_MAPPINGS = 32;
const DUMMY_CREDENTIAL_ID = "cred_00000000-0000-4000-8000-000000000000";
const BUILTIN_TOOL_NAME_SET = new Set<string>(BUILTIN_TOOL_NAMES);

const SAFE_LEGACY_SETTING_KEYS = Object.freeze([
  "model",
  "maxTurns",
  "contextWindow",
  "autoCompactThreshold",
  "verbose",
  "tools",
  "projectDocMaxBytes",
  "projectDocFallbackFilenames",
] as const);

interface PlannedSettings {
  readonly overrides: SettingsOverrides;
  readonly importedKeys: readonly string[];
  readonly omittedKeys: number;
}

interface PlannedCredential {
  readonly legacyProfile: string;
  readonly provider: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly origin: string;
  readonly protocol: ProviderProtocol;
  readonly modelsPath: string;
  readonly generationPath: string;
  readonly endpointSource: "provider_default" | "user";
  readonly model?: string;
}

interface PlannedCredentials {
  readonly profiles: readonly PlannedCredential[];
  readonly activeProfile?: string;
}

interface LegacySession {
  readonly sourceSessionId: string;
  readonly cwd: string;
  readonly model: string;
  readonly updatedAt: string;
  readonly responseId?: string;
  readonly name?: string;
  readonly providerProfile?: string;
}

interface LegacySessionScan {
  readonly sessions: readonly LegacySession[];
  readonly invalidRecords: number;
  readonly sourceWarnings: number;
}

interface ImportedProfileBinding {
  readonly profile: string;
  readonly provider: string;
}

interface TranscriptBudget {
  bytes: number;
  records: number;
}

export interface LegacyImportRequest {
  readonly sourceRoot: string;
  readonly includeCredentials: boolean;
  readonly onSecrets?: (secrets: readonly string[]) => void;
}

export interface LegacyImportResult {
  readonly sourceRoot: string;
  readonly sourceEntries: readonly LegacyDataEntryName[];
  readonly settings: {
    readonly status: "absent" | "imported" | "target_exists" | "no_supported_values";
    readonly importedKeys: readonly string[];
    readonly omittedKeys: number;
  };
  readonly credentials: {
    readonly requested: boolean;
    readonly discovered: number;
    readonly imported: number;
    readonly conflicts: number;
  };
  readonly sessions: {
    readonly discovered: number;
    readonly imported: number;
    readonly conflicts: number;
    readonly invalidIndexRecords: number;
    readonly sourceWarnings: number;
    readonly transcriptRecords: number;
    readonly transcriptWarnings: number;
    readonly omittedTranscriptRecords: number;
    readonly mappings: readonly {
      readonly sourceSessionId: string;
      readonly targetSessionId: string;
    }[];
    readonly omittedMappings: number;
  };
  readonly trustImported: false;
  readonly approvalsImported: false;
  readonly sourceModified: false;
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function object(value: JsonValue | undefined, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError(`${label}은 객체여야 합니다.`);
  }
  return value;
}

function requiredText(
  value: JsonValue | undefined,
  label: string,
  maximumBytes: number,
): string {
  if (typeof value !== "string") {
    throw new ConfigurationError(`${label}은 문자열이어야 합니다.`);
  }
  const selected = value.trim();
  if (
    !selected ||
    Buffer.byteLength(selected, "utf8") > maximumBytes ||
    /[\u0000-\u001f\u007f]/u.test(selected)
  ) {
    throw new ConfigurationError(`${label} 형식 또는 크기가 올바르지 않습니다.`);
  }
  return selected;
}

function optionalText(
  value: JsonValue | undefined,
  label: string,
  maximumBytes: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredText(value, label, maximumBytes);
}

function normalizedTimestamp(value: JsonValue | undefined, label: string): string {
  const selected = requiredText(value, label, 64);
  const milliseconds = Date.parse(selected);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new ConfigurationError(`${label}이 올바른 timestamp가 아닙니다.`);
  }
  return new Date(milliseconds).toISOString();
}

function cloneJson(value: JsonValue): JsonValue {
  return structuredClone(value);
}

function credentialSecretCandidates(
  providersDocument: JsonObject | undefined,
  credentialDocument: JsonObject | undefined,
): readonly string[] {
  const values: string[] = [];
  const add = (value: JsonValue | undefined): void => {
    if (typeof value !== "string") return;
    const selected = value.trim();
    const bytes = Buffer.byteLength(selected, "utf8");
    if (bytes >= 8 && bytes <= 8 * 1024) values.push(selected);
  };
  const profiles = providersDocument?.profiles;
  if (
    typeof profiles === "object" &&
    profiles !== null &&
    !Array.isArray(profiles) &&
    Object.keys(profiles).length <= MAX_STORED_PROFILES
  ) {
    for (const value of Object.values(profiles)) {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        add(value.apiKey);
      }
    }
  }
  add(credentialDocument?.apiKey);
  return Object.freeze([...new Set(values)]);
}

function planSettings(document: JsonObject | undefined): PlannedSettings | undefined {
  if (!document) return undefined;
  const selected: JsonObject = {};
  const importedKeys: string[] = [];
  for (const key of SAFE_LEGACY_SETTING_KEYS) {
    const value = document[key];
    if (value === undefined) continue;
    selected[key] = cloneJson(value);
    importedKeys.push(key);
  }
  if (document.deniedTools !== undefined) {
    selected.disallowedTools = cloneJson(document.deniedTools);
    importedKeys.push("deniedTools→disallowedTools");
  }
  const recognized = new Set<string>([
    ...SAFE_LEGACY_SETTING_KEYS,
    "deniedTools",
    "version",
    "schemaVersion",
  ]);
  let omittedKeys = Object.keys(document).filter((key) => !recognized.has(key)).length;
  const overrides = parseSettingsValues(selected, "기존 Smile Code 사용자 설정", false);
  const omitImportedKey = (key: string): void => {
    const index = importedKeys.indexOf(key);
    if (index >= 0) importedKeys.splice(index, 1);
  };
  const configuredTools = overrides.tools;
  if (configuredTools !== undefined && configuredTools !== "default") {
    const requested = [...new Set(
      configuredTools.split(",").map((item) => item.trim()).filter(Boolean),
    )];
    const supported = requested.filter((name) => BUILTIN_TOOL_NAME_SET.has(name));
    if (supported.length !== requested.length) omittedKeys += 1;
    if (supported.length === 0) {
      delete overrides.tools;
      omitImportedKey("tools");
    } else {
      overrides.tools = supported.join(",");
    }
  }
  const configuredDenials = overrides.disallowedTools;
  if (configuredDenials !== undefined) {
    const supported = configuredDenials.filter(
      (name) => BUILTIN_TOOL_NAME_SET.has(name),
    );
    if (supported.length !== configuredDenials.length) omittedKeys += 1;
    if (supported.length === 0) {
      delete overrides.disallowedTools;
      omitImportedKey("deniedTools→disallowedTools");
    } else {
      overrides.disallowedTools = supported;
    }
  }
  return Object.freeze({
    overrides,
    importedKeys: Object.freeze(importedKeys),
    omittedKeys,
  });
}

function settingsPublicValues(
  plan: PlannedSettings | undefined,
): readonly (string | undefined)[] {
  if (!plan) return Object.freeze([]);
  return Object.freeze([
    plan.overrides.model,
    plan.overrides.tools,
    ...(plan.overrides.disallowedTools ?? []),
    ...(plan.overrides.projectDocFallbackFilenames ?? []),
  ]);
}

function relativeApiPath(baseUrl: string, endpointUrl: string, fallback: string): string {
  try {
    const base = new URL(baseUrl);
    const endpoint = new URL(endpointUrl);
    const prefix = base.pathname.replace(/\/+$/u, "");
    if (
      base.origin !== endpoint.origin ||
      (prefix && endpoint.pathname !== prefix && !endpoint.pathname.startsWith(`${prefix}/`))
    ) {
      return fallback;
    }
    const suffix = endpoint.pathname.slice(prefix.length) || "/";
    return `/${suffix.replace(/^\/+|\/+$/gu, "")}`;
  } catch {
    return fallback;
  }
}

function planCredential(
  legacyProfile: string,
  raw: JsonObject,
): PlannedCredential {
  const profile = normalizeProfileName(legacyProfile);
  const provider = requiredText(raw.provider, `기존 profile ${profile} provider`, 64)
    .toLowerCase();
  const definition = requireProviderDefinition(provider);
  const apiKey = validateApiKey(
    requiredText(raw.apiKey, `기존 profile ${profile} API key`, 8 * 1024),
  );
  const protocolValue = optionalText(
    raw.protocol,
    `기존 profile ${profile} protocol`,
    32,
  );
  if (
    protocolValue !== undefined &&
    protocolValue !== "openai-responses" &&
    protocolValue !== "openai-chat"
  ) {
    throw new ConfigurationError(`기존 profile ${profile} protocol이 올바르지 않습니다.`);
  }

  let baseUrl: string;
  let protocol: ProviderProtocol;
  let modelsPath: string;
  let generationPath: string;
  let endpointSource: "provider_default" | "user";
  const configuredBaseUrl = optionalText(
    raw.baseUrl,
    `기존 profile ${profile} baseUrl`,
    2_048,
  );
  const configuredModelsPath = optionalText(
    raw.modelsPath,
    `기존 profile ${profile} modelsPath`,
    1_024,
  );
  const configuredGenerationPath = optionalText(
    raw.responsePath,
    `기존 profile ${profile} responsePath`,
    1_024,
  );
  if (definition.id === "custom") {
    if (!configuredBaseUrl || !protocolValue) {
      throw new ConfigurationError(
        `기존 custom profile ${profile}에는 baseUrl과 protocol이 필요합니다.`,
      );
    }
    baseUrl = configuredBaseUrl;
    protocol = protocolValue;
    modelsPath = configuredModelsPath ?? "/models";
    generationPath = configuredGenerationPath ??
      (protocol === "openai-responses" ? "/responses" : "/chat/completions");
    endpointSource = "user";
  } else {
    const defaults = defaultProviderEndpoint(definition.id);
    protocol = protocolValue ?? defaults.protocol;
    baseUrl = configuredBaseUrl ?? defaults.baseUrl;
    modelsPath = configuredModelsPath ?? defaults.modelsPath;
    generationPath = configuredGenerationPath ?? defaults.generationPath;
    endpointSource = configuredBaseUrl || configuredModelsPath || configuredGenerationPath
      ? "user"
      : "provider_default";
  }
  const endpoint = normalizeProviderBaseUrl(
    baseUrl,
    `기존 profile ${profile} endpoint`,
    false,
  );
  const model = optionalText(raw.selectedModel, `기존 profile ${profile} model`, 256);
  if (raw.verifiedAt !== undefined) {
    normalizedTimestamp(raw.verifiedAt, `기존 profile ${profile} verifiedAt`);
  }
  const validated = createProviderProfile({
    name: profile,
    provider: definition.id,
    protocol,
    baseUrl: endpoint.baseUrl,
    modelsPath,
    generationPath,
    ...(model === undefined ? {} : { model }),
    secretRef: {
      kind: "api_key",
      id: DUMMY_CREDENTIAL_ID,
      origin: endpoint.origin,
    },
    endpointSource,
  });
  validateProviderProfileCatalog(validated);
  assertApiKeySeparatedFromValues(
    apiKey,
    [
      validated.name,
      validated.provider,
      validated.baseUrl,
      validated.modelsPath,
      validated.generationPath,
      validated.model,
    ],
    "기존 provider profile의 공개 필드",
  );
  return Object.freeze({
    legacyProfile: profile,
    provider: definition.id,
    apiKey,
    baseUrl: validated.baseUrl,
    origin: validated.origin,
    protocol: validated.protocol,
    modelsPath: validated.modelsPath,
    generationPath: validated.generationPath,
    endpointSource: validated.endpointSource,
    ...(validated.model === undefined ? {} : { model: validated.model }),
  });
}

function standaloneCredentialPlan(document: JsonObject): PlannedCredential {
  const apiKey = validateApiKey(requiredText(document.apiKey, "기존 internal API key", 8 * 1024));
  const baseUrl = requiredText(document.baseUrl, "기존 internal API 주소", 2_048);
  normalizedTimestamp(document.verifiedAt, "기존 internal verifiedAt");
  const defaults = defaultProviderEndpoint("internal");
  const verifyUrl = optionalText(document.verifyUrl, "기존 internal 확인 주소", 2_048) ??
    `${baseUrl}${defaults.modelsPath}`;
  return planCredential("internal", {
    provider: "internal",
    apiKey,
    baseUrl,
    protocol: defaults.protocol,
    modelsPath: relativeApiPath(baseUrl, verifyUrl, defaults.modelsPath),
    responsePath: defaults.generationPath,
    verifiedAt: document.verifiedAt ?? new Date(0).toISOString(),
  });
}

function planCredentials(
  providersDocument: JsonObject | undefined,
  credentialDocument: JsonObject | undefined,
): PlannedCredentials {
  const planned = new Map<string, PlannedCredential>();
  let activeProfile: string | undefined;
  if (providersDocument) {
    const profiles = object(providersDocument.profiles, "기존 provider profiles");
    const entries = Object.entries(profiles);
    if (entries.length > MAX_STORED_PROFILES) {
      throw new ConfigurationError(
        `기존 provider profile은 최대 ${MAX_STORED_PROFILES}개까지 가져올 수 있습니다.`,
      );
    }
    for (const [name, value] of entries) {
      const normalizedName = normalizeProfileName(name);
      if (planned.has(normalizedName)) {
        throw new ConfigurationError(`정규화 뒤 중복되는 기존 profile이 있습니다: ${normalizedName}`);
      }
      planned.set(normalizedName, planCredential(normalizedName, object(
        value,
        `기존 provider profile ${normalizedName}`,
      )));
    }
    if (typeof providersDocument.activeProfile === "string") {
      try {
        const selected = normalizeProfileName(providersDocument.activeProfile);
        if (planned.has(selected)) activeProfile = selected;
      } catch {
        activeProfile = undefined;
      }
    }
  }
  if (credentialDocument && !planned.has("internal")) {
    planned.set("internal", standaloneCredentialPlan(credentialDocument));
  }
  if (planned.size > MAX_STORED_CREDENTIALS) {
    throw new ConfigurationError(
      `기존 credential은 최대 ${MAX_STORED_CREDENTIALS}개까지 가져올 수 있습니다.`,
    );
  }
  return Object.freeze({
    profiles: Object.freeze([...planned.values()]),
    ...(activeProfile === undefined ? {} : { activeProfile }),
  });
}

function sessionText(
  value: JsonValue | undefined,
  maximumBytes: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const selected = value.trim();
  if (
    !selected ||
    Buffer.byteLength(selected, "utf8") > maximumBytes ||
    /[\u0000-\u001f\u007f]/u.test(selected)
  ) return undefined;
  return selected;
}

function parseLegacySession(value: JsonObject): LegacySession | undefined {
  const sourceSessionId = sessionText(value.sessionId ?? value.session_id, 128);
  const cwd = sessionText(value.cwd, 4_096);
  const model = sessionText(value.model, 256);
  const timestampValue = value.updatedAt ?? value.updated_at;
  if (
    !sourceSessionId ||
    !LEGACY_SESSION_ID.test(sourceSessionId) ||
    !cwd ||
    !isAbsolute(cwd) ||
    !model ||
    typeof timestampValue !== "string"
  ) return undefined;
  const milliseconds = Date.parse(timestampValue);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  const responseId = sessionText(value.responseId ?? value.response_id, 512);
  const name = sessionText(value.name, 1_024);
  if (name !== undefined && [...name].length > 256) return undefined;
  const providerProfile = sessionText(
    value.providerProfile ?? value.provider_profile,
    64,
  );
  return Object.freeze({
    sourceSessionId,
    cwd: resolve(cwd),
    model,
    updatedAt: new Date(milliseconds).toISOString(),
    ...(responseId === undefined ? {} : { responseId }),
    ...(name === undefined ? {} : { name }),
    ...(providerProfile === undefined ? {} : { providerProfile }),
  });
}

async function scanLegacySessions(source: LegacyDataSource): Promise<LegacySessionScan> {
  const latest = new Map<string, LegacySession>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  let records = 0;
  let invalidRecords = 0;
  let sourceWarnings = 0;
  let snapshotBytes: number | undefined;
  while (true) {
    if (pages >= MAX_SOURCE_SESSION_PAGES) {
      throw new StorageError("기존 세션 index page 상한을 초과했습니다.");
    }
    const page = await readLegacySessionIndexPage(source, {
      ...(cursor === undefined ? {} : { cursor }),
      limit: 500,
    });
    pages += 1;
    if (snapshotBytes === undefined) {
      snapshotBytes = page.snapshotBytes;
      if (snapshotBytes > MAX_SOURCE_SESSION_INDEX_BYTES) {
        throw new StorageError("기존 세션 index 전체 크기 상한을 초과했습니다.");
      }
    } else if (snapshotBytes !== page.snapshotBytes) {
      throw new StorageError("기존 세션 index가 가져오기 중 변경되었습니다.");
    }
    records += page.records.length;
    if (records > MAX_SOURCE_SESSION_RECORDS) {
      throw new StorageError("기존 세션 index record 상한을 초과했습니다.");
    }
    sourceWarnings += page.warnings.length + page.omittedWarnings;
    for (const positioned of page.records) {
      const parsed = parseLegacySession(positioned.value);
      if (!parsed) {
        invalidRecords += 1;
        continue;
      }
      latest.delete(parsed.sourceSessionId);
      latest.set(parsed.sourceSessionId, parsed);
    }
    const next = page.nextCursor;
    if (next === undefined) break;
    if (seenCursors.has(next)) throw new StorageError("기존 세션 index cursor가 반복되었습니다.");
    seenCursors.add(next);
    cursor = next;
  }
  return Object.freeze({
    sessions: Object.freeze([...latest.values()]),
    invalidRecords,
    sourceWarnings,
  });
}

async function scanTargetSessionIds(store: SessionJsonlStore): Promise<Set<string>> {
  const ids = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  let records = 0;
  let snapshotBytes: number | undefined;
  while (true) {
    if (pages >= MAX_SOURCE_SESSION_PAGES) {
      throw new StorageError("대상 세션 index page 상한을 초과했습니다.");
    }
    const page = await store.readSessionPage({
      ...(cursor === undefined ? {} : { cursor }),
      limit: 500,
    });
    pages += 1;
    if (page.warnings.length > 0 || page.omittedWarnings > 0) {
      throw new StorageError(
        "대상 세션 index에 손상된 record가 있어 충돌 여부를 안전하게 판단할 수 없습니다.",
      );
    }
    if (snapshotBytes === undefined) {
      snapshotBytes = page.snapshotBytes;
      if (snapshotBytes > MAX_SOURCE_SESSION_INDEX_BYTES) {
        throw new StorageError("대상 세션 index 전체 크기 상한을 초과했습니다.");
      }
    } else if (snapshotBytes !== page.snapshotBytes) {
      throw new StorageError("대상 세션 index가 가져오기 중 변경되었습니다.");
    }
    records += page.records.length;
    if (records > MAX_SOURCE_SESSION_RECORDS) {
      throw new StorageError("대상 세션 index record 상한을 초과했습니다.");
    }
    for (const item of page.records) ids.add(item.value.metadata.sessionId);
    const next = page.nextCursor;
    if (next === undefined) break;
    if (seenCursors.has(next)) throw new StorageError("대상 세션 index cursor가 반복되었습니다.");
    seenCursors.add(next);
    cursor = next;
  }
  return ids;
}

function targetSessionId(source: LegacyDataSource, sourceSessionId: string): string {
  const digest = createHash("sha256")
    .update(`${source.fingerprint}\0${sourceSessionId}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `legacy_${digest}`;
}

function messageId(
  source: LegacyDataSource,
  sourceSessionId: string,
  lineNumber: number,
  role: string,
): string {
  return `legacy_${createHash("sha256")
    .update(`${source.fingerprint}\0${sourceSessionId}\0${lineNumber}\0${role}`, "utf8")
    .digest("hex")}`;
}

function transcriptTimestamp(
  value: JsonValue | undefined,
  fallback: string,
): { readonly iso: string; readonly milliseconds: number; readonly substituted: boolean } {
  if (typeof value === "string") {
    const milliseconds = Date.parse(value);
    if (Number.isSafeInteger(milliseconds) && milliseconds >= 0) {
      return Object.freeze({
        iso: new Date(milliseconds).toISOString(),
        milliseconds,
        substituted: false,
      });
    }
  }
  return Object.freeze({
    iso: fallback,
    milliseconds: Date.parse(fallback),
    substituted: true,
  });
}

function importedUsageEvent(
  raw: JsonObject,
  occurredAt: number,
  id: string,
): JsonObject | undefined {
  const integer = (value: JsonValue | undefined): number | undefined =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : undefined;
  const inputTokens = integer(raw.input_tokens);
  const outputTokens = integer(raw.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const usage: JsonObject = {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(inputTokens === undefined ||
        outputTokens === undefined ||
        !Number.isSafeInteger(inputTokens + outputTokens)
      ? {}
      : { totalTokens: inputTokens + outputTokens }),
  };
  return {
    type: "usage",
    runId: id,
    occurredAt,
    usage,
    source: "smilecode_legacy_import",
  };
}

function transcriptRequest(
  source: LegacyDataSource,
  session: LegacySession,
  raw: JsonObject,
  lineNumber: number,
): { readonly request?: TranscriptAppendRequest; readonly warning: boolean } {
  const typeValue = raw.type;
  if (
    typeof typeValue !== "string" ||
    !typeValue.trim() ||
    Buffer.byteLength(typeValue, "utf8") > 128 ||
    /[\u0000-\u001f\u007f]/u.test(typeValue)
  ) return Object.freeze({ warning: true });
  const type = typeValue;
  const timestamp = transcriptTimestamp(raw.timestamp, session.updatedAt);
  const id = messageId(source, session.sourceSessionId, lineNumber, type);
  const rawText = raw.text;
  if (
    (type === "user" || type === "assistant") &&
    typeof rawText === "string" &&
    raw.visible !== false &&
    raw.delivered !== false &&
    !(type === "assistant" && raw.has_tools === true)
  ) {
    const modelText = raw.model_text;
    const legacyText = type === "user" && typeof modelText === "string" && modelText
      ? modelText
      : rawText;
    if (Buffer.byteLength(legacyText, "utf8") > MAX_IMPORTED_MESSAGE_BYTES) {
      return Object.freeze({ warning: true });
    }
    try {
      const message = conversationMessageFromJson({
        role: type,
        id,
        createdAt: timestamp.milliseconds,
        content: [{ type: "text", text: legacyText }],
      });
      return Object.freeze({
        request: Object.freeze({
          ...transcriptMessageRequest(message),
          createdAt: timestamp.iso,
        }),
        warning: timestamp.substituted,
      });
    } catch (error) {
      if (error instanceof ConfigurationError) return Object.freeze({ warning: true });
      throw error;
    }
  }

  const legacyData = cloneJson(raw) as JsonObject;
  delete legacyData.type;
  delete legacyData.timestamp;
  const usage = type === "usage"
    ? importedUsageEvent(raw, timestamp.milliseconds, id)
    : undefined;
  const event: JsonObject = usage ?? {
    type: "legacy_record",
    source: "smilecode",
    legacyType: type,
    legacyLine: lineNumber,
    data: legacyData,
  };
  const data: JsonObject = { event };
  const serialized = JSON.stringify(data);
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > MAX_IMPORTED_EVENT_BYTES
  ) return Object.freeze({ warning: true });
  return Object.freeze({
    request: Object.freeze({
      kind: "agent_event",
      createdAt: timestamp.iso,
      data,
    }),
    warning: timestamp.substituted,
  });
}

async function existingPath(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new StorageError(`대상 경로를 확인할 수 없습니다: ${path}`, { cause: error });
  }
}

async function prospectiveRealPath(path: string): Promise<string> {
  let current = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      const existing = await realpath(current);
      return resolve(existing, ...missing.reverse());
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

function containsPath(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === "" || (
    relation !== ".." &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

async function assertDisjointRoots(source: LegacyDataSource, target: string): Promise<void> {
  const targetRoot = await prospectiveRealPath(target);
  if (containsPath(source.root, targetRoot) || containsPath(targetRoot, source.root)) {
    throw new ConfigurationError(
      "기존 데이터 원본과 CAT_HOME은 같거나 서로 포함하는 경로일 수 없습니다.",
    );
  }
}

export class LegacyImportService {
  readonly #paths: StoragePaths;

  constructor(paths: StoragePaths) {
    this.#paths = paths;
  }

  async run(request: LegacyImportRequest): Promise<LegacyImportResult> {
    const source = await openLegacyDataSource(request.sourceRoot);
    await assertDisjointRoots(source, this.#paths.catHome);

    const settingsPlan = planSettings(await readLegacySettings(source));
    const providersDocument = request.includeCredentials
      ? await readLegacyProviderCredentials(source)
      : undefined;
    const credentialDocument = request.includeCredentials
      ? await readLegacyCredentials(source)
      : undefined;
    if (request.includeCredentials) {
      request.onSecrets?.(credentialSecretCandidates(
        providersDocument,
        credentialDocument,
      ));
    }
    const credentialPlan: PlannedCredentials = request.includeCredentials
      ? planCredentials(providersDocument, credentialDocument)
      : Object.freeze({ profiles: Object.freeze([]) });
    const importedSettingValues = settingsPublicValues(settingsPlan);
    for (const profile of credentialPlan.profiles) {
      assertApiKeySeparatedFromValues(
        profile.apiKey,
        importedSettingValues,
        "이관할 사용자 설정",
      );
    }
    if (request.includeCredentials) {
      request.onSecrets?.(credentialPlan.profiles.map((profile) => profile.apiKey));
    }
    const sourceSessions = await scanLegacySessions(source);

    const credentialStore = new CredentialStore(this.#paths.credentialStore);
    const profileStore = new ProviderProfileStore(this.#paths.profileStore);
    const sessionStore = new SessionJsonlStore({ root: this.#paths.sessionStore });
    const targetSessionIds = await scanTargetSessionIds(sessionStore);
    const existingSecrets = await credentialStore.withRedactionSecrets(
      async (secrets) => Object.freeze([...secrets]),
    );
    request.onSecrets?.(existingSecrets);
    sessionStore.addRedactionSecrets([
      ...existingSecrets,
      ...credentialPlan.profiles.map((profile) => profile.apiKey),
    ]);

    const currentProfiles = await profileStore.load();
    const currentCredentials = await credentialStore.list();
    const importableCredentials = credentialPlan.profiles.filter(
      (profile) => !currentProfiles.profiles.has(profile.legacyProfile),
    );
    if (currentProfiles.profiles.size + importableCredentials.length > MAX_STORED_PROFILES) {
      throw new StorageError("가져온 profile을 저장하면 대상 profile 수 상한을 초과합니다.");
    }
    if (currentCredentials.length + importableCredentials.length > MAX_STORED_CREDENTIALS) {
      throw new StorageError("가져온 credential을 저장하면 대상 credential 수 상한을 초과합니다.");
    }

    const existingSettings = await readJsonObject(this.#paths.userSettings, {
      label: "cat 사용자 설정",
      maxBytes: 1024 * 1024,
      maxDepth: 40,
      maxNodes: 40_000,
      requireOwner: true,
      requirePrivateMode: true,
    });
    if (existingSettings) {
      parseSettingsValues(existingSettings, this.#paths.userSettings, true);
    }

    let settingsStatus: LegacyImportResult["settings"]["status"] = "absent";
    if (settingsPlan) {
      if (existingSettings) {
        settingsStatus = "target_exists";
      } else if (settingsPlan.importedKeys.length === 0) {
        settingsStatus = "no_supported_values";
      } else {
        await saveSettings(this.#paths.userSettings, settingsPlan.overrides);
        settingsStatus = "imported";
      }
    }

    const profileBindings = new Map<string, ImportedProfileBinding>();
    let importedCredentials = 0;
    for (const plan of importableCredentials) {
      const credential = await credentialStore.save({
        provider: plan.provider,
        origin: plan.origin,
        apiKey: plan.apiKey,
      });
      try {
        const profile = createProviderProfile({
          name: plan.legacyProfile,
          provider: plan.provider,
          protocol: plan.protocol,
          baseUrl: plan.baseUrl,
          modelsPath: plan.modelsPath,
          generationPath: plan.generationPath,
          ...(plan.model === undefined ? {} : { model: plan.model }),
          secretRef: credential.reference,
          endpointSource: plan.endpointSource,
        });
        await profileStore.save(profile, false);
        profileBindings.set(plan.legacyProfile, {
          profile: profile.name,
          provider: profile.provider,
        });
        importedCredentials += 1;
      } catch (error) {
        try {
          await credentialStore.remove(credential.reference);
        } catch (cleanupError) {
          throw new StorageError(
            `기존 profile ${plan.legacyProfile} 저장과 새 credential 정리에 모두 실패했습니다.`,
            { cause: new AggregateError([error, cleanupError]) },
          );
        }
        throw error;
      }
    }
    if (
      currentProfiles.activeProfile === undefined &&
      credentialPlan.activeProfile !== undefined &&
      profileBindings.has(credentialPlan.activeProfile)
    ) {
      await profileStore.setActive(profileBindings.get(credentialPlan.activeProfile)!.profile);
    }

    const mappings: Array<{ readonly sourceSessionId: string; readonly targetSessionId: string }> = [];
    const generatedTargets = new Set<string>();
    const transcriptBudget: TranscriptBudget = { bytes: 0, records: 0 };
    let importedSessions = 0;
    let sessionConflicts = 0;
    let transcriptRecords = 0;
    let transcriptWarnings = 0;
    let omittedTranscriptRecords = 0;
    for (const legacy of sourceSessions.sessions) {
      const targetId = targetSessionId(source, legacy.sourceSessionId);
      if (generatedTargets.has(targetId)) {
        throw new StorageError("기존 세션 ID 변환 결과가 충돌했습니다.");
      }
      generatedTargets.add(targetId);
      if (
        targetSessionIds.has(targetId) ||
        await existingPath(sessionStore.transcriptPath(targetId))
      ) {
        sessionConflicts += 1;
        continue;
      }
      const binding = legacy.providerProfile === undefined
        ? undefined
        : profileBindings.get(legacy.providerProfile.toLowerCase());
      const writer = await sessionStore.acquireTranscriptWriter(targetId);
      let released = false;
      try {
        if (await existingPath(writer.targetPath)) {
          released = await writer.release();
          if (!released) {
            throw new StorageError(
              `충돌한 대상 세션 ${targetId}의 writer lock을 해제하지 못했습니다.`,
            );
          }
          sessionConflicts += 1;
          continue;
        }
        await writer.append({
          kind: "lifecycle",
          createdAt: legacy.updatedAt,
          data: {
            action: "legacy_import",
            sourceProduct: "Smile Code",
            sourceFingerprint: source.fingerprint.slice(0, 24),
            sourceSessionId: legacy.sourceSessionId,
            credentialsLinked: binding !== undefined,
            trustImported: false,
            approvalsImported: false,
          },
        });
        const transcript = await this.#importTranscript(
          source,
          legacy,
          writer,
          transcriptBudget,
        );
        transcriptRecords += transcript.imported;
        transcriptWarnings += transcript.warnings;
        omittedTranscriptRecords += transcript.omitted;
        const metadata: SessionMetadata = {
          sessionId: targetId,
          cwd: legacy.cwd,
          model: legacy.model,
          createdAt: legacy.updatedAt,
          updatedAt: legacy.updatedAt,
          revision: 1,
          status: "closed",
          ...(binding === undefined ? {} : {
            provider: binding.provider,
            profile: binding.profile,
          }),
          ...(binding === undefined || legacy.responseId === undefined
            ? {}
            : { responseId: legacy.responseId }),
          ...(legacy.name === undefined ? {} : { name: legacy.name }),
        };
        await sessionStore.saveSession(metadata, writer);
        released = await writer.release();
        if (!released) {
          throw new StorageError(`가져온 세션 ${targetId}의 writer lock을 해제하지 못했습니다.`);
        }
      } finally {
        if (!released) await writer.release().catch(() => false);
      }
      targetSessionIds.add(targetId);
      importedSessions += 1;
      if (mappings.length < MAX_REPORTED_MAPPINGS) {
        mappings.push(Object.freeze({
          sourceSessionId: legacy.sourceSessionId,
          targetSessionId: targetId,
        }));
      }
    }

    await assertLegacyDataSourceCurrent(source);
    return Object.freeze({
      sourceRoot: source.root,
      sourceEntries: source.entries,
      settings: Object.freeze({
        status: settingsStatus,
        importedKeys: settingsPlan?.importedKeys ?? Object.freeze([]),
        omittedKeys: settingsPlan?.omittedKeys ?? 0,
      }),
      credentials: Object.freeze({
        requested: request.includeCredentials,
        discovered: credentialPlan.profiles.length,
        imported: importedCredentials,
        conflicts: credentialPlan.profiles.length - importableCredentials.length,
      }),
      sessions: Object.freeze({
        discovered: sourceSessions.sessions.length,
        imported: importedSessions,
        conflicts: sessionConflicts,
        invalidIndexRecords: sourceSessions.invalidRecords,
        sourceWarnings: sourceSessions.sourceWarnings,
        transcriptRecords,
        transcriptWarnings,
        omittedTranscriptRecords,
        mappings: Object.freeze(mappings),
        omittedMappings: Math.max(0, importedSessions - mappings.length),
      }),
      trustImported: false,
      approvalsImported: false,
      sourceModified: false,
    });
  }

  async #importTranscript(
    source: LegacyDataSource,
    session: LegacySession,
    writer: SessionTranscriptWriter,
    total: TranscriptBudget,
  ): Promise<{ readonly imported: number; readonly warnings: number; readonly omitted: number }> {
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let records = 0;
    let imported = 0;
    let warnings = 0;
    let omitted = 0;
    let snapshotBytes: number | undefined;
    while (true) {
      if (pages >= MAX_SOURCE_TRANSCRIPT_PAGES) {
        throw new StorageError(`기존 세션 ${session.sourceSessionId} transcript page 상한을 초과했습니다.`);
      }
      const page = await readLegacyTranscriptPage(source, session.sourceSessionId, {
        ...(cursor === undefined ? {} : { cursor }),
        limit: 500,
      });
      pages += 1;
      if (snapshotBytes === undefined) {
        snapshotBytes = page.snapshotBytes;
        if (snapshotBytes > MAX_SOURCE_TRANSCRIPT_BYTES) {
          throw new StorageError(
            `기존 세션 ${session.sourceSessionId} transcript 크기 상한을 초과했습니다.`,
          );
        }
        total.bytes += snapshotBytes;
        if (total.bytes > MAX_TOTAL_TRANSCRIPT_BYTES) {
          throw new StorageError("기존 transcript 전체 크기 상한을 초과했습니다.");
        }
      } else if (snapshotBytes !== page.snapshotBytes) {
        throw new StorageError(
          `기존 세션 ${session.sourceSessionId} transcript가 가져오기 중 변경되었습니다.`,
        );
      }
      records += page.records.length;
      total.records += page.records.length;
      if (
        records > MAX_SOURCE_TRANSCRIPT_RECORDS ||
        total.records > MAX_TOTAL_TRANSCRIPT_RECORDS
      ) {
        throw new StorageError("기존 transcript record 수 상한을 초과했습니다.");
      }
      warnings += page.warnings.length + page.omittedWarnings;
      omitted += page.warnings.length + page.omittedWarnings;
      for (const item of page.records) {
        const converted = transcriptRequest(
          source,
          session,
          item.value,
          item.lineNumber,
        );
        if (converted.warning) warnings += 1;
        if (!converted.request) {
          omitted += 1;
          continue;
        }
        await writer.append(converted.request);
        imported += 1;
      }
      const next = page.nextCursor;
      if (next === undefined) break;
      if (seenCursors.has(next)) {
        throw new StorageError(`기존 세션 ${session.sourceSessionId} transcript cursor가 반복되었습니다.`);
      }
      seenCursors.add(next);
      cursor = next;
    }
    return Object.freeze({ imported, warnings, omitted });
  }
}

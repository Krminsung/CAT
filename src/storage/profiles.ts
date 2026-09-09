import { ConfigurationError, MissingCredentialError } from "../core/errors.js";
import type { JsonObject, JsonValue } from "../core/json.js";
import type { ProviderProtocol } from "../core/provider.js";
import {
  normalizeApiPath,
  normalizeProviderBaseUrl,
} from "../security/endpoints.js";
import {
  validateSecretReference,
  type SecretReference,
} from "./credentials.js";
import { readJsonObject, writeJsonObjectAtomic } from "./json-file.js";

const PROFILE_SCHEMA_VERSION = 1;
const MAX_PROFILE_BYTES = 256 * 1024;
const MAX_PROFILES = 64;
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export const PROVIDER_IDS = [
  "internal",
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "xai",
  "groq",
  "deepseek",
  "mistral",
  "together",
  "cerebras",
  "fireworks",
  "custom",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];
export type EndpointSource = "provider_default" | "user";

export interface ProviderProfile {
  name: string;
  provider: ProviderId;
  protocol: ProviderProtocol;
  baseUrl: string;
  origin: string;
  modelsPath: string;
  generationPath: string;
  model?: string;
  secretRef: SecretReference;
  endpointSource: EndpointSource;
  insecureHttp: boolean;
}

export interface ProviderProfiles {
  activeProfile?: string;
  profiles: ReadonlyMap<string, ProviderProfile>;
}

export interface ProviderProfileInput {
  name: string;
  provider: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  modelsPath: string;
  generationPath: string;
  model?: string;
  secretRef: SecretReference;
  endpointSource: EndpointSource;
  allowInsecureHttp?: boolean;
}

function object(value: JsonValue | undefined, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError(`${label}은 객체여야 합니다.`);
  }
  return value;
}

function text(value: JsonValue | undefined, label: string, maximum = 2_048): string {
  if (typeof value !== "string" || !value.trim() || [...value].length > maximum) {
    throw new ConfigurationError(`${label} 형식이 올바르지 않습니다.`);
  }
  return value.trim();
}

function boolean(value: JsonValue | undefined, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new ConfigurationError(`${label}은 boolean이어야 합니다.`);
  }
  return value;
}

function protocol(value: JsonValue | undefined, label: string): ProviderProtocol {
  const selected = text(value, label, 32);
  if (selected !== "openai-responses" && selected !== "openai-chat") {
    throw new ConfigurationError(`${label}이 올바르지 않습니다.`);
  }
  return selected;
}

function endpointSource(value: JsonValue | undefined, label: string): EndpointSource {
  const selected = text(value, label, 32);
  if (selected !== "provider_default" && selected !== "user") {
    throw new ConfigurationError(`${label}가 올바르지 않습니다.`);
  }
  return selected;
}

export function normalizeProfileName(value: string): string {
  const selected = value.trim().toLowerCase();
  if (!PROFILE_PATTERN.test(selected)) {
    throw new ConfigurationError(
      "Profile 이름은 소문자 영문·숫자로 시작하는 64자 이내 식별자여야 합니다.",
    );
  }
  return selected;
}

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export function createProviderProfile(input: ProviderProfileInput): ProviderProfile {
  const name = normalizeProfileName(input.name);
  const providerValue = input.provider.trim().toLowerCase();
  if (!isProviderId(providerValue)) {
    throw new ConfigurationError(`지원하지 않는 provider입니다: ${providerValue}`);
  }
  if (input.endpointSource !== "provider_default" && input.endpointSource !== "user") {
    throw new ConfigurationError("Endpoint source가 올바르지 않습니다.");
  }
  if (providerValue === "custom" && input.endpointSource !== "user") {
    throw new ConfigurationError("Custom provider endpoint는 사용자가 명시해야 합니다.");
  }
  if (input.protocol !== "openai-responses" && input.protocol !== "openai-chat") {
    throw new ConfigurationError("Provider protocol이 올바르지 않습니다.");
  }
  const endpoint = normalizeProviderBaseUrl(
    input.baseUrl,
    "Provider base URL",
    input.allowInsecureHttp === true,
  );
  if (input.endpointSource === "provider_default" && endpoint.insecureHttp) {
    throw new ConfigurationError("기본 provider endpoint에는 HTTP를 사용할 수 없습니다.");
  }
  const secretRef = validateSecretReference(input.secretRef);
  if (secretRef.origin !== endpoint.origin) {
    throw new MissingCredentialError(
      "API key reference가 provider endpoint origin과 일치하지 않습니다.",
    );
  }
  const model = input.model?.trim();
  if (model && (/\p{Cc}/u.test(model) || [...model].length > 256)) {
    throw new ConfigurationError("Model ID에는 제어 문자를 포함할 수 없고 256자 이하여야 합니다.");
  }
  return {
    name,
    provider: providerValue,
    protocol: input.protocol,
    baseUrl: endpoint.baseUrl,
    origin: endpoint.origin,
    modelsPath: normalizeApiPath(input.modelsPath, "Model 목록 경로"),
    generationPath: normalizeApiPath(input.generationPath, "Generation 경로"),
    ...(model ? { model } : {}),
    secretRef,
    endpointSource: input.endpointSource,
    insecureHttp: endpoint.insecureHttp,
  };
}

function parseProfile(name: string, value: JsonValue): ProviderProfile {
  const raw = object(value, `Profile ${name}`);
  const secret = object(raw.secretRef, `Profile ${name} secretRef`);
  if (secret.kind !== "api_key") {
    throw new ConfigurationError(`Profile ${name} secretRef kind가 올바르지 않습니다.`);
  }
  if (raw.model !== undefined && typeof raw.model !== "string") {
    throw new ConfigurationError(`Profile ${name} model은 문자열이어야 합니다.`);
  }
  return createProviderProfile({
    name,
    provider: text(raw.provider, `Profile ${name} provider`, 64),
    protocol: protocol(raw.protocol, `Profile ${name} protocol`),
    baseUrl: text(raw.baseUrl, `Profile ${name} baseUrl`),
    modelsPath: text(raw.modelsPath, `Profile ${name} modelsPath`, 1_024),
    generationPath: text(raw.generationPath, `Profile ${name} generationPath`, 1_024),
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    secretRef: {
      kind: "api_key",
      id: text(secret.id, `Profile ${name} secretRef id`, 64),
      origin: text(secret.origin, `Profile ${name} secretRef origin`),
    },
    endpointSource: endpointSource(
      raw.endpointSource,
      `Profile ${name} endpointSource`,
    ),
    allowInsecureHttp: boolean(raw.insecureHttp, `Profile ${name} insecureHttp`),
  });
}

function profileToJson(profile: ProviderProfile): JsonObject {
  return {
    provider: profile.provider,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    modelsPath: profile.modelsPath,
    generationPath: profile.generationPath,
    ...(profile.model ? { model: profile.model } : {}),
    secretRef: {
      kind: "api_key",
      id: profile.secretRef.id,
      origin: profile.secretRef.origin,
    },
    endpointSource: profile.endpointSource,
    insecureHttp: profile.insecureHttp,
  };
}

export class ProviderProfileStore {
  constructor(readonly path: string) {}

  async load(): Promise<ProviderProfiles> {
    const document = await readJsonObject(this.path, {
      label: "Provider profile 저장소",
      maxBytes: MAX_PROFILE_BYTES,
      maxDepth: 12,
      maxNodes: 4_096,
      requireOwner: true,
      requirePrivateMode: true,
    });
    if (!document) return { profiles: new Map() };
    if (document.schemaVersion !== PROFILE_SCHEMA_VERSION) {
      throw new ConfigurationError(
        `Provider profile schemaVersion은 ${PROFILE_SCHEMA_VERSION}이어야 합니다.`,
      );
    }
    const rawProfiles = object(document.profiles, "Provider profiles");
    const entries = Object.entries(rawProfiles);
    if (entries.length > MAX_PROFILES) {
      throw new ConfigurationError("Provider profile 수가 너무 많습니다.");
    }
    const profiles = new Map<string, ProviderProfile>();
    for (const [name, value] of entries) {
      const normalizedName = normalizeProfileName(name);
      if (normalizedName !== name) {
        throw new ConfigurationError(`Provider profile 이름이 정규화되어 있지 않습니다: ${name}`);
      }
      profiles.set(name, parseProfile(name, value));
    }
    const activeValue = document.activeProfile;
    if (activeValue !== undefined && typeof activeValue !== "string") {
      throw new ConfigurationError("activeProfile은 문자열이어야 합니다.");
    }
    const activeProfile = typeof activeValue === "string" ? normalizeProfileName(activeValue) : undefined;
    if (activeProfile && !profiles.has(activeProfile)) {
      throw new ConfigurationError("activeProfile이 존재하지 않는 profile을 가리킵니다.");
    }
    return {
      profiles,
      ...(activeProfile ? { activeProfile } : {}),
    };
  }

  async #write(collection: ProviderProfiles): Promise<void> {
    const profiles: JsonObject = {};
    for (const [name, profile] of collection.profiles) {
      profiles[name] = profileToJson(profile);
    }
    await writeJsonObjectAtomic(
      this.path,
      {
        schemaVersion: PROFILE_SCHEMA_VERSION,
        ...(collection.activeProfile ? { activeProfile: collection.activeProfile } : {}),
        profiles,
      },
      {
        label: "Provider profile 저장소",
        maxBytes: MAX_PROFILE_BYTES,
        directoryMode: 0o700,
        fileMode: 0o600,
        requireOwner: true,
      },
    );
  }

  async save(profile: ProviderProfile, activate = true): Promise<ProviderProfile> {
    const normalized = createProviderProfile({
      ...profile,
      allowInsecureHttp: profile.insecureHttp,
    });
    const current = await this.load();
    const profiles = new Map(current.profiles);
    if (!profiles.has(normalized.name) && profiles.size >= MAX_PROFILES) {
      throw new ConfigurationError("저장 가능한 provider profile 수를 초과했습니다.");
    }
    profiles.set(normalized.name, normalized);
    await this.#write({
      profiles,
      ...(activate || !current.activeProfile
        ? { activeProfile: normalized.name }
        : { activeProfile: current.activeProfile }),
    });
    return normalized;
  }

  async setActive(name: string): Promise<ProviderProfile> {
    const selected = normalizeProfileName(name);
    const current = await this.load();
    const profile = current.profiles.get(selected);
    if (!profile) throw new ConfigurationError(`Provider profile을 찾을 수 없습니다: ${selected}`);
    await this.#write({ profiles: current.profiles, activeProfile: selected });
    return profile;
  }

  async remove(name: string): Promise<ProviderProfile | undefined> {
    const selected = normalizeProfileName(name);
    const current = await this.load();
    const removed = current.profiles.get(selected);
    if (!removed) return undefined;
    const profiles = new Map(current.profiles);
    profiles.delete(selected);
    const fallback = [...profiles.keys()].sort()[0];
    await this.#write({
      profiles,
      ...(fallback ? { activeProfile: fallback } : {}),
    });
    return removed;
  }
}

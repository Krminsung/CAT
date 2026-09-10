import { randomUUID } from "node:crypto";
import { ConfigurationError, MissingCredentialError } from "../core/errors.js";
import type { JsonObject, JsonValue } from "../core/json.js";
import { normalizeProviderBaseUrl } from "../security/endpoints.js";
import { Redactor } from "../security/redaction.js";
import { readJsonObject, writeJsonObjectAtomic } from "./json-file.js";

const CREDENTIAL_SCHEMA_VERSION = 1;
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const MAX_CREDENTIALS = 64;
const REDACTION_MARKER = "[REDACTED]";
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const REFERENCE_PATTERN = /^cred_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface SecretReference {
  kind: "api_key";
  id: string;
  origin: string;
}

export interface CredentialMetadata {
  reference: SecretReference;
  provider: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredCredential extends CredentialMetadata {
  apiKey: string;
}

function object(value: JsonValue | undefined, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError(`${label}은 객체여야 합니다.`);
  }
  return value;
}

function text(value: JsonValue | undefined, label: string, maximum = 4_096): string {
  if (typeof value !== "string" || !value || [...value].length > maximum) {
    throw new ConfigurationError(`${label} 형식이 올바르지 않습니다.`);
  }
  return value;
}

function normalizeOrigin(value: string, label: string): string {
  const endpoint = normalizeProviderBaseUrl(value, label, true);
  if (endpoint.baseUrl !== endpoint.origin) {
    throw new ConfigurationError(`${label}에는 origin만 사용할 수 있습니다.`);
  }
  return endpoint.origin;
}

function normalizeProvider(value: string): string {
  const provider = value.trim().toLowerCase();
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new ConfigurationError("Credential provider 형식이 올바르지 않습니다.");
  }
  return provider;
}

export function validateApiKey(value: string): string {
  const selected = value.trim();
  const bytes = Buffer.byteLength(selected, "utf8");
  if (
    bytes < 8 ||
    /[\u0000-\u001f\u007f]/u.test(selected) ||
    REDACTION_MARKER.includes(selected)
  ) {
    throw new ConfigurationError(
      "API key는 제어 문자가 없는, 안전하게 가릴 수 있는 8 bytes 이상의 값이어야 합니다.",
    );
  }
  if (bytes > 8 * 1024) {
    throw new ConfigurationError("API key는 8192 bytes를 초과할 수 없습니다.");
  }
  return selected;
}

export function validateSecretReference(reference: SecretReference): SecretReference {
  if (reference.kind !== "api_key" || !REFERENCE_PATTERN.test(reference.id)) {
    throw new ConfigurationError("Credential reference 형식이 올바르지 않습니다.");
  }
  return {
    kind: "api_key",
    id: reference.id,
    origin: normalizeOrigin(reference.origin, "Credential origin"),
  };
}

function metadataOf(record: StoredCredential): CredentialMetadata {
  return {
    reference: { ...record.reference },
    provider: record.provider,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export class CredentialStore {
  constructor(
    readonly path: string,
    readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async #read(): Promise<Map<string, StoredCredential>> {
    const document = await readJsonObject(this.path, {
      label: "API key 저장소",
      maxBytes: MAX_CREDENTIAL_BYTES,
      maxDepth: 8,
      maxNodes: 1_024,
      requireOwner: true,
      requirePrivateMode: true,
    });
    if (!document) return new Map();
    if (document.schemaVersion !== CREDENTIAL_SCHEMA_VERSION) {
      throw new ConfigurationError(
        `API key 저장소 schemaVersion은 ${CREDENTIAL_SCHEMA_VERSION}이어야 합니다.`,
      );
    }
    const credentials = object(document.credentials, "API key 저장소 credentials");
    const entries = Object.entries(credentials);
    if (entries.length > MAX_CREDENTIALS) {
      throw new ConfigurationError("API key 저장소의 credential 수가 너무 많습니다.");
    }
    const result = new Map<string, StoredCredential>();
    for (const [id, rawValue] of entries) {
      if (!REFERENCE_PATTERN.test(id)) {
        throw new ConfigurationError("API key 저장소에 잘못된 reference가 있습니다.");
      }
      const raw = object(rawValue, `Credential ${id}`);
      const provider = normalizeProvider(
        text(raw.provider, `Credential ${id} provider`, 64),
      );
      const origin = normalizeOrigin(
        text(raw.origin, `Credential ${id} origin`, 2_048),
        `Credential ${id} origin`,
      );
      result.set(id, {
        reference: { kind: "api_key", id, origin },
        provider,
        apiKey: validateApiKey(text(raw.apiKey, `Credential ${id} API key`)),
        createdAt: text(raw.createdAt, `Credential ${id} createdAt`, 64),
        updatedAt: text(raw.updatedAt, `Credential ${id} updatedAt`, 64),
      });
    }
    return result;
  }

  async #write(records: ReadonlyMap<string, StoredCredential>): Promise<void> {
    const credentials: JsonObject = {};
    for (const [id, record] of records) {
      credentials[id] = {
        provider: record.provider,
        origin: record.reference.origin,
        apiKey: record.apiKey,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    }
    await writeJsonObjectAtomic(
      this.path,
      {
        schemaVersion: CREDENTIAL_SCHEMA_VERSION,
        credentials,
      },
      {
        label: "API key 저장소",
        maxBytes: MAX_CREDENTIAL_BYTES,
        directoryMode: 0o700,
        fileMode: 0o600,
        requireOwner: true,
      },
    );
  }

  async save(input: {
    provider: string;
    origin: string;
    apiKey: string;
  }): Promise<CredentialMetadata> {
    const provider = normalizeProvider(input.provider);
    const origin = normalizeOrigin(input.origin, "Credential origin");
    const apiKey = validateApiKey(input.apiKey);
    const records = await this.#read();
    if (records.size >= MAX_CREDENTIALS) {
      throw new ConfigurationError("저장 가능한 credential 수를 초과했습니다.");
    }
    const id = `cred_${randomUUID()}`;
    const timestamp = this.now();
    const record: StoredCredential = {
      reference: { kind: "api_key", id, origin },
      provider,
      apiKey,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    records.set(id, record);
    await this.#write(records);
    return metadataOf(record);
  }

  async list(): Promise<CredentialMetadata[]> {
    return [...(await this.#read()).values()].map(metadataOf);
  }

  async has(reference: SecretReference, expectedProvider: string): Promise<boolean> {
    const selected = validateSecretReference(reference);
    const provider = normalizeProvider(expectedProvider);
    const record = (await this.#read()).get(selected.id);
    return record?.reference.origin === selected.origin &&
      record.provider === provider;
  }

  async withApiKey<T>(
    reference: SecretReference,
    expected: { origin: string; provider: string },
    use: (apiKey: string) => Promise<T>,
  ): Promise<T> {
    const selected = validateSecretReference(reference);
    const origin = normalizeOrigin(expected.origin, "요청 endpoint origin");
    const provider = normalizeProvider(expected.provider);
    if (selected.origin !== origin) {
      throw new MissingCredentialError("API key가 요청 endpoint origin과 일치하지 않습니다.");
    }
    const record = (await this.#read()).get(selected.id);
    if (
      !record ||
      record.reference.origin !== origin ||
      record.provider !== provider
    ) {
      throw new MissingCredentialError("저장된 API key reference를 찾을 수 없습니다.");
    }
    return await use(record.apiKey);
  }

  async remove(reference: SecretReference): Promise<boolean> {
    const selected = validateSecretReference(reference);
    const records = await this.#read();
    const record = records.get(selected.id);
    if (!record || record.reference.origin !== selected.origin) return false;
    records.delete(selected.id);
    await this.#write(records);
    return true;
  }

  async withRedactionSecrets<T>(
    use: (secrets: readonly string[]) => Promise<T>,
  ): Promise<T> {
    const secrets = Object.freeze(
      [...(await this.#read()).values()].map((record) => record.apiKey),
    );
    return await use(secrets);
  }

  async redactor(): Promise<Redactor> {
    return await this.withRedactionSecrets(async (secrets) => new Redactor(secrets));
  }
}

import {
  ConfigurationError,
  MissingCredentialError,
  StorageError,
} from "../core/errors.js";
import { normalizeProviderBaseUrl } from "../security/endpoints.js";
import { Redactor } from "../security/redaction.js";
import {
  CredentialStore,
  validateApiKey,
  type SecretReference,
} from "../storage/credentials.js";
import {
  ProviderProfileStore,
  createProviderProfile,
  normalizeProfileName,
  type EndpointSource,
  type ProviderProfile,
} from "../storage/profiles.js";
import type { ProviderProtocol } from "../core/provider.js";

export interface ApiKeyAccess {
  readonly origin: string;
  readonly source: "environment" | "stored";
  withValue<T>(use: (apiKey: string) => Promise<T>): Promise<T>;
  redactor(): Promise<Redactor>;
}

export interface ResolvedProviderAuth {
  profile: ProviderProfile;
  credential: ApiKeyAccess;
}

export interface AuthStatus {
  profile: ProviderProfile;
  active: boolean;
  credentialAvailable: boolean;
}

export interface ConfigureProfileInput {
  name: string;
  provider: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  modelsPath: string;
  generationPath: string;
  model?: string;
  apiKey: string;
  endpointSource: EndpointSource;
  allowInsecureHttp?: boolean;
  activate?: boolean;
}

class EnvironmentApiKeyAccess implements ApiKeyAccess {
  readonly source = "environment" as const;
  readonly #apiKey: string;

  constructor(readonly origin: string, apiKey: string) {
    this.#apiKey = validateApiKey(apiKey);
  }

  async withValue<T>(use: (apiKey: string) => Promise<T>): Promise<T> {
    return await use(this.#apiKey);
  }

  async redactor(): Promise<Redactor> {
    return new Redactor([this.#apiKey]);
  }
}

class StoredApiKeyAccess implements ApiKeyAccess {
  readonly source = "stored" as const;
  readonly #reference: SecretReference;
  readonly #store: CredentialStore;

  constructor(
    readonly origin: string,
    reference: SecretReference,
    store: CredentialStore,
  ) {
    this.#reference = reference;
    this.#store = store;
  }

  async withValue<T>(use: (apiKey: string) => Promise<T>): Promise<T> {
    return await this.#store.withApiKey(this.#reference, this.origin, use);
  }

  async redactor(): Promise<Redactor> {
    return await this.#store.redactor();
  }
}

function environmentApiKey(
  environment: NodeJS.ProcessEnv,
  provider: string,
): string | undefined {
  const current = environment.CAT_API_KEY?.trim();
  if (current) return validateApiKey(current);

  if (provider !== "internal") return undefined;
  const smileCode = environment.SMILECODE_API_KEY?.trim();
  const smileServ = environment.SMILESERV_API_KEY?.trim();
  if (smileCode && smileServ && smileCode !== smileServ) {
    throw new ConfigurationError(
      "SMILECODE_API_KEY와 SMILESERV_API_KEY 값이 충돌합니다. CAT_API_KEY를 명시하세요.",
    );
  }
  const legacy = smileCode || smileServ;
  return legacy ? validateApiKey(legacy) : undefined;
}

export class AuthService {
  constructor(
    readonly credentials: CredentialStore,
    readonly profiles: ProviderProfileStore,
  ) {}

  async configure(input: ConfigureProfileInput): Promise<ProviderProfile> {
    const profileName = normalizeProfileName(input.name);
    const before = await this.profiles.load();
    const replaced = before.profiles.get(profileName);
    const endpoint = normalizeProviderBaseUrl(
      input.baseUrl,
      "Provider base URL",
      input.allowInsecureHttp === true,
    );
    const credential = await this.credentials.save({
      provider: input.provider,
      origin: endpoint.origin,
      apiKey: input.apiKey,
    });
    let profileSaved = false;
    try {
      const profile = createProviderProfile({
        name: profileName,
        provider: input.provider,
        protocol: input.protocol,
        baseUrl: endpoint.baseUrl,
        modelsPath: input.modelsPath,
        generationPath: input.generationPath,
        ...(input.model ? { model: input.model } : {}),
        secretRef: credential.reference,
        endpointSource: input.endpointSource,
        ...(input.allowInsecureHttp !== undefined
          ? { allowInsecureHttp: input.allowInsecureHttp }
          : {}),
      });
      const saved = await this.profiles.save(profile, input.activate !== false);
      profileSaved = true;
      if (
        replaced &&
        (replaced.secretRef.id !== saved.secretRef.id ||
          replaced.secretRef.origin !== saved.secretRef.origin)
      ) {
        const after = await this.profiles.load();
        const oldReferenceStillUsed = [...after.profiles.values()].some(
          (item) =>
            item.secretRef.id === replaced.secretRef.id &&
            item.secretRef.origin === replaced.secretRef.origin,
        );
        if (!oldReferenceStillUsed) {
          try {
            await this.credentials.remove(replaced.secretRef);
          } catch (error) {
            throw new StorageError(
              "Profile은 갱신했지만 이전 credential 정리를 완료하지 못했습니다.",
              { cause: error },
            );
          }
        }
      }
      return saved;
    } catch (error) {
      if (profileSaved) throw error;
      try {
        await this.credentials.remove(credential.reference);
      } catch (rollbackError) {
        throw new StorageError(
          "Provider profile 저장이 실패했고 새 credential 정리도 완료하지 못했습니다.",
          { cause: new AggregateError([error, rollbackError]) },
        );
      }
      throw error;
    }
  }

  async status(): Promise<AuthStatus[]> {
    const collection = await this.profiles.load();
    const available = new Set(
      (await this.credentials.list()).map(
        (item) => `${item.reference.id}\0${item.reference.origin}`,
      ),
    );
    const result: AuthStatus[] = [];
    for (const profile of collection.profiles.values()) {
      result.push({
        profile,
        active: collection.activeProfile === profile.name,
        credentialAvailable: available.has(
          `${profile.secretRef.id}\0${profile.secretRef.origin}`,
        ),
      });
    }
    return result.sort((left, right) => left.profile.name.localeCompare(right.profile.name));
  }

  async use(name: string): Promise<ProviderProfile> {
    return await this.profiles.setActive(name);
  }

  async remove(name: string): Promise<boolean> {
    const removed = await this.profiles.remove(name);
    if (!removed) return false;
    try {
      const remaining = await this.profiles.load();
      const shared = [...remaining.profiles.values()].some(
        (profile) =>
          profile.secretRef.id === removed.secretRef.id &&
          profile.secretRef.origin === removed.secretRef.origin,
      );
      if (!shared) await this.credentials.remove(removed.secretRef);
    } catch (error) {
      throw new StorageError(
        "Profile은 제거했지만 연결된 credential 정리를 완료하지 못했습니다.",
        { cause: error },
      );
    }
    return true;
  }

  async resolve(options: {
    profile?: string;
    provider?: string;
    environment?: NodeJS.ProcessEnv;
  } = {}): Promise<ResolvedProviderAuth> {
    const collection = await this.profiles.load();
    let profile: ProviderProfile | undefined;
    if (options.profile) {
      profile = collection.profiles.get(normalizeProfileName(options.profile));
    } else if (options.provider) {
      const provider = options.provider.trim().toLowerCase();
      const active = collection.activeProfile
        ? collection.profiles.get(collection.activeProfile)
        : undefined;
      profile = active?.provider === provider
        ? active
        : [...collection.profiles.values()]
            .filter((item) => item.provider === provider)
            .sort((left, right) => left.name.localeCompare(right.name))[0];
    } else if (collection.activeProfile) {
      profile = collection.profiles.get(collection.activeProfile);
    }
    if (!profile) throw new MissingCredentialError("요청한 provider profile을 찾을 수 없습니다.");
    if (
      options.provider &&
      profile.provider !== options.provider.trim().toLowerCase()
    ) {
      throw new ConfigurationError("요청한 profile과 provider가 일치하지 않습니다.");
    }

    const environment = options.environment ?? process.env;
    const environmentKey = environmentApiKey(environment, profile.provider);
    if (environmentKey) {
      return {
        profile,
        credential: new EnvironmentApiKeyAccess(profile.origin, environmentKey),
      };
    }
    if (!(await this.credentials.has(profile.secretRef))) {
      throw new MissingCredentialError("Provider profile에 연결된 API key가 없습니다.");
    }
    return {
      profile,
      credential: new StoredApiKeyAccess(
        profile.origin,
        profile.secretRef,
        this.credentials,
      ),
    };
  }
}

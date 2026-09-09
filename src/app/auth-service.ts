import {
  ConfigurationError,
  MissingCredentialError,
  StorageError,
} from "../core/errors.js";
import type { ProviderProtocol } from "../core/provider.js";
import { providerEnvironmentKeys } from "../providers/catalog.js";
import type { ProviderCredentialAccess } from "../providers/credential-access.js";
import { normalizeProviderBaseUrl } from "../security/endpoints.js";
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

export type ApiKeyAccess = ProviderCredentialAccess;

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

class EnvironmentApiKeyAccess implements ProviderCredentialAccess {
  readonly source = "environment" as const;
  readonly #apiKey: string;

  constructor(
    readonly provider: string,
    readonly origin: string,
    apiKey: string,
  ) {
    this.#apiKey = validateApiKey(apiKey);
  }

  async withValue<T>(use: (apiKey: string) => Promise<T>): Promise<T> {
    return await use(this.#apiKey);
  }

}

class StoredApiKeyAccess implements ProviderCredentialAccess {
  readonly source = "stored" as const;
  readonly #reference: SecretReference;
  readonly #store: CredentialStore;

  constructor(
    readonly provider: string,
    readonly origin: string,
    reference: SecretReference,
    store: CredentialStore,
  ) {
    this.#reference = reference;
    this.#store = store;
  }

  async withValue<T>(use: (apiKey: string) => Promise<T>): Promise<T> {
    return await this.#store.withApiKey(
      this.#reference,
      { origin: this.origin, provider: this.provider },
      use,
    );
  }

}

function environmentApiKey(
  environment: NodeJS.ProcessEnv,
  provider: string,
): string | undefined {
  const current = environment.CAT_API_KEY?.trim();
  if (current) return validateApiKey(current);

  const names = providerEnvironmentKeys(provider);
  const configured = names.flatMap((name) => {
    const value = environment[name]?.trim();
    return value ? [{ name, value: validateApiKey(value) }] : [];
  });
  const distinctValues = new Set(configured.map((entry) => entry.value));
  if (distinctValues.size > 1) {
    throw new ConfigurationError(
      `${configured.map((entry) => entry.name).join(", ")} 값이 충돌합니다. CAT_API_KEY를 명시하세요.`,
    );
  }
  return configured[0]?.value;
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
        (item) => `${item.provider}\0${item.reference.id}\0${item.reference.origin}`,
      ),
    );
    const result: AuthStatus[] = [];
    for (const profile of collection.profiles.values()) {
      result.push({
        profile,
        active: collection.activeProfile === profile.name,
        credentialAvailable: available.has(
          `${profile.provider}\0${profile.secretRef.id}\0${profile.secretRef.origin}`,
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
        credential: new EnvironmentApiKeyAccess(
          profile.provider,
          profile.origin,
          environmentKey,
        ),
      };
    }
    if (!(await this.credentials.has(profile.secretRef, profile.provider))) {
      throw new MissingCredentialError("Provider profile에 연결된 API key가 없습니다.");
    }
    return {
      profile,
      credential: new StoredApiKeyAccess(
        profile.provider,
        profile.origin,
        profile.secretRef,
        this.credentials,
      ),
    };
  }
}

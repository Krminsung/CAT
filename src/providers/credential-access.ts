export interface ProviderCredentialAccess {
  readonly provider: string;
  readonly origin: string;
  readonly source: "environment" | "stored";
  withValue<T>(use: (apiKey: string) => Promise<T>): Promise<T>;
}

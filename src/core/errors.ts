export type CatErrorCode =
  | "cancelled"
  | "budget_exhausted"
  | "invalid_configuration"
  | "missing_credential"
  | "permission_denied"
  | "provider_failure"
  | "protocol_failure"
  | "tool_failure"
  | "storage_failure";

export class CatError extends Error {
  override name = "CatError";

  constructor(
    readonly code: CatErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class CancelledError extends CatError {
  override name = "CancelledError";

  constructor(message = "The operation was cancelled", options?: ErrorOptions) {
    super("cancelled", message, options);
  }
}

export class BudgetExhaustedError extends CatError {
  override name = "BudgetExhaustedError";

  constructor(message = "The run budget was exhausted", options?: ErrorOptions) {
    super("budget_exhausted", message, options);
  }
}

export class PermissionDeniedError extends CatError {
  override name = "PermissionDeniedError";

  constructor(message: string, options?: ErrorOptions) {
    super("permission_denied", message, options);
  }
}

export class ProviderError extends CatError {
  override name = "ProviderError";

  constructor(message: string, options?: ErrorOptions) {
    super("provider_failure", message, options);
  }
}

export class ProtocolError extends CatError {
  override name = "ProtocolError";

  constructor(message: string, options?: ErrorOptions) {
    super("protocol_failure", message, options);
  }
}

export class ConfigurationError extends CatError {
  override name = "ConfigurationError";

  constructor(message: string, options?: ErrorOptions) {
    super("invalid_configuration", message, options);
  }
}

export class StorageError extends CatError {
  override name = "StorageError";

  constructor(message: string, options?: ErrorOptions) {
    super("storage_failure", message, options);
  }
}

export class MissingCredentialError extends CatError {
  override name = "MissingCredentialError";

  constructor(message = "사용 가능한 API key가 없습니다.", options?: ErrorOptions) {
    super("missing_credential", message, options);
  }
}

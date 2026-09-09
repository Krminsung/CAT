import {
  BudgetExhaustedError,
  CatError,
  ConfigurationError,
  ContextWindowError,
  MissingCredentialError,
  PermissionDeniedError,
  ProviderError,
  ProtocolError,
  StorageError,
} from "../core/errors.js";
import type { JsonObject } from "../core/json.js";
import type { ProviderCapabilities } from "../core/provider.js";
import type { Redactor } from "../security/redaction.js";
import {
  readResponsePrefix,
  type ModelHttpResponse,
} from "../transport/model-http.js";
import { protocolJsonObject, protocolRecord } from "./protocol-json.js";

const MAX_ERROR_BYTES = 20_000;

function exceedsCodePoints(value: string, maximum: number): boolean {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > maximum) return true;
  }
  return false;
}

export function configurationString(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  const selected = typeof value === "string" ? value.trim() : "";
  if (
    (!allowEmpty && !selected) ||
    /\p{Cc}/u.test(selected) ||
    exceedsCodePoints(selected, maximum)
  ) {
    throw new ConfigurationError(`${label} 형식이 올바르지 않습니다.`);
  }
  return selected;
}

export function configurationJsonObject(value: unknown, label: string): JsonObject {
  try {
    return protocolJsonObject(value, label);
  } catch {
    throw new ConfigurationError(`${label}은 유한한 JSON 객체여야 합니다.`);
  }
}

export function validateProviderCapabilities(
  value: unknown,
  label: string,
): ProviderCapabilities {
  const raw = protocolRecord(value);
  if (
    !raw ||
    typeof raw.nativeToolCalls !== "boolean" ||
    typeof raw.strictToolSchemas !== "boolean" ||
    typeof raw.parallelToolCalls !== "boolean" ||
    typeof raw.reasoningParameter !== "boolean" ||
    typeof raw.temperatureParameter !== "boolean" ||
    typeof raw.streamUsage !== "boolean"
  ) {
    throw new ConfigurationError(`${label} capability 설정이 올바르지 않습니다.`);
  }
  return {
    nativeToolCalls: raw.nativeToolCalls,
    strictToolSchemas: raw.strictToolSchemas,
    parallelToolCalls: raw.parallelToolCalls,
    reasoningParameter: raw.reasoningParameter,
    temperatureParameter: raw.temperatureParameter,
    streamUsage: raw.streamUsage,
  };
}

export function providerDiagnostic(value: unknown, depth = 0): string | undefined {
  if (depth > 8) return undefined;
  if (typeof value === "string" && value) return value;
  const raw = protocolRecord(value);
  if (!raw) return undefined;
  if (typeof raw.message === "string" && raw.message) return raw.message;
  if (typeof raw.detail === "string" && raw.detail) return raw.detail;
  if (typeof raw.reason === "string" && raw.reason) return raw.reason;
  return providerDiagnostic(raw.error, depth + 1) ??
    providerDiagnostic(raw.incomplete_details, depth + 1) ??
    providerDiagnostic(raw.cause, depth + 1);
}

export function safeProviderDiagnostic(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�")
    .slice(0, 4_096);
}

export function isContextWindowFailure(value: string): boolean {
  return /(?:contextwindowexceeded|context[_ -]?(?:length|window)[_ -]?exceeded|maximum\s+context\s+length|(?:context|token)\s+(?:window|limit).{0,80}exceed|(?:input|prompt|request|messages?).{0,80}(?:too\s+long|too\s+large)|too\s+many\s+(?:input\s+)?tokens|(?:컨텍스트|문맥|입력\s*토큰).{0,40}(?:한도|길이).{0,20}초과|(?:컨텍스트|문맥).{0,40}초과)/isu.test(value);
}

export async function providerHttpFailure(
  response: ModelHttpResponse,
  providerName: string,
  redactor: Redactor,
): Promise<ProviderError> {
  let detail = "응답 세부 정보가 없습니다.";
  try {
    const bytes = await readResponsePrefix(response, MAX_ERROR_BYTES);
    const text = new TextDecoder("utf-8").decode(bytes);
    if (text) {
      try {
        const parsed = JSON.parse(text) as unknown;
        detail = providerDiagnostic(
          protocolJsonObject(parsed, "모델 오류 응답"),
        ) ?? text;
      } catch {
        detail = text;
      }
    }
  } catch {
    detail = "오류 응답 본문을 읽지 못했습니다.";
  }
  const cleaned = safeProviderDiagnostic(redactor.redact(detail));
  const message = `${providerName} API 오류 (${response.status}): ${cleaned}`;
  return isContextWindowFailure(cleaned)
    ? new ContextWindowError(message)
    : new ProviderError(message);
}

export function sanitizedProviderError(error: unknown, redactor: Redactor): Error {
  const detail = safeProviderDiagnostic(
    redactor.redact(error instanceof Error ? error.message : "알 수 없는 provider 오류"),
  );
  if (error instanceof ContextWindowError) return new ContextWindowError(detail);
  if (error instanceof ProtocolError) return new ProtocolError(detail);
  if (error instanceof ProviderError) return new ProviderError(detail);
  if (error instanceof ConfigurationError) return new ConfigurationError(detail);
  if (error instanceof MissingCredentialError) return new MissingCredentialError(detail);
  if (error instanceof StorageError) return new StorageError(detail);
  if (error instanceof BudgetExhaustedError) return new BudgetExhaustedError(detail);
  if (error instanceof PermissionDeniedError) return new PermissionDeniedError(detail);
  if (error instanceof CatError) return new CatError(error.code, detail);
  return new ProviderError(detail);
}

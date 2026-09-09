import { ConfigurationError } from "../core/errors.js";

export interface NormalizedEndpoint {
  baseUrl: string;
  origin: string;
  insecureHttp: boolean;
}

export function normalizeProviderBaseUrl(
  value: string,
  label: string,
  allowInsecureHttp = false,
): NormalizedEndpoint {
  const selected = value.trim();
  if (
    !selected ||
    /[\u0000-\u001f\u007f]/u.test(selected) ||
    selected.includes("\\") ||
    selected.length > 2_048
  ) {
    throw new ConfigurationError(`${label}이 올바르지 않습니다.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(selected);
  } catch (error) {
    throw new ConfigurationError(`${label}은 올바른 HTTP(S) URL이어야 합니다.`, {
      cause: error,
    });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ConfigurationError(`${label}은 HTTP(S) URL이어야 합니다.`);
  }
  if (parsed.username || parsed.password) {
    throw new ConfigurationError(`${label}에 사용자 정보나 credential을 포함할 수 없습니다.`);
  }
  if (parsed.search || parsed.hash) {
    throw new ConfigurationError(`${label}에 query 또는 fragment를 포함할 수 없습니다.`);
  }
  if (parsed.protocol === "http:" && !allowInsecureHttp) {
    throw new ConfigurationError(
      `${label}에 HTTP를 사용하려면 내부 개발 환경임을 확인하고 명시적으로 허용해야 합니다.`,
    );
  }
  const path = parsed.pathname.replace(/\/+$/u, "");
  const baseUrl = `${parsed.origin}${path === "/" ? "" : path}`;
  return {
    baseUrl,
    origin: parsed.origin,
    insecureHttp: parsed.protocol === "http:",
  };
}

export function normalizeApiPath(value: string, label: string): string {
  const selected = value.trim();
  if (
    !selected.startsWith("/") ||
    selected.startsWith("//") ||
    /[\\\u0000-\u0020\u007f]/u.test(selected) ||
    selected.includes("?") ||
    selected.includes("#") ||
    selected.length > 1_024
  ) {
    throw new ConfigurationError(`${label}은 /로 시작하고 query가 없는 API 경로여야 합니다.`);
  }
  const normalized = selected.replace(/\/+$/u, "");
  return normalized || "/";
}

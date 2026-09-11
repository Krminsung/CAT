import { PermissionDeniedError } from "../core/errors.js";
import { isSensitiveEnvironmentName } from "../security/environment.js";
import { normalizePublicWebUrl } from "./public-http.js";

const MAX_SECRETS = 512;
const MAX_SECRET_BYTES = 8 * 1024;
const MAX_SECRET_TOTAL_BYTES = 512 * 1024;
const MAX_SEARCH_QUERY_CODE_POINTS = 500;
const MAX_PERCENT_DECODE_PASSES = 8;
const REDACTION_MARKER = "[REDACTED]";
const SENSITIVE_QUERY_PARAMETER = /^(?:api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|client[_-]?secret|code|cookie|credential|key|password|passwd|private[_-]?key|refresh[_-]?token|secret|sig|signature|token|x-amz-credential|x-amz-security-token|x-amz-signature)$/iu;

const CONVERSATIONAL_FILLER = /(?<![A-Za-z0-9가-힣])(?:어때(?:요)?|어떤가요|어떻습니까|어떻게\s*돼(?:요)?|알려\s*(?:줘요?|주세요)|설명해\s*(?:줘요?|주세요)|궁금해(?:요)?|좀|혹시|please|tell\s+me|how\s+is|how's|what\s+is|what's)(?![A-Za-z0-9가-힣])/giu;

interface DecodedVariants {
  readonly values: readonly string[];
  readonly fullyDecoded: boolean;
}

function decodePercentRuns(value: string): string {
  return value.replace(/(?:%[0-9A-Fa-f]{2})+/gu, (encoded) =>
    Buffer.from(encoded.replaceAll("%", ""), "hex").toString("utf8")
  );
}

function decodedVariants(value: string): DecodedVariants {
  const values = [value];
  let current = value;
  for (let pass = 0; pass < MAX_PERCENT_DECODE_PASSES; pass += 1) {
    const decoded = decodePercentRuns(current);
    if (decoded === current) return { values, fullyDecoded: true };
    values.push(decoded);
    current = decoded;
  }
  return {
    values,
    fullyDecoded: decodePercentRuns(current) === current,
  };
}

/** Owns the exact secret set used to minimize data sent to unauthenticated public web endpoints. */
export class PublicWebInputGuard {
  #secrets: string[] = [];
  #secretBytes = 0;
  #redactionUnavailable = false;

  constructor(
    secrets: readonly string[] = [],
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.addSecrets([
      ...secrets,
      ...Object.entries(environment).flatMap(([name, value]) =>
        value !== undefined && isSensitiveEnvironmentName(name) ? [value] : []
      ),
    ]);
  }

  addSecrets(values: readonly string[]): void {
    const selected = new Set(this.#secrets);
    for (const value of values) {
      if (!value || selected.has(value)) continue;
      const bytes = Buffer.byteLength(value, "utf8");
      if (
        bytes < 4 ||
        bytes > MAX_SECRET_BYTES ||
        selected.size >= MAX_SECRETS ||
        this.#secretBytes + bytes > MAX_SECRET_TOTAL_BYTES
      ) {
        this.#redactionUnavailable = true;
        continue;
      }
      selected.add(value);
      this.#secretBytes += bytes;
    }
    this.#secrets = [...selected].sort((left, right) => right.length - left.length);
  }

  containsProtectedData(value: string): boolean {
    if (this.#redactionUnavailable) return true;
    const candidates = decodedVariants(value);
    if (!candidates.fullyDecoded) return true;
    return this.#secrets.some((secret) => {
      const protectedValues = decodedVariants(secret);
      return !protectedValues.fullyDecoded ||
        candidates.values.some((candidate) =>
          protectedValues.values.some((protectedValue) =>
            candidate.includes(protectedValue)
          )
        );
    });
  }

  normalizeSearchQuery(raw: string): string {
    if (this.#redactionUnavailable) {
      throw new PermissionDeniedError(
        "알려진 secret 전체를 안전하게 검사할 수 없어 공개 검색을 차단했습니다.",
      );
    }
    let redactedRaw = raw;
    for (const secret of this.#secrets) {
      redactedRaw = redactedRaw.replaceAll(secret, " ");
    }
    const decoded = decodedVariants(redactedRaw);
    if (!decoded.fullyDecoded) {
      throw new PermissionDeniedError(
        "과도하게 중첩 인코딩된 내용이 있어 공개 검색을 차단했습니다.",
      );
    }
    let query = decoded.values.at(-1) ?? redactedRaw;
    for (const secret of this.#secrets) {
      const protectedValues = decodedVariants(secret);
      if (!protectedValues.fullyDecoded) {
        throw new PermissionDeniedError(
          "알려진 secret의 인코딩 형태를 안전하게 검사할 수 없어 공개 검색을 차단했습니다.",
        );
      }
      for (const protectedValue of protectedValues.values) {
        query = query.replaceAll(protectedValue, " ");
      }
    }
    query = query
      .replace(/-----BEGIN [A-Z0-9 ]{0,32}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,32}PRIVATE KEY-----|$)/gu, " ")
      .replace(/```[\s\S]*?(?:```|$)|`[^`]*(?:`|$)/gu, " ")
      .replace(/\bBearer\s+[^\s"'<>]+/giu, " ")
      .replace(/(?:api[_ -]?key|access[_ -]?token|auth(?:orization)?|client[_ -]?secret|token|password|passwd|secret|cookie|API\s*키|비밀번호)\s*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, " ")
      .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[opsu]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2})\b/gu, " ")
      .replace(/(?:https?|ssh):\/\/\S+|git@[A-Za-z0-9._-]+:[^\s]+/giu, " ")
      .replace(/(?<![\p{L}\p{N}_])[\p{L}\p{N}_.+-]+@[\p{L}\p{N}_.-]+(?=$|[^\p{L}\p{N}_])/giu, " ")
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[\da-f]{1,4}:){2,7}[\da-f]{0,4}\b/giu, " ")
      .replace(/\b[A-Za-z0-9.-]+\.(?:internal|local|localhost|home\.arpa|onion)\b/giu, " ")
      .replace(/(?<![\p{L}\p{N}_])(?:@[\p{L}\p{N}_./-]+|(?:~\/|\/|[A-Za-z]:\\)[^\s]+)/gu, " ")
      .replaceAll(REDACTION_MARKER, " ")
      .replace(CONVERSATIONAL_FILLER, " ")
      .replace(/[\p{Cc}\p{Cf}]/gu, " ")
      .replace(/\s+/gu, " ")
      .replace(/^[ ?!.]+|[ ?!.]+$/gu, "")
      .trim();
    if (!query) {
      throw new PermissionDeniedError(
        "민감하거나 비공개인 내용을 제거한 뒤 공개 검색어가 남지 않았습니다.",
      );
    }
    if ([...query].length > MAX_SEARCH_QUERY_CODE_POINTS) {
      throw new PermissionDeniedError(
        `공개 검색어는 정리한 뒤 ${MAX_SEARCH_QUERY_CODE_POINTS}자를 초과할 수 없습니다.`,
      );
    }
    return query;
  }

  normalizeFetchUrl(raw: string): URL {
    if (this.#redactionUnavailable) {
      throw new PermissionDeniedError(
        "알려진 secret 전체를 안전하게 검사할 수 없어 공개 URL 요청을 차단했습니다.",
      );
    }
    const url = normalizePublicWebUrl(raw);
    const encodedComponents = [
      url.href,
      url.pathname,
      ...[...url.searchParams.entries()].flatMap(([name, value]) => [name, value]),
    ].map(decodedVariants);
    if (encodedComponents.some((component) => !component.fullyDecoded)) {
      throw new PermissionDeniedError(
        "과도하게 중첩 인코딩된 URL은 공개 웹으로 전송할 수 없습니다.",
      );
    }
    const decodedComponents = encodedComponents.flatMap((component) => component.values);
    for (const secret of this.#secrets) {
      const protectedValues = decodedVariants(secret);
      if (
        !protectedValues.fullyDecoded ||
        decodedComponents.some((component) =>
          protectedValues.values.some((protectedValue) =>
            component.includes(protectedValue)
          )
        )
      ) {
        throw new PermissionDeniedError(
          "알려진 secret이 포함된 URL은 공개 웹으로 전송할 수 없습니다.",
        );
      }
    }
    for (const name of url.searchParams.keys()) {
      const names = decodedVariants(name);
      if (
        !names.fullyDecoded ||
        names.values.some((candidate) => SENSITIVE_QUERY_PARAMETER.test(candidate))
      ) {
        throw new PermissionDeniedError(
          `민감한 query parameter ${name}이 포함된 URL은 공개 웹으로 전송할 수 없습니다.`,
        );
      }
    }
    return url;
  }
}

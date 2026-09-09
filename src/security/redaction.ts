const REDACTED = "[REDACTED]";
const SENSITIVE_HEADER = /^(?:authorization|cookie|set-cookie|proxy-authorization|x-api-key|api-key)$/iu;
const ASSIGNED_SECRET = /\b(?:api[_ -]?key|access[_ -]?token|token|password|passwd|secret|cookie)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const BEARER_SECRET = /\bBearer\s+[^\s"'<>]+/giu;
const COMMON_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[opsu]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2})\b/gu;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]{0,32}PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]{0,32}PRIVATE KEY-----/gu;

export type HeaderValue = string | readonly string[] | undefined;

export class Redactor {
  readonly #secrets: readonly string[];

  constructor(secrets: readonly string[] = []) {
    this.#secrets = [...new Set(secrets.filter(Boolean))].sort(
      (left, right) => right.length - left.length,
    );
  }

  redact(text: string): string {
    let result = text;
    for (const secret of this.#secrets) result = result.replaceAll(secret, REDACTED);
    return result
      .replace(PRIVATE_KEY_BLOCK, REDACTED)
      .replace(BEARER_SECRET, `Bearer ${REDACTED}`)
      .replace(ASSIGNED_SECRET, (match) => {
        const separator = match.search(/[:=]/u);
        return separator < 0 ? REDACTED : `${match.slice(0, separator + 1)} ${REDACTED}`;
      })
      .replace(COMMON_TOKEN, REDACTED);
  }

  redactHeaders(headers: Readonly<Record<string, HeaderValue>>): Record<string, string | string[]> {
    const result = Object.create(null) as Record<string, string | string[]>;
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      if (SENSITIVE_HEADER.test(name)) {
        result[name] = REDACTED;
      } else if (typeof value === "string") {
        result[name] = this.redact(value);
      } else {
        result[name] = value.map((item) => this.redact(item));
      }
    }
    return result;
  }
}

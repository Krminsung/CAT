import {
  normalizePublicWebUrl,
  type PublicWebResponse,
} from "./public-http.js";

const TEXTUAL_APPLICATION_TYPES = new Set([
  "application/atom+xml",
  "application/json",
  "application/ld+json",
  "application/rss+xml",
  "application/xhtml+xml",
  "application/xml",
]);
const HTML_TYPES = new Set(["application/xhtml+xml", "text/html"]);
const BLOCK_TAGS = new Set([
  "article",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);
const SKIPPED_TAGS = new Set(["script", "style", "noscript", "svg", "template"]);
const MAX_LINKS = 40;
const MAX_LINK_BYTES = 2_048;
const MAX_HTML_TOKENS = 65_536;
const MAX_TEXT_PARTS = 32_768;
const MAX_SKIPPED_DEPTH = 128;

export class PublicWebContentError extends Error {
  override name = "PublicWebContentError";

  constructor(
    readonly code: "unsupported_content_type" | "invalid_text_encoding",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface BoundedWebText {
  readonly text: string;
  readonly truncated: boolean;
  readonly omittedBytes: number;
}

export interface DecodedPublicWebDocument {
  readonly text: string;
  readonly mediaType: string;
  readonly charset: string;
  readonly charsetFallback: boolean;
  readonly html: boolean;
}

export interface ParsedHtmlDocument {
  readonly text: string;
  readonly title: string;
  readonly links: readonly string[];
  readonly linksTruncated: boolean;
  readonly truncated: boolean;
}

function contentTypeParts(header: string): { mediaType: string; charset: string } {
  const mediaType = header.split(";", 1)[0]?.trim().toLowerCase() ||
    "application/octet-stream";
  const charset = /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/iu
    .exec(header)?.slice(1).find((value) => value !== undefined)?.trim() || "utf-8";
  return { mediaType, charset };
}

function textualMediaType(mediaType: string): boolean {
  return mediaType.startsWith("text/") ||
    TEXTUAL_APPLICATION_TYPES.has(mediaType) ||
    mediaType.endsWith("+json") ||
    mediaType.endsWith("+xml");
}

/** Remove terminal control sequences and invisible controls from public data before display. */
export function inertWebText(value: string): string {
  return value
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\|$)/gu, " ")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}]/gu, " ")
    .replace(/\r\n?/gu, "\n");
}

export function boundedWebText(
  value: string,
  maximumBytes: number,
  maximumCodePoints = Number.MAX_SAFE_INTEGER,
): BoundedWebText {
  const totalBytes = Buffer.byteLength(value, "utf8");
  if (totalBytes <= maximumBytes && [...value].length <= maximumCodePoints) {
    return { text: value, truncated: false, omittedBytes: 0 };
  }
  const selected: string[] = [];
  let usedBytes = 0;
  let usedCodePoints = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + bytes > maximumBytes || usedCodePoints >= maximumCodePoints) break;
    selected.push(character);
    usedBytes += bytes;
    usedCodePoints += 1;
  }
  return {
    text: selected.join(""),
    truncated: true,
    omittedBytes: Math.max(0, totalBytes - usedBytes),
  };
}

export function decodeHtmlEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: "\u00a0",
    quot: "\"",
  };
  return value.replace(
    /&(?:#(\d{1,8})|#x([\da-f]{1,8})|([a-z][\da-z]{0,31}));?/giu,
    (match, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (decimal !== undefined || hex !== undefined) {
        const code = Number.parseInt(decimal ?? hex ?? "", hex === undefined ? 10 : 16);
        if (
          Number.isFinite(code) &&
          code > 0 &&
          code <= 0x10ffff &&
          !(code >= 0xd800 && code <= 0xdfff)
        ) {
          return String.fromCodePoint(code);
        }
        return "�";
      }
      return named[(name ?? "").toLowerCase()] ?? match;
    },
  );
}

export function decodePublicWebDocument(
  response: PublicWebResponse,
): DecodedPublicWebDocument {
  const { mediaType, charset } = contentTypeParts(response.contentType);
  if (!textualMediaType(mediaType)) {
    throw new PublicWebContentError(
      "unsupported_content_type",
      `텍스트가 아닌 공개 웹 콘텐츠는 열 수 없습니다: ${mediaType}`,
    );
  }
  let text: string;
  let selectedCharset = charset;
  let charsetFallback = false;
  try {
    text = new TextDecoder(charset, { fatal: false }).decode(response.body);
  } catch (error) {
    selectedCharset = "utf-8";
    charsetFallback = true;
    try {
      text = new TextDecoder("utf-8", { fatal: false }).decode(response.body);
    } catch (fallbackError) {
      throw new PublicWebContentError(
        "invalid_text_encoding",
        "공개 웹 응답의 문자 인코딩을 해석하지 못했습니다.",
        { cause: fallbackError ?? error },
      );
    }
  }
  return {
    text: inertWebText(text),
    mediaType,
    charset: selectedCharset,
    charsetFallback,
    html: HTML_TYPES.has(mediaType),
  };
}

export function parseHtmlDocument(html: string, baseUrl: string): ParsedHtmlDocument {
  const parts: string[] = [];
  const titleParts: string[] = [];
  const links: string[] = [];
  let linksTruncated = false;
  let truncated = false;
  let tokenCount = 0;
  const skippedTags: string[] = [];
  let inTitle = false;
  const tokens = html.matchAll(
    /<!--[\s\S]*?(?:-->|$)|<![^>]*(?:>|$)|<\/?[A-Za-z][^>]*(?:>|$)|[^<]+|</gu,
  );
  tokenLoop: for (const match of tokens) {
    tokenCount += 1;
    if (tokenCount > MAX_HTML_TOKENS) {
      truncated = true;
      break;
    }
    const token = match[0];
    if (!token.startsWith("<") || token === "<") {
      if (skippedTags.length === 0) {
        const data = inertWebText(decodeHtmlEntities(token));
        if (parts.length >= MAX_TEXT_PARTS) {
          truncated = true;
          break;
        }
        if (data) parts.push(data);
        if (inTitle) titleParts.push(data);
      }
      continue;
    }
    const closing = /^<\//u.test(token);
    const tag = /^<\/?\s*([A-Za-z0-9]+)/u.exec(token)?.[1]?.toLowerCase();
    if (!tag) continue;
    if (skippedTags.length > 0) {
      if (closing && skippedTags.at(-1) === tag) skippedTags.pop();
      else if (!closing && SKIPPED_TAGS.has(tag) && !/\/\s*>$/u.test(token)) {
        if (skippedTags.length >= MAX_SKIPPED_DEPTH) {
          truncated = true;
          break;
        }
        skippedTags.push(tag);
      }
      continue;
    }
    if (closing) {
      if (BLOCK_TAGS.has(tag)) {
        if (parts.length >= MAX_TEXT_PARTS) {
          truncated = true;
          break;
        }
        parts.push("\n");
      }
      if (tag === "title") inTitle = false;
      continue;
    }
    const selfClosing = /\/\s*>$/u.test(token);
    if (SKIPPED_TAGS.has(tag)) {
      if (!selfClosing) skippedTags.push(tag);
      continue;
    }
    if (BLOCK_TAGS.has(tag)) {
      if (parts.length >= MAX_TEXT_PARTS) {
        truncated = true;
        break tokenLoop;
      }
      parts.push("\n");
    }
    if (tag === "title" && !selfClosing) inTitle = true;
    if (tag !== "a") continue;
    if (links.length >= MAX_LINKS) {
      linksTruncated = true;
      continue;
    }
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/iu.exec(token);
    const raw = inertWebText(decodeHtmlEntities(
      href?.[1] ?? href?.[2] ?? href?.[3] ?? "",
    )).trim();
    if (!raw) continue;
    try {
      const candidate = normalizePublicWebUrl(new URL(raw, baseUrl));
      const selected = candidate.href;
      if (
        Buffer.byteLength(selected, "utf8") <= MAX_LINK_BYTES &&
        !links.includes(selected)
      ) {
        links.push(selected);
      }
    } catch {
      // Malformed document links are data, not a fetch instruction.
    }
  }
  if (skippedTags.length > 0) truncated = true;
  const text = parts.join("")
    .split(/\n/gu)
    .map((line) => line.replace(/[\t\f\v ]+/gu, " ").trim())
    .filter(Boolean)
    .join("\n");
  const title = titleParts.join("").replace(/\s+/gu, " ").trim();
  return {
    text,
    title,
    links: Object.freeze(links),
    linksTruncated,
    truncated,
  };
}

export function looksLikeAccessChallenge(value: string): boolean {
  if (value.length >= 4_000) return false;
  return /complete the following challenge|verify you are human|unusual traffic from your computer|enable javascript and cookies to continue|checking your browser/iu.test(value);
}

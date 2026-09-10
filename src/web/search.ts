import {
  boundedWebText,
  decodeHtmlEntities,
  inertWebText,
  parseHtmlDocument,
} from "./content.js";
import { normalizePublicWebUrl } from "./public-http.js";

const MAX_SEARCH_CANDIDATES = 2_048;

const SEARCH_STOP_WORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "available",
  "be",
  "can",
  "ceo",
  "checkpoint",
  "checkpoints",
  "current",
  "date",
  "do",
  "does",
  "download",
  "downloads",
  "exchange",
  "explain",
  "face",
  "find",
  "for",
  "from",
  "get",
  "github",
  "has",
  "have",
  "how",
  "hugging",
  "huggingface",
  "in",
  "is",
  "it",
  "latest",
  "license",
  "like",
  "look",
  "looking",
  "me",
  "minister",
  "new",
  "news",
  "of",
  "official",
  "on",
  "president",
  "price",
  "pricing",
  "prime",
  "rate",
  "recommend",
  "recent",
  "release",
  "released",
  "search",
  "stock",
  "tell",
  "the",
  "today",
  "version",
  "web",
  "weather",
  "weights",
  "what",
  "when",
  "who",
  "with",
  "you",
  "가중치",
  "검색",
  "검색해",
  "가격",
  "깃허브",
  "날씨",
  "뉴스",
  "다운로드",
  "대해",
  "며칠",
  "몇일",
  "방금",
  "발표",
  "대표이사",
  "대통령",
  "라이선스",
  "무엇",
  "뭐",
  "설명",
  "어떤",
  "언제",
  "얼마",
  "어제",
  "오늘",
  "지금",
  "최근",
  "추천",
  "최신",
  "총리",
  "체크포인트",
  "출시",
  "출시한",
  "찾아봐",
  "찾아줘",
  "현재",
  "환율",
  "허깅페이스",
  "요금",
  "주가",
  "누가",
  "누구",
]);

export interface PublicSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly source: string;
}

function cleanMarkdown(value: string): string {
  return inertWebText(decodeHtmlEntities(value.replace(/[*_`]/gu, " ")))
    .replace(/\s+/gu, " ")
    .trim();
}

function decodeSearchUrl(raw: string, baseUrl: string): string {
  const decoded = inertWebText(decodeHtmlEntities(raw)).trim();
  if (!decoded || Buffer.byteLength(decoded, "utf8") > 8_192) return "";
  try {
    const parsed = new URL(decoded, baseUrl);
    const duck = parsed.searchParams.get("uddg");
    if (duck && /^https?:\/\//iu.test(duck)) return duck;
    const bing = parsed.searchParams.get("u");
    if (bing?.startsWith("a1") && bing.length <= 8_192) {
      const encoded = bing.slice(2).replace(/-/gu, "+").replace(/_/gu, "/");
      const candidate = Buffer.from(
        encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="),
        "base64",
      ).toString("utf8");
      if (/^https?:\/\//iu.test(candidate)) return candidate;
    }
    const hostname = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    const unresolvedDuckRedirect = (
      hostname === "duckduckgo.com" || hostname.endsWith(".duckduckgo.com")
    ) && (path === "/l" || path.startsWith("/l/"));
    const unresolvedBingRedirect = (
      hostname === "bing.com" || hostname.endsWith(".bing.com")
    ) && (
      path === "/aclick" ||
      path === "/search" ||
      path.startsWith("/ck/") ||
      path.endsWith("/glinkping.aspx")
    );
    if (unresolvedDuckRedirect || unresolvedBingRedirect) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function normalizedResult(
  titleValue: string,
  urlValue: string,
  snippetValue: string,
  baseUrl: string,
): PublicSearchResult | undefined {
  const title = boundedWebText(cleanMarkdown(titleValue), 1_024, 300).text;
  const snippet = boundedWebText(cleanMarkdown(snippetValue), 4_096, 1_000).text;
  if (!title) return undefined;
  try {
    const url = normalizePublicWebUrl(decodeSearchUrl(urlValue, baseUrl));
    return {
      title,
      url: url.href,
      snippet,
      source: url.hostname.toLowerCase(),
    };
  } catch {
    return undefined;
  }
}

function pushUnique(
  results: PublicSearchResult[],
  candidate: PublicSearchResult | undefined,
  maximum: number,
): boolean {
  if (!candidate || results.some((result) => result.url === candidate.url)) return false;
  results.push(candidate);
  return results.length >= maximum;
}

function resultLimit(value: number): number {
  return Number.isSafeInteger(value) && value >= 1 && value <= 10 ? value : 0;
}

export function parseBingHtmlResults(
  document: string,
  maximum: number,
): PublicSearchResult[] {
  const results: PublicSearchResult[] = [];
  const limit = resultLimit(maximum);
  if (limit === 0) return results;
  let candidates = 0;
  for (const match of document.matchAll(/<li\s+class="[^"]*\bb_algo\b[^"]*"[\s\S]*?<\/li>/giu)) {
    candidates += 1;
    if (candidates > MAX_SEARCH_CANDIDATES) break;
    const item = match[0];
    const heading = /<h2[^>]*>[\s\S]*?<a[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/iu
      .exec(item);
    if (!heading) continue;
    const title = parseHtmlDocument(heading[3] ?? "", "https://www.bing.com/").text;
    const snippet = parseHtmlDocument(
      /<p[^>]*>([\s\S]*?)<\/p>/iu.exec(item)?.[1] ?? "",
      "https://www.bing.com/",
    ).text;
    if (pushUnique(
      results,
      normalizedResult(title, heading[2] ?? "", snippet, "https://www.bing.com/"),
      limit,
    )) break;
  }
  return results;
}

export function parseBingReaderResults(
  document: string,
  maximum: number,
): PublicSearchResult[] {
  const results: PublicSearchResult[] = [];
  const limit = resultLimit(maximum);
  if (limit === 0) return results;
  const pattern = /^\d+\.\s+##\s+\[(.*?)\]\((https?:\/\/[^\n)]+)\)\s*([\s\S]*?)(?=^\d+\.\s+##\s+\[|$(?![\s\S]))/gmu;
  let candidates = 0;
  for (const match of document.matchAll(pattern)) {
    candidates += 1;
    if (candidates > MAX_SEARCH_CANDIDATES) break;
    const snippet = (match[3] ?? "").split(/\r?\n/gu)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(" ");
    if (pushUnique(
      results,
      normalizedResult(match[1] ?? "", match[2] ?? "", snippet, "https://www.bing.com/"),
      limit,
    )) break;
  }
  return results;
}

export function parseDuckDuckGoReaderResults(
  document: string,
  maximum: number,
): PublicSearchResult[] {
  const results: PublicSearchResult[] = [];
  const limit = resultLimit(maximum);
  if (limit === 0) return results;
  const headings: RegExpMatchArray[] = [];
  for (const heading of document.matchAll(/^##\s+\[(.*?)\]\((https?:\/\/[^\n)]+)\)\s*$/gmu)) {
    if (headings.length >= MAX_SEARCH_CANDIDATES) break;
    headings.push(heading);
  }
  for (const [index, heading] of headings.entries()) {
    const end = headings[index + 1]?.index ?? document.length;
    const body = document.slice((heading.index ?? 0) + heading[0].length, end)
      .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1");
    if (pushUnique(
      results,
      normalizedResult(
        heading[1] ?? "",
        heading[2] ?? "",
        body,
        "https://html.duckduckgo.com/",
      ),
      limit,
    )) break;
  }
  return results;
}

export function searchAnchors(query: string): string[] {
  const latin: string[] = [];
  const korean: string[] = [];
  const withoutDomains = query.replace(/\bsite:\S+/giu, " ");
  for (const raw of withoutDomains.match(/[A-Za-z0-9][A-Za-z0-9._-]*|[가-힣]+/gu) ?? []) {
    const value = raw.toLowerCase().replace(/[^a-z0-9가-힣]/gu, "");
    if (
      !value ||
      SEARCH_STOP_WORDS.has(value) ||
      /^20\d{2}$/u.test(value) ||
      (value.length === 1 && !/^\d$/u.test(value))
    ) continue;
    const target = /[a-z0-9]/u.test(value) ? latin : korean;
    if (!target.includes(value)) target.push(value);
  }
  return (latin.length > 0 ? latin : korean).slice(0, 4);
}

export function relevantSearchResults(
  query: string,
  results: readonly PublicSearchResult[],
): PublicSearchResult[] {
  const anchors = searchAnchors(query);
  const domains = [...query.toLowerCase().matchAll(/(?<![-\w])site:([a-z0-9.-]+)/gu)]
    .map((match) => match[1] ?? "")
    .filter(Boolean);
  return results.flatMap((result) => {
    let hostname: string;
    try {
      hostname = new URL(result.url).hostname.toLowerCase();
    } catch {
      return [];
    }
    if (
      domains.length > 0 &&
      !domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
    ) return [];
    const haystack = `${result.title} ${result.url} ${result.snippet}`
      .toLowerCase()
      .replace(/[^a-z0-9가-힣]/gu, "");
    const score = anchors.filter((anchor) => haystack.includes(anchor)).length;
    return anchors.length > 0 && score === 0 ? [] : [{ result, score }];
  }).sort((left, right) => right.score - left.score).map((item) => item.result);
}

export function topSearchResultMatchesQuery(
  query: string,
  results: readonly PublicSearchResult[],
): boolean {
  const first = results[0];
  if (!first) return false;
  const anchors = searchAnchors(query);
  if (anchors.length === 0) return true;
  const top = `${first.title} ${first.url} ${first.snippet}`
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]/gu, "");
  return anchors.some((anchor) => top.includes(anchor));
}

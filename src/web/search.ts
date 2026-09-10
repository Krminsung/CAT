import {
  boundedWebText,
  decodeHtmlEntities,
  inertWebText,
  parseHtmlDocument,
} from "./content.js";
import { normalizePublicWebUrl } from "./public-http.js";

const SEARCH_STOP_WORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "available",
  "be",
  "can",
  "checkpoint",
  "checkpoints",
  "current",
  "date",
  "do",
  "does",
  "download",
  "downloads",
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
  "like",
  "look",
  "looking",
  "me",
  "new",
  "news",
  "of",
  "official",
  "on",
  "recent",
  "release",
  "released",
  "search",
  "tell",
  "the",
  "today",
  "version",
  "web",
  "weights",
  "what",
  "when",
  "who",
  "with",
  "you",
  "가중치",
  "검색",
  "검색해",
  "깃허브",
  "뉴스",
  "다운로드",
  "대해",
  "며칠",
  "몇일",
  "방금",
  "설명",
  "어제",
  "오늘",
  "지금",
  "최근",
  "최신",
  "체크포인트",
  "출시",
  "출시한",
  "찾아봐",
  "찾아줘",
  "현재",
  "허깅페이스",
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

function decodeSearchUrl(raw: string): string {
  const decoded = inertWebText(decodeHtmlEntities(raw)).trim();
  if (!decoded || Buffer.byteLength(decoded, "utf8") > 8_192) return "";
  try {
    const parsed = new URL(decoded, "https://html.duckduckgo.com");
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
    return parsed.toString();
  } catch {
    return "";
  }
}

function normalizedResult(
  titleValue: string,
  urlValue: string,
  snippetValue: string,
): PublicSearchResult | undefined {
  const title = boundedWebText(cleanMarkdown(titleValue), 1_024, 300).text;
  const snippet = boundedWebText(cleanMarkdown(snippetValue), 4_096, 1_000).text;
  if (!title) return undefined;
  try {
    const url = normalizePublicWebUrl(decodeSearchUrl(urlValue));
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

export function parseBingHtmlResults(
  document: string,
  maximum: number,
): PublicSearchResult[] {
  const results: PublicSearchResult[] = [];
  for (const item of document.match(/<li\s+class="[^"]*\bb_algo\b[^"]*"[\s\S]*?<\/li>/giu) ?? []) {
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
      normalizedResult(title, heading[2] ?? "", snippet),
      maximum,
    )) break;
  }
  return results;
}

export function parseBingReaderResults(
  document: string,
  maximum: number,
): PublicSearchResult[] {
  const results: PublicSearchResult[] = [];
  const pattern = /^\d+\.\s+##\s+\[(.*?)\]\((https?:\/\/[^\n)]+)\)\s*([\s\S]*?)(?=^\d+\.\s+##\s+\[|$(?![\s\S]))/gmu;
  for (const match of document.matchAll(pattern)) {
    const snippet = (match[3] ?? "").split(/\r?\n/gu)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(" ");
    if (pushUnique(
      results,
      normalizedResult(match[1] ?? "", match[2] ?? "", snippet),
      maximum,
    )) break;
  }
  return results;
}

export function parseDuckDuckGoReaderResults(
  document: string,
  maximum: number,
): PublicSearchResult[] {
  const results: PublicSearchResult[] = [];
  const headings = [...document.matchAll(/^##\s+\[(.*?)\]\((https?:\/\/[^\n)]+)\)\s*$/gmu)];
  for (const [index, heading] of headings.entries()) {
    const end = headings[index + 1]?.index ?? document.length;
    const body = document.slice((heading.index ?? 0) + heading[0].length, end)
      .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1");
    if (pushUnique(
      results,
      normalizedResult(heading[1] ?? "", heading[2] ?? "", body),
      maximum,
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
    return [{ result, score: anchors.filter((anchor) => haystack.includes(anchor)).length }];
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

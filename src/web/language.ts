// Only conversational language is typo-tolerant. Never fuzzy-correct a place,
// product, version, URL, command, or other factual identifier into another one.
const KOREAN_FILLER = new Set([
  "어때", "어때요", "어떤가요", "어떤지", "어떨까요", "어떻나요", "어떻습니까",
  "어떻게", "돼요", "되나요", "알려", "알려줘", "알려줘요", "알려주세요",
  "어떻게돼요", "어떻게되나요", "어떻게될까요",
  "알려줄래", "알려줄래요", "알려주시겠어요", "알려주실래요",
  "설명해", "설명해줘", "설명해줘요", "설명해주세요",
  "확인해줘", "확인해줘요", "확인해주세요",
  "궁금해", "궁금해요", "궁금합니다", "궁금한데", "궁금한데요",
  "부탁해", "부탁해요", "부탁합니다", "부탁드려요", "부탁드립니다",
  "줘", "줘요", "주세요", "주실래요", "주시겠어요", "좀", "쫌", "혹시", "제발",
]);
const TYPO_FILLER = [...KOREAN_FILLER].filter((word) => word.length >= 3);
const ENGLISH_FILLER = /(?<![\p{L}\p{N}_.-])(?:please|tell\s+me|how\s+is|how's|what\s+is|what's|(?:can|could|would)\s+you)(?![\p{L}\p{N}_]|[.-][\p{L}\p{N}])/giu;
const KOREAN_WORD = /(?<![\p{L}\p{N}_.-])[가-힣]+(?![\p{L}\p{N}_]|[.-][\p{L}\p{N}])/gu;
const KOREAN_PARTICLE = /(?:에서는|으로는|에서|에는|으로|은|는|을|를|의|에)$/u;
const WEATHER_COMPOUND_TERM = /강수확률|강수량|체감기온|체감온도|날씨|날시|기온|강수|예보|습도/gu;
const WEATHER_PARTICLE_ONLY = /^(?:에서는|으로는|에서|에는|으로|은|는|이|가|을|를|도|의|에)$/u;
const WEATHER_TIME_PREFIX = /^(오늘|내일|모레|어제|지금|현재)(?:은|는|도|의)?(?=[가-힣])/u;
const WEATHER_TIME_SUFFIX = /([가-힣])(오늘|내일|모레|어제|지금|현재)(?:은|는|도|의)?$/u;
const MAX_WEATHER_WORD_LENGTH = 80;

/** Bounded, linear comparison: one insertion, deletion, substitution or swap. */
function oneEditApart(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  let index = 0;
  while (index < left.length && left[index] === right[index]) index += 1;
  if (left.length === right.length) {
    return left.slice(index + 1) === right.slice(index + 1) ||
      (
        left[index] === right[index + 1] &&
        left[index + 1] === right[index] &&
        left.slice(index + 2) === right.slice(index + 2)
      );
  }
  return left.length > right.length
    ? left.slice(index + 1) === right.slice(index)
    : left.slice(index) === right.slice(index + 1);
}

function conversationalWord(word: string): boolean {
  if (KOREAN_FILLER.has(word)) return true;
  // Preserve short names and arbitrary words that merely resemble an ending.
  if (word.length < 3 || word.length > 10) return false;
  return TYPO_FILLER.some((candidate) => {
    const sameStem = word.slice(0, 2) === candidate.slice(0, 2);
    const samePoliteFrame = word[0] === candidate[0] &&
      word.endsWith("요") && candidate.endsWith("요");
    return (sameStem || samePoliteFrame) && oneEditApart(word, candidate);
  });
}

function conversationalPhrase(value: string): boolean {
  const phrase = value.replace(/^(?:좀|쫌|혹시|제발|자세히|정확히)/u, "");
  return conversationalWord(value) || conversationalWord(phrase);
}

function weatherRemainder(value: string): string {
  // Inspect only a short suffix; never perform unbounded morphological search.
  for (let index = Math.max(0, value.length - 16); index < value.length; index += 1) {
    if (!conversationalPhrase(value.slice(index))) continue;
    const remainder = value.slice(0, index);
    return WEATHER_PARTICLE_ONLY.test(remainder) ? "" : remainder;
  }
  return WEATHER_PARTICLE_ONLY.test(value) ? "" : value;
}

function weatherContext(value: string): string {
  return value.replace(WEATHER_TIME_PREFIX, "$1 ")
    .replace(WEATHER_TIME_SUFFIX, "$1 $2");
}

/** Split known weather nouns without a city whitelist or guessed place names. */
function separateWeatherCompound(word: string): string {
  if (word.length > MAX_WEATHER_WORD_LENGTH) return word;
  const parts: string[] = [];
  let end = 0;
  for (const match of word.matchAll(WEATHER_COMPOUND_TERM)) {
    const position = match.index;
    const term = match[0];
    parts.push(weatherContext(word.slice(end, position)), term === "날시" ? "날씨" : term);
    end = position + term.length;
  }
  if (end === 0) return word;
  parts.push(weatherContext(weatherRemainder(word.slice(end))));
  return parts.filter(Boolean).join(" ");
}

/** Use after secret filtering; this is language cleanup, not a privacy guard. */
export function normalizeSearchLanguage(value: string): string {
  return value.normalize("NFC")
    .replace(ENGLISH_FILLER, " ")
    .replace(KOREAN_WORD, separateWeatherCompound)
    .replace(KOREAN_WORD, (word) => conversationalWord(word) ? " " : word)
    .replace(/\s+/gu, " ")
    .trim();
}

/** Remove grammatical particles, not spelling differences in factual names. */
export function searchAnchorToken(value: string, weather = false): string {
  const word = value.normalize("NFC").toLowerCase();
  const stem = word.replace(KOREAN_PARTICLE, "");
  const anchor = (stem.length >= 2 ? stem : word).replace(/[^a-z0-9가-힣]/gu, "");
  if (!weather || !/^[가-힣]+$/u.test(anchor)) return anchor;
  const location = anchor.replace(/(?:특별자치시|특별자치도|특별시|광역시|시|군|구)$/u, "");
  return location.length >= 2 ? location : anchor;
}

export function isWeatherQuery(value: string): boolean {
  return /날씨|날시|기온|강수|체감온도|습도|\b(?:weather|temperature)\b/iu.test(value.normalize("NFC"));
}

export function hasWeatherContent(value: string): boolean {
  return /날씨|기온|강수|예보|습도|체감\s*온도|\b(?:weather|temperature|forecast|humidity|precipitation)\b/iu.test(value.normalize("NFC"));
}

/** Keep word boundaries for Latin identifiers; Korean words may carry endings. */
export function matchingSearchAnchors(
  anchors: readonly string[],
  value: string,
): number {
  const words = (value.normalize("NFC").toLowerCase()
    .match(/[a-z0-9][a-z0-9._-]*|[가-힣]+/gu) ?? [])
    .flatMap((word) => [word, ...word.split(/[_-]/u)])
    .map((word) => word.replace(/[^a-z0-9가-힣]/gu, ""));
  const exact = new Set(words);
  const korean = words.filter((word) => /^[가-힣]+$/u.test(word));
  return anchors.filter((anchor) => exact.has(anchor) ||
    (/^[가-힣]+$/u.test(anchor) && korean.some((word) => word.includes(anchor)))
  ).length;
}

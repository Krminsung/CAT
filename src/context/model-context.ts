import { ConfigurationError } from "../core/errors.js";
import type { ConversationMessage } from "../core/messages.js";

const MIN_CONTEXT_WINDOW = 1_024;
const MAX_CONTEXT_WINDOW = 2_000_000;
const DEFAULT_AUTO_COMPACT_THRESHOLD = 0.85;

export type ContextWindowSource = "provider_metadata" | "user_setting" | "unknown";

export interface ModelContextOptions {
  readonly model: string;
  readonly providerContextWindow?: number;
  readonly userContextWindow?: number;
  readonly autoCompactThreshold?: number;
}

export interface ModelContextInfo {
  readonly model: string;
  readonly source: ContextWindowSource;
  readonly contextWindow?: number;
  readonly autoCompactThreshold: number;
  readonly autoCompactAtTokens?: number;
}

export type AutoCompactDecision =
  | {
      readonly state: "unavailable";
      readonly reason: "context_window_unknown";
      readonly currentTokens: number;
    }
  | {
      readonly state: "below_threshold";
      readonly currentTokens: number;
      readonly triggerTokens: number;
      readonly remainingTokens: number;
    }
  | {
      readonly state: "required";
      readonly currentTokens: number;
      readonly triggerTokens: number;
      readonly overageTokens: number;
    };

function contextWindow(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_CONTEXT_WINDOW ||
    value > MAX_CONTEXT_WINDOW
  ) {
    throw new ConfigurationError(
      `${label}은 ${MIN_CONTEXT_WINDOW}–${MAX_CONTEXT_WINDOW} 범위의 정수여야 합니다.`,
    );
  }
  return value;
}

function threshold(value: number | undefined): number {
  const selected = value ?? DEFAULT_AUTO_COMPACT_THRESHOLD;
  if (!Number.isFinite(selected) || selected < 0.5 || selected > 0.95) {
    throw new ConfigurationError("자동 압축 임계값은 0.5–0.95 범위여야 합니다.");
  }
  return selected;
}

export function resolveModelContext(options: ModelContextOptions): ModelContextInfo {
  if (typeof options.model !== "string") {
    throw new ConfigurationError("모델 context 정보의 model ID가 올바르지 않습니다.");
  }
  const model = options.model.trim();
  if (!model || [...model].length > 256 || /[\u0000-\u001f\u007f]/u.test(model)) {
    throw new ConfigurationError("모델 context 정보의 model ID가 올바르지 않습니다.");
  }
  const provider = contextWindow(
    options.providerContextWindow,
    "Provider model context window",
  );
  const user = contextWindow(options.userContextWindow, "사용자 context window");
  const autoCompactThreshold = threshold(options.autoCompactThreshold);
  const selected = provider ?? user;
  const source: ContextWindowSource = provider !== undefined
    ? "provider_metadata"
    : user !== undefined
      ? "user_setting"
      : "unknown";
  return Object.freeze({
    model,
    source,
    ...(selected === undefined ? {} : { contextWindow: selected }),
    autoCompactThreshold,
    ...(selected === undefined
      ? {}
      : { autoCompactAtTokens: Math.max(1, Math.floor(selected * autoCompactThreshold)) }),
  });
}

export function evaluateAutoCompact(
  context: ModelContextInfo,
  currentTokens: number,
): AutoCompactDecision {
  if (!Number.isSafeInteger(currentTokens) || currentTokens < 0) {
    throw new ConfigurationError("현재 context token 추정값이 올바르지 않습니다.");
  }
  const triggerTokens = context.autoCompactAtTokens;
  if (triggerTokens === undefined) {
    return Object.freeze({
      state: "unavailable",
      reason: "context_window_unknown",
      currentTokens,
    });
  }
  if (currentTokens < triggerTokens) {
    return Object.freeze({
      state: "below_threshold",
      currentTokens,
      triggerTokens,
      remainingTokens: triggerTokens - currentTokens,
    });
  }
  return Object.freeze({
    state: "required",
    currentTokens,
    triggerTokens,
    overageTokens: currentTokens - triggerTokens,
  });
}

function estimateTextTokens(value: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4) + nonAscii;
}

export function estimateMessageTokens(message: ConversationMessage): number {
  let serialized: string;
  try {
    const value = JSON.stringify(message);
    if (value === undefined) throw new Error("undefined_json");
    serialized = value;
  } catch {
    throw new ConfigurationError("대화 message의 token 크기를 추정할 수 없습니다.");
  }
  return Math.max(1, 8 + estimateTextTokens(serialized));
}

export function estimateConversationTokens(
  messages: readonly ConversationMessage[],
): number {
  let total = 0;
  for (const message of messages) {
    total += estimateMessageTokens(message);
    if (!Number.isSafeInteger(total)) {
      throw new ConfigurationError("대화 token 추정값이 안전한 정수 범위를 벗어났습니다.");
    }
  }
  return total;
}

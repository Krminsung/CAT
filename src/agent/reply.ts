import type { AssistantReply, AssistantReplyKind } from "../core/messages.js";

function replyKind(value: unknown): value is AssistantReplyKind {
  return value === "answer" || value === "direct" ||
    value === "clarification" || value === "unavailable";
}

/** Decode only a complete reply envelope. Never execute or repair its contents. */
export function parseAssistantReply(text: string): AssistantReply {
  const candidate = text.trim();
  if (Buffer.byteLength(candidate, "utf8") <= 2 * 1024 * 1024 && candidate.startsWith("{")) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (
        typeof value === "object" && value !== null && !Array.isArray(value) &&
        "kind" in value && replyKind(value.kind) &&
        "text" in value && typeof value.text === "string" && value.text.trim() &&
        Object.keys(value).length === 2
      ) return { kind: value.kind, text: value.text };
    } catch {
      // Plain replies from less structured providers remain supported.
    }
  }
  return { kind: "unclassified", text };
}

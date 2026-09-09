import { ProtocolError } from "../core/errors.js";
import type { JsonObject, JsonValue } from "../core/json.js";

const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 20_000;

function exceedsCodePoints(value: string, maximum: number): boolean {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > maximum) return true;
  }
  return false;
}

export function protocolRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      throw new ProtocolError(`${label}의 JSON 구조가 허용 한도를 초과했습니다.`);
    }
    const item = current.value;
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    ) {
      continue;
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    const object = protocolRecord(item);
    if (!object) throw new ProtocolError(`${label}에 JSON이 아닌 값이 있습니다.`);
    for (const child of Object.values(object)) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

export function protocolJsonObject(value: unknown, label: string): JsonObject {
  assertJsonValue(value, label);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolError(`${label}은 JSON 객체여야 합니다.`);
  }
  return value;
}

export function parseProtocolJsonObject(text: string, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ProtocolError(`${label}이 올바른 JSON이 아닙니다.`);
  }
  return protocolJsonObject(parsed, label);
}

export function protocolString(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /\p{Cc}/u.test(value) ||
    exceedsCodePoints(value, maximum)
  ) {
    throw new ProtocolError(`${label} 형식이 올바르지 않습니다.`);
  }
  return value;
}

export function protocolInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

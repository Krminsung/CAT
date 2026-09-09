import type { JsonObject, JsonValue } from "../core/json.js";

export type TextToolFallbackMode = "disabled" | "strict" | "relaxed";

export interface ParsedTextToolCall {
  readonly name: string;
  readonly input: JsonObject;
}

export type TextToolCallParseResult =
  | { readonly kind: "none" }
  | { readonly kind: "malformed"; readonly message: string }
  | { readonly kind: "calls"; readonly calls: readonly ParsedTextToolCall[] };

const MAX_FALLBACK_BYTES = 256 * 1024;
const MAX_FALLBACK_CALLS = 64;
const MAX_RELAXED_DEPTH = 32;
const MAX_RELAXED_NODES = 20_000;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,127}$/u;
const IDENTIFIER_START = /[A-Za-z_]/u;
const IDENTIFIER_CONTINUE = /[A-Za-z0-9_-]/u;
const INTEGER = /^[+-]?\d(?:_?\d)*$/u;
const DECIMAL = /^[+-]?(?:(?:\d(?:_?\d)*)?\.\d(?:_?\d)*|\d(?:_?\d)*\.)(?:[eE][+-]?\d(?:_?\d)*)?$/u;
const EXPONENT = /^[+-]?\d(?:_?\d)*(?:[eE][+-]?\d(?:_?\d)*)$/u;

function record(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function balancedObjectEnd(text: string, opening: number): number | undefined {
  let depth = 0;
  let quote: "\"" | "'" | undefined;
  let escaped = false;
  for (let index = opening; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
      if (depth < 0) return undefined;
    }
  }
  return undefined;
}

class RelaxedJsonParser {
  #index = 0;
  #nodes = 0;

  constructor(readonly text: string) {}

  parseObject(): JsonObject {
    const value = this.#value(0);
    this.#whitespace();
    if (this.#index !== this.text.length || !record(value)) {
      throw new Error("relaxed 입력은 완성된 JSON 객체여야 합니다.");
    }
    return value;
  }

  #value(depth: number): JsonValue {
    this.#whitespace();
    this.#nodes += 1;
    if (depth > MAX_RELAXED_DEPTH || this.#nodes > MAX_RELAXED_NODES) {
      throw new Error("relaxed 입력의 크기 또는 중첩이 너무 큽니다.");
    }
    const character = this.text[this.#index];
    if (character === "{") return this.#object(depth + 1);
    if (character === "[") return this.#array(depth + 1);
    if (character === "\"" || character === "'") return this.#string();
    return this.#literal();
  }

  #object(depth: number): JsonObject {
    this.#expect("{");
    this.#whitespace();
    const result = Object.create(null) as JsonObject;
    if (this.#take("}")) return result;
    while (true) {
      this.#whitespace();
      const character = this.text[this.#index];
      const key = character === "\"" || character === "'"
        ? this.#string()
        : this.#identifier();
      if (Object.hasOwn(result, key)) {
        throw new Error(`relaxed 입력에 중복된 key가 있습니다: ${key}`);
      }
      this.#whitespace();
      this.#expect(":");
      result[key] = this.#value(depth);
      this.#whitespace();
      if (this.#take("}")) return result;
      this.#expect(",");
      this.#whitespace();
      if (this.#take("}")) return result;
    }
  }

  #array(depth: number): JsonValue[] {
    this.#expect("[");
    this.#whitespace();
    const result: JsonValue[] = [];
    if (this.#take("]")) return result;
    while (true) {
      result.push(this.#value(depth));
      this.#whitespace();
      if (this.#take("]")) return result;
      this.#expect(",");
      this.#whitespace();
      if (this.#take("]")) return result;
    }
  }

  #identifier(): string {
    const first = this.text[this.#index];
    if (!first || !IDENTIFIER_START.test(first)) {
      throw new Error("relaxed 입력의 object key가 올바르지 않습니다.");
    }
    const start = this.#index;
    this.#index += 1;
    while (true) {
      const character = this.text[this.#index];
      if (!character || !IDENTIFIER_CONTINUE.test(character)) break;
      this.#index += 1;
    }
    return this.text.slice(start, this.#index);
  }

  #string(): string {
    const quote = this.text[this.#index];
    if (quote !== "\"" && quote !== "'") {
      throw new Error("relaxed 문자열 시작 문자가 올바르지 않습니다.");
    }
    this.#index += 1;
    let result = "";
    while (this.#index < this.text.length) {
      const character = this.text[this.#index];
      this.#index += 1;
      if (character === quote) return result;
      if (character === "\\") {
        const escaped = this.text[this.#index];
        this.#index += 1;
        if (!escaped) throw new Error("relaxed 문자열 escape가 끝나지 않았습니다.");
        if (escaped === "u") {
          const hexadecimal = this.text.slice(this.#index, this.#index + 4);
          if (!/^[0-9A-Fa-f]{4}$/u.test(hexadecimal)) {
            throw new Error("relaxed 문자열 Unicode escape가 올바르지 않습니다.");
          }
          result += String.fromCharCode(Number.parseInt(hexadecimal, 16));
          this.#index += 4;
          continue;
        }
        const replacements: Readonly<Record<string, string>> = {
          "\"": "\"",
          "'": "'",
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        const replacement = replacements[escaped];
        if (replacement === undefined) {
          throw new Error("relaxed 문자열 escape가 올바르지 않습니다.");
        }
        result += replacement;
        continue;
      }
      if (!character || /[\u0000-\u001f\u007f]/u.test(character)) {
        throw new Error("relaxed 문자열에 제어 문자를 사용할 수 없습니다.");
      }
      result += character;
    }
    throw new Error("relaxed 문자열이 끝나지 않았습니다.");
  }

  #literal(): JsonValue {
    const start = this.#index;
    while (this.#index < this.text.length) {
      const character = this.text[this.#index];
      if (!character || /[\s,\]}]/u.test(character)) break;
      this.#index += 1;
    }
    const token = this.text.slice(start, this.#index);
    if (/^true$/iu.test(token)) return true;
    if (/^false$/iu.test(token)) return false;
    if (/^(?:null|none)$/iu.test(token)) return null;
    if (INTEGER.test(token) || DECIMAL.test(token) || EXPONENT.test(token)) {
      const number = Number(token.replaceAll("_", ""));
      if (Number.isFinite(number)) return number;
    }
    throw new Error("relaxed 입력에는 인용되지 않은 값을 사용할 수 없습니다.");
  }

  #whitespace(): void {
    while (/\s/u.test(this.text[this.#index] ?? "")) this.#index += 1;
  }

  #take(character: string): boolean {
    if (this.text[this.#index] !== character) return false;
    this.#index += 1;
    return true;
  }

  #expect(character: string): void {
    if (!this.#take(character)) {
      throw new Error(`relaxed 입력에 ${character} 문자가 필요합니다.`);
    }
  }
}

function parseInput(raw: string, mode: Exclude<TextToolFallbackMode, "disabled">): JsonObject {
  if (mode === "relaxed") return new RelaxedJsonParser(raw).parseObject();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("strict fallback의 도구 인자는 완성된 JSON이어야 합니다.");
  }
  if (!record(parsed)) {
    throw new Error("strict fallback의 도구 인자는 JSON 객체여야 합니다.");
  }
  return parsed;
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (/\s/u.test(text[index] ?? "")) index += 1;
  return index;
}

export function parseTextToolCalls(
  text: string,
  mode: TextToolFallbackMode,
): TextToolCallParseResult {
  if (mode === "disabled") return { kind: "none" };
  const candidate = text.trim();
  if (!candidate.startsWith("call:")) return { kind: "none" };
  if (Buffer.byteLength(candidate, "utf8") > MAX_FALLBACK_BYTES) {
    return { kind: "malformed", message: "텍스트 도구 호출이 크기 제한을 초과했습니다." };
  }

  const calls: ParsedTextToolCall[] = [];
  let cursor = 0;
  try {
    while (cursor < candidate.length) {
      if (!candidate.startsWith("call:", cursor)) {
        throw new Error("완성된 메시지 전체가 도구 호출 형식이어야 합니다.");
      }
      cursor += "call:".length;
      const nameStart = cursor;
      while (/[a-z0-9_]/u.test(candidate[cursor] ?? "")) cursor += 1;
      const name = candidate.slice(nameStart, cursor);
      if (!TOOL_NAME_PATTERN.test(name)) {
        throw new Error("텍스트 도구 이름 형식이 올바르지 않습니다.");
      }
      cursor = skipWhitespace(candidate, cursor);
      if (candidate[cursor] !== "{") {
        throw new Error("텍스트 도구 호출에는 JSON 객체가 필요합니다.");
      }
      const end = balancedObjectEnd(candidate, cursor);
      if (end === undefined) {
        throw new Error("텍스트 도구 호출 JSON이 끝나지 않았습니다.");
      }
      calls.push(Object.freeze({
        name,
        input: parseInput(candidate.slice(cursor, end), mode),
      }));
      if (calls.length > MAX_FALLBACK_CALLS) {
        throw new Error("한 응답의 텍스트 도구 호출 수가 너무 많습니다.");
      }
      cursor = skipWhitespace(candidate, end);
    }
  } catch (error) {
    return {
      kind: "malformed",
      message: error instanceof Error
        ? error.message
        : "텍스트 도구 호출을 해석하지 못했습니다.",
    };
  }
  return calls.length > 0
    ? { kind: "calls", calls: Object.freeze(calls) }
    : { kind: "malformed", message: "텍스트 도구 호출이 비어 있습니다." };
}

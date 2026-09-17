import type { JsonObject, JsonValue } from "../core/json.js";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_INPUT_DEPTH = 32;
const MAX_INPUT_NODES = 20_000;
const MAX_SCHEMA_BYTES = 128 * 1024;
const MAX_SCHEMA_DEPTH = 20;
const MAX_SCHEMA_NODES = 4_000;
const MAX_PROPERTIES = 256;
const SUPPORTED_TYPES = new Set(["object", "array", "string", "boolean", "integer", "number", "null"]);
const SUPPORTED_KEYWORDS = new Set([
  "type",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
]);

/** Only claim provider strictness for the conservative, fully-required subset.
 * Host validation remains mandatory, including when this returns false. */
export function isStrictProviderSchema(schema: JsonObject): boolean {
  const permitted = new Set([
    "type", "description", "enum", "properties", "required", "additionalProperties", "items",
  ]);
  const visit = (node: JsonValue, depth: number): boolean => {
    if (depth > MAX_SCHEMA_DEPTH || node === null || typeof node !== "object" || Array.isArray(node)) {
      return false;
    }
    if (Object.keys(node).some((key) => !permitted.has(key))) return false;
    if (node.type === "object") {
      const properties = node.properties;
      const required = node.required;
      if (
        node.additionalProperties !== false || !properties ||
        typeof properties !== "object" || Array.isArray(properties) ||
        !Array.isArray(required)
      ) return false;
      const names = Object.keys(properties);
      return names.length === required.length && names.every((name) => required.includes(name)) &&
        Object.values(properties).every((child) => visit(child, depth + 1));
    }
    if (node.type === "array") return node.items !== undefined && visit(node.items, depth + 1);
    return typeof node.type === "string" && SUPPORTED_TYPES.has(node.type);
  };
  return schema.type === "object" && visit(schema, 0);
}

export class ToolInputValidationError extends Error {
  override name = "ToolInputValidationError";
}

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function fail(message: string): never {
  throw new ToolInputValidationError(message);
}

function boundedJson(
  value: unknown,
  label: string,
  maximumBytes: number,
  maximumDepth: number,
  maximumNodes: number,
): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > maximumNodes) fail(`${label}의 JSON 항목 수가 너무 많습니다.`);
    if (current.depth > maximumDepth) fail(`${label}의 JSON 중첩이 너무 깊습니다.`);
    const item = current.value;
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    ) {
      continue;
    }
    if (typeof item !== "object") fail(`${label}에 JSON이 아닌 값이 있습니다.`);
    if (seen.has(item)) fail(`${label}에 순환 참조가 있습니다.`);
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (!record(item)) fail(`${label}에 일반 JSON 객체가 아닌 값이 있습니다.`);
    for (const [key, child] of Object.entries(item)) {
      if (key.includes("\0")) fail(`${label}의 객체 키가 올바르지 않습니다.`);
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  let serialized: string;
  try {
    const candidate = JSON.stringify(value);
    if (candidate === undefined) fail(`${label}을 JSON으로 표현할 수 없습니다.`);
    serialized = candidate;
  } catch {
    fail(`${label}을 JSON으로 표현할 수 없습니다.`);
  }
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    fail(`${label}이 ${maximumBytes} bytes 제한을 초과했습니다.`);
  }
}

function schemaInteger(
  schema: Record<string, unknown>,
  key: string,
  minimum: number,
): number | undefined {
  const value = schema[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    fail(`도구 schema의 ${key} 값이 올바르지 않습니다.`);
  }
  return Number(value);
}

function validateSchemaNode(value: unknown, path: string, depth: number): void {
  if (depth > MAX_SCHEMA_DEPTH || !record(value)) fail(`${path} schema가 올바르지 않습니다.`);
  for (const key of Object.keys(value)) {
    if (!SUPPORTED_KEYWORDS.has(key)) fail(`${path} schema에 지원하지 않는 ${key} keyword가 있습니다.`);
  }
  if (typeof value.type !== "string" || !SUPPORTED_TYPES.has(value.type)) {
    fail(`${path} schema의 type이 지원되지 않습니다.`);
  }
  if (value.description !== undefined && typeof value.description !== "string") {
    fail(`${path} schema의 description은 문자열이어야 합니다.`);
  }
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.length > 128) {
      fail(`${path} schema의 enum 항목 수가 올바르지 않습니다.`);
    }
    boundedJson(value.enum, `${path} enum`, 64 * 1024, 8, 1_024);
  }

  if (value.type === "object") {
    if (!record(value.properties) || Object.keys(value.properties).length > MAX_PROPERTIES) {
      fail(`${path} schema의 properties가 올바르지 않습니다.`);
    }
    if (value.additionalProperties !== false) {
      fail(`${path} object schema는 additionalProperties: false여야 합니다.`);
    }
    const required = value.required;
    if (!Array.isArray(required) || required.some((item) => typeof item !== "string")) {
      fail(`${path} schema의 required가 올바르지 않습니다.`);
    }
    const requiredNames = required as string[];
    if (new Set(requiredNames).size !== requiredNames.length) {
      fail(`${path} schema의 required 항목이 중복됐습니다.`);
    }
    for (const name of requiredNames) {
      if (!Object.hasOwn(value.properties, name)) {
        fail(`${path} schema의 required 항목 ${name}이 정의되지 않았습니다.`);
      }
    }
    for (const [name, nested] of Object.entries(value.properties)) {
      validateSchemaNode(nested, `${path}.${name}`, depth + 1);
    }
  } else if (value.properties !== undefined || value.required !== undefined || value.additionalProperties !== undefined) {
    fail(`${path}의 object 전용 schema keyword가 잘못 사용되었습니다.`);
  }

  if (value.type === "array") {
    if (value.items === undefined) fail(`${path} array schema에는 items가 필요합니다.`);
    validateSchemaNode(value.items, `${path}[]`, depth + 1);
    const minimum = schemaInteger(value, "minItems", 0);
    const maximum = schemaInteger(value, "maxItems", 0);
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      fail(`${path} schema의 배열 범위가 올바르지 않습니다.`);
    }
  } else if (value.items !== undefined || value.minItems !== undefined || value.maxItems !== undefined) {
    fail(`${path}의 array 전용 schema keyword가 잘못 사용되었습니다.`);
  }

  if (value.type === "string") {
    const minimum = schemaInteger(value, "minLength", 0);
    const maximum = schemaInteger(value, "maxLength", 0);
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      fail(`${path} schema의 문자열 길이 범위가 올바르지 않습니다.`);
    }
    if (value.pattern !== undefined) {
      if (typeof value.pattern !== "string" || value.pattern.length > 512) {
        fail(`${path} schema의 pattern이 올바르지 않습니다.`);
      }
      try {
        void new RegExp(value.pattern, "u");
      } catch {
        fail(`${path} schema의 pattern 정규식이 올바르지 않습니다.`);
      }
    }
  } else if (value.minLength !== undefined || value.maxLength !== undefined || value.pattern !== undefined) {
    fail(`${path}의 string 전용 schema keyword가 잘못 사용되었습니다.`);
  }

  if (value.type === "integer" || value.type === "number") {
    for (const key of ["minimum", "maximum"] as const) {
      const constraint = value[key];
      if (constraint !== undefined && (typeof constraint !== "number" || !Number.isFinite(constraint))) {
        fail(`${path} schema의 ${key} 값이 올바르지 않습니다.`);
      }
    }
    if (
      typeof value.minimum === "number" &&
      typeof value.maximum === "number" &&
      value.minimum > value.maximum
    ) {
      fail(`${path} schema의 숫자 범위가 올바르지 않습니다.`);
    }
  } else if (value.minimum !== undefined || value.maximum !== undefined) {
    fail(`${path}의 숫자 전용 schema keyword가 잘못 사용되었습니다.`);
  }
}

export function assertSupportedToolSchema(schema: JsonObject, label: string): void {
  boundedJson(schema, `${label} schema`, MAX_SCHEMA_BYTES, MAX_SCHEMA_DEPTH, MAX_SCHEMA_NODES);
  validateSchemaNode(schema, label, 0);
  if (schema.type !== "object") fail(`${label} 입력 schema의 최상위 type은 object여야 합니다.`);
}

function codePointLength(value: string): number {
  return [...value].length;
}

function enumContains(values: readonly unknown[], target: unknown): boolean {
  const serializedTarget = JSON.stringify(target);
  if (serializedTarget === undefined) return false;
  return values.some((value) => JSON.stringify(value) === serializedTarget);
}

function validateValue(value: unknown, schema: Record<string, unknown>, path: string): void {
  if (Array.isArray(schema.enum) && !enumContains(schema.enum, value)) {
    fail(`${path}: 허용된 값 중 하나를 지정해야 합니다.`);
  }
  switch (schema.type) {
    case "object": {
      if (!record(value)) fail(`${path}: object 형식이 필요합니다.`);
      const properties = schema.properties as Record<string, unknown>;
      const required = schema.required as string[];
      for (const name of required) {
        if (!Object.hasOwn(value, name)) fail(`${path}.${name}: 필수 인자가 누락되었습니다.`);
      }
      for (const [name, nested] of Object.entries(value)) {
        const childSchema = Object.hasOwn(properties, name) ? properties[name] : undefined;
        if (childSchema === undefined) fail(`${path}.${name}: 정의되지 않은 추가 인자입니다.`);
        validateValue(nested, childSchema as Record<string, unknown>, `${path}.${name}`);
      }
      return;
    }
    case "array": {
      if (!Array.isArray(value)) fail(`${path}: array 형식이 필요합니다.`);
      const minimum = schema.minItems as number | undefined;
      const maximum = schema.maxItems as number | undefined;
      if (minimum !== undefined && value.length < minimum) fail(`${path}: 배열 항목이 너무 적습니다.`);
      if (maximum !== undefined && value.length > maximum) fail(`${path}: 배열 항목이 너무 많습니다.`);
      value.forEach((item, index) => {
        validateValue(item, schema.items as Record<string, unknown>, `${path}[${index}]`);
      });
      return;
    }
    case "string": {
      if (typeof value !== "string") fail(`${path}: string 형식이 필요합니다.`);
      const length = codePointLength(value);
      const minimum = schema.minLength as number | undefined;
      const maximum = schema.maxLength as number | undefined;
      if (minimum !== undefined && length < minimum) fail(`${path}: 문자열이 너무 짧습니다.`);
      if (maximum !== undefined && length > maximum) fail(`${path}: 문자열이 너무 깁니다.`);
      if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
        fail(`${path}: 문자열 형식이 올바르지 않습니다.`);
      }
      return;
    }
    case "boolean":
      if (typeof value !== "boolean") fail(`${path}: boolean 형식이 필요합니다.`);
      return;
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(`${path}: 안전한 정수가 필요합니다.`);
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) fail(`${path}: 유한한 숫자가 필요합니다.`);
      break;
    case "null":
      if (value !== null) fail(`${path}: null 값이 필요합니다.`);
      return;
    default:
      fail(`${path}: 지원하지 않는 schema type입니다.`);
  }
  const numberValue = value as number;
  if (typeof schema.minimum === "number" && numberValue < schema.minimum) fail(`${path}: 숫자가 너무 작습니다.`);
  if (typeof schema.maximum === "number" && numberValue > schema.maximum) fail(`${path}: 숫자가 너무 큽니다.`);
}

export function validateToolInput(input: unknown, schema: JsonObject, toolName: string): JsonObject {
  boundedJson(input, `${toolName} 입력`, MAX_INPUT_BYTES, MAX_INPUT_DEPTH, MAX_INPUT_NODES);
  if (!record(input)) fail(`${toolName}: 도구 인자는 JSON 객체여야 합니다.`);
  validateValue(input, schema, toolName);
  return input as JsonObject;
}

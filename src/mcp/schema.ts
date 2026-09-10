import { createHash } from "node:crypto";
import {
  Ajv2020,
  type ErrorObject,
  type Schema,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import type { JsonObject, JsonValue } from "../core/json.js";
import { ToolInputValidationError } from "../tools/schema.js";
import type { McpNamespacedTool } from "./discovery.js";
import { McpError } from "./errors.js";

export const MCP_JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

const MCP_JSON_SCHEMA_DIALECT_WITH_FRAGMENT = `${MCP_JSON_SCHEMA_DIALECT}#`;
const MAX_SCHEMA_BYTES = 128 * 1024;
const MAX_SCHEMA_DEPTH = 24;
const MAX_SCHEMA_NODES = 4_000;
const MAX_SCHEMA_OBJECT_KEYS = 512;
const MAX_SCHEMA_ARRAY_ITEMS = 1_024;
const MAX_SCHEMA_KEY_BYTES = 1_024;
const MAX_SCHEMA_MAP_ENTRIES = 256;
const MAX_COMPOSITION_BRANCHES = 32;
const MAX_TOTAL_COMPOSITION_BRANCHES = 128;
const MAX_COMPOSITION_PATH_PRODUCT = 256;
const MAX_SCHEMA_EVALUATION_STEPS = 100_000;
const MAX_TUPLE_ITEMS = 64;
const MAX_REQUIRED_ITEMS = 256;
const MAX_ENUM_ITEMS = 256;
const MAX_REF_BYTES = 4_096;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_INPUT_DEPTH = 32;
const MAX_INPUT_NODES = 20_000;
const MAX_VALIDATION_ERRORS = 4;
const MAX_DISABLED_REASON_BYTES = 2_048;

const SUPPORTED_KEYWORDS = new Set([
  "$schema",
  "$ref",
  "$defs",
  "$comment",
  "type",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "const",
  "enum",
  "multipleOf",
  "maximum",
  "exclusiveMaximum",
  "minimum",
  "exclusiveMinimum",
  "minLength",
  "maxLength",
  "prefixItems",
  "items",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "properties",
  "required",
  "additionalProperties",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
]);

const SCHEMA_VALUE_KEYWORDS = [
  "items",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
] as const;
const SCHEMA_ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf"] as const;
const SCHEMA_MAP_KEYWORDS = ["$defs", "properties"] as const;

export interface CompiledMcpInputSchema {
  readonly schema: Readonly<JsonObject>;
  validate(input: unknown): JsonObject;
}

export interface CompiledMcpOutputSchema {
  readonly schema: Readonly<JsonObject>;
  validate(output: unknown): JsonObject;
}

export interface PreparedMcpTool extends McpNamespacedTool {
  readonly toolVersion: string;
  readonly compiledInput: CompiledMcpInputSchema;
  readonly compiledOutput?: CompiledMcpOutputSchema;
}

export type McpToolPreparation =
  | { readonly enabled: true; readonly tool: PreparedMcpTool }
  | {
      readonly enabled: false;
      readonly apiName: string;
      readonly serverName: string;
      readonly toolName: string;
      readonly reason: string;
    };

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function schemaFail(message: string): never {
  throw new McpError(message);
}

function cloneObject(value: JsonObject): JsonObject {
  let serialized: string;
  try {
    const candidate = JSON.stringify(value);
    if (candidate === undefined) throw new Error("undefined JSON");
    serialized = candidate;
  } catch (error) {
    throw new McpError("MCP schema를 JSON으로 복제하지 못했습니다.", { cause: error });
  }
  const cloned = JSON.parse(serialized) as unknown;
  if (!record(cloned)) throw new McpError("MCP schema 복제 결과가 객체가 아닙니다.");
  return cloned as JsonObject;
}

function freezeJson(value: JsonValue): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Array.isArray(value) ? value : Object.values(value)) freezeJson(child);
  Object.freeze(value);
}

function assertBoundedJson(
  value: unknown,
  label: string,
  maximumBytes: number,
  maximumDepth: number,
  maximumNodes: number,
  fail: (message: string) => never,
): void {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
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
      if (item.length > MAX_SCHEMA_ARRAY_ITEMS && label.includes("schema")) {
        fail(`${label}의 배열 항목 수가 너무 많습니다.`);
      }
      for (const child of item) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (!record(item)) fail(`${label}에 일반 JSON 객체가 아닌 값이 있습니다.`);
    const entries = Object.entries(item);
    if (entries.length > MAX_SCHEMA_OBJECT_KEYS && label.includes("schema")) {
      fail(`${label}의 객체 항목 수가 너무 많습니다.`);
    }
    for (const [key, child] of entries) {
      if (
        key.includes("\0") ||
        (label.includes("schema") && Buffer.byteLength(key, "utf8") > MAX_SCHEMA_KEY_BYTES)
      ) {
        fail(`${label}의 객체 키가 올바르지 않습니다.`);
      }
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

function schemaArray(
  value: unknown,
  path: string,
  maximum: number,
): readonly (JsonObject | boolean)[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    schemaFail(`${path}의 schema 배열 항목 수가 올바르지 않습니다.`);
  }
  return value.map((item) => {
    if (typeof item === "boolean" || record(item)) return item as JsonObject | boolean;
    return schemaFail(`${path}에 올바르지 않은 하위 schema가 있습니다.`);
  });
}

function schemaMap(value: unknown, path: string): Readonly<Record<string, JsonObject | boolean>> {
  if (!record(value) || Object.keys(value).length > MAX_SCHEMA_MAP_ENTRIES) {
    schemaFail(`${path}의 schema map이 올바르지 않습니다.`);
  }
  const result: Record<string, JsonObject | boolean> = Object.create(null) as Record<string, JsonObject | boolean>;
  for (const [name, child] of Object.entries(value)) {
    if (!name || Buffer.byteLength(name, "utf8") > MAX_SCHEMA_KEY_BYTES) {
      schemaFail(`${path}의 schema 이름이 올바르지 않습니다.`);
    }
    if (typeof child !== "boolean" && !record(child)) {
      schemaFail(`${path}.${name}이 올바른 schema가 아닙니다.`);
    }
    result[name] = child as JsonObject | boolean;
  }
  return result;
}

function assertLocalReference(value: unknown, path: string): void {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_REF_BYTES ||
    !/^#(?:\/(?:[A-Za-z0-9._$-]|~[01])*)*$/u.test(value)
  ) {
    schemaFail(`${path}에는 문서 내부 JSON Pointer 참조만 사용할 수 있습니다.`);
  }
}

function referencedSchema(
  root: JsonObject,
  reference: string,
  path: string,
): JsonObject | boolean {
  let current: unknown = root;
  for (const encoded of reference === "#" ? [] : reference.slice(2).split("/")) {
    const token = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) {
        schemaFail(`${path}의 JSON Pointer 배열 위치가 올바르지 않습니다.`);
      }
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= current.length) {
        schemaFail(`${path}의 JSON Pointer 대상이 없습니다.`);
      }
      current = current[index];
      continue;
    }
    if (!record(current) || !Object.hasOwn(current, token)) {
      schemaFail(`${path}의 JSON Pointer 대상이 없습니다.`);
    }
    current = current[token];
  }
  if (typeof current !== "boolean" && !record(current)) {
    schemaFail(`${path}의 JSON Pointer 대상이 schema가 아닙니다.`);
  }
  return current as JsonObject | boolean;
}

function pointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

interface SchemaComplexity {
  compositionBranches: number;
}

function assertReferenceComplexity(
  root: JsonObject,
  label: string,
  schemaPointers: ReadonlySet<string>,
): void {
  const active = new Set<object>();
  const checkedProduct = new Map<object, number>();
  let steps = 0;
  const visit = (
    value: JsonObject | boolean,
    path: string,
    branchProduct: number,
  ): void => {
    if (typeof value === "boolean") return;
    steps += 1;
    if (steps > MAX_SCHEMA_EVALUATION_STEPS) {
      schemaFail(`${label} schema의 reference 평가 구조가 너무 큽니다.`);
    }
    if (active.has(value)) {
      schemaFail(`${path}에 순환하는 $ref가 있어 안전하게 평가할 수 없습니다.`);
    }
    if ((checkedProduct.get(value) ?? 0) >= branchProduct) return;
    checkedProduct.set(value, branchProduct);
    active.add(value);
    try {
      const compositions = SCHEMA_ARRAY_KEYWORDS.flatMap((keyword) => {
        const child = value[keyword];
        return child === undefined
          ? []
          : [{ keyword, branches: schemaArray(child, `${path}.${keyword}`, MAX_COMPOSITION_BRANCHES) }];
      });
      let nestedProduct = branchProduct;
      for (const { keyword, branches } of compositions) {
        nestedProduct *= branches.length;
        if (nestedProduct > MAX_COMPOSITION_PATH_PRODUCT) {
          schemaFail(`${path}.${keyword}의 reference 조합 복잡도가 허용 범위를 초과했습니다.`);
        }
      }
      for (const { keyword, branches } of compositions) {
        for (const [index, nested] of branches.entries()) {
          visit(nested, `${path}.${keyword}[${index}]`, nestedProduct);
        }
      }
      if (value.properties !== undefined) {
        for (const [name, nested] of Object.entries(schemaMap(value.properties, `${path}.properties`))) {
          visit(nested, `${path}.properties.${name}`, branchProduct);
        }
      }
      if (value.prefixItems !== undefined) {
        const prefixItems = schemaArray(value.prefixItems, `${path}.prefixItems`, MAX_TUPLE_ITEMS);
        for (const [index, nested] of prefixItems.entries()) {
          visit(nested, `${path}.prefixItems[${index}]`, branchProduct);
        }
      }
      for (const keyword of SCHEMA_VALUE_KEYWORDS) {
        const child = value[keyword];
        if (child !== undefined) {
          visit(child as JsonObject | boolean, `${path}.${keyword}`, branchProduct);
        }
      }
      if (typeof value.$ref === "string") {
        if (!schemaPointers.has(value.$ref)) {
          schemaFail(`${path}.$ref가 검증된 schema 위치를 가리키지 않습니다.`);
        }
        visit(referencedSchema(root, value.$ref, `${path}.$ref`), `${path}.$ref`, branchProduct);
      }
    } finally {
      active.delete(value);
    }
  };
  visit(root, label, 1);
}

function assertSchemaNode(
  value: JsonObject | boolean,
  path: string,
  depth: number,
  root: boolean,
  complexity: SchemaComplexity,
  branchProduct: number,
  pointer: string,
  schemaPointers: Set<string>,
): void {
  schemaPointers.add(pointer);
  if (depth > MAX_SCHEMA_DEPTH) schemaFail(`${path} schema의 중첩이 너무 깊습니다.`);
  if (typeof value === "boolean") return;
  for (const key of Object.keys(value)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      schemaFail(`${path} schema에 지원하지 않는 ${key} keyword가 있습니다.`);
    }
  }

  if (value.$schema !== undefined) {
    if (
      !root ||
      (value.$schema !== MCP_JSON_SCHEMA_DIALECT && value.$schema !== MCP_JSON_SCHEMA_DIALECT_WITH_FRAGMENT)
    ) {
      schemaFail(`${path} schema의 dialect가 지원되지 않습니다.`);
    }
  }
  if (value.$ref !== undefined) assertLocalReference(value.$ref, `${path}.$ref`);
  if (value.type !== undefined) {
    const supportedTypes = new Set(["null", "boolean", "object", "array", "number", "string", "integer"]);
    if (typeof value.type !== "string" || !supportedTypes.has(value.type)) {
      schemaFail(`${path} schema의 type 표현이 지원되지 않습니다.`);
    }
  }
  if (value.required !== undefined) {
    if (
      !Array.isArray(value.required) ||
      value.required.length > MAX_REQUIRED_ITEMS ||
      value.required.some((item) => typeof item !== "string") ||
      new Set(value.required).size !== value.required.length
    ) {
      schemaFail(`${path}.required가 올바르지 않습니다.`);
    }
  }
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length > MAX_ENUM_ITEMS)) {
    schemaFail(`${path}.enum 항목 수가 올바르지 않습니다.`);
  }

  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const child = value[keyword];
    if (child === undefined) continue;
    for (const [name, nested] of Object.entries(schemaMap(child, `${path}.${keyword}`))) {
      assertSchemaNode(
        nested,
        `${path}.${keyword}.${name}`,
        depth + 1,
        false,
        complexity,
        branchProduct,
        `${pointer}/${pointerToken(keyword)}/${pointerToken(name)}`,
        schemaPointers,
      );
    }
  }
  const compositionSchemas = SCHEMA_ARRAY_KEYWORDS.flatMap((keyword) => {
    const child = value[keyword];
    return child === undefined
      ? []
      : [{ keyword, branches: schemaArray(child, `${path}.${keyword}`, MAX_COMPOSITION_BRANCHES) }];
  });
  let nextProduct = branchProduct;
  for (const { keyword, branches } of compositionSchemas) {
    complexity.compositionBranches += branches.length;
    nextProduct *= branches.length;
    if (
      complexity.compositionBranches > MAX_TOTAL_COMPOSITION_BRANCHES ||
      nextProduct > MAX_COMPOSITION_PATH_PRODUCT
    ) {
      schemaFail(`${path}.${keyword}의 조합 복잡도가 허용 범위를 초과했습니다.`);
    }
  }
  for (const { keyword, branches } of compositionSchemas) {
    for (const [index, nested] of branches.entries()) {
      assertSchemaNode(
        nested,
        `${path}.${keyword}[${index}]`,
        depth + 1,
        false,
        complexity,
        nextProduct,
        `${pointer}/${pointerToken(keyword)}/${index}`,
        schemaPointers,
      );
    }
  }
  if (value.prefixItems !== undefined) {
    for (const [index, nested] of schemaArray(value.prefixItems, `${path}.prefixItems`, MAX_TUPLE_ITEMS).entries()) {
      assertSchemaNode(
        nested,
        `${path}.prefixItems[${index}]`,
        depth + 1,
        false,
        complexity,
        branchProduct,
        `${pointer}/prefixItems/${index}`,
        schemaPointers,
      );
    }
  }
  for (const keyword of SCHEMA_VALUE_KEYWORDS) {
    const child = value[keyword];
    if (child === undefined) continue;
    if (typeof child !== "boolean" && !record(child)) {
      schemaFail(`${path}.${keyword}가 올바른 schema가 아닙니다.`);
    }
    assertSchemaNode(
      child as JsonObject | boolean,
      `${path}.${keyword}`,
      depth + 1,
      false,
      complexity,
      branchProduct,
      `${pointer}/${pointerToken(keyword)}`,
      schemaPointers,
    );
  }
}

function assertSupportedSchema(schema: JsonObject, label: string): void {
  assertBoundedJson(
    schema,
    `${label} schema`,
    MAX_SCHEMA_BYTES,
    MAX_SCHEMA_DEPTH,
    MAX_SCHEMA_NODES,
    schemaFail,
  );
  const schemaPointers = new Set<string>();
  assertSchemaNode(schema, label, 0, true, { compositionBranches: 0 }, 1, "#", schemaPointers);
  assertReferenceComplexity(schema, label, schemaPointers);
  if (schema.type !== "object") {
    schemaFail(`${label} schema의 최상위 type은 object여야 합니다.`);
  }
}

function createAjv(): Ajv2020 {
  return new Ajv2020({
    strict: true,
    allErrors: false,
    validateFormats: true,
    $data: false,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    ownProperties: true,
    addUsedSchema: false,
    inlineRefs: false,
    loopEnum: 64,
    loopRequired: 64,
    logger: false,
    code: { optimize: 1, source: false, lines: false },
  });
}

function compileSchema(schema: JsonObject, label: string): {
  readonly schema: Readonly<JsonObject>;
  readonly validator: ValidateFunction<unknown>;
} {
  const stableSchema = cloneObject(schema);
  assertSupportedSchema(stableSchema, label);
  let validator: ValidateFunction<unknown>;
  try {
    validator = createAjv().compile(stableSchema as unknown as Schema);
  } catch (error) {
    throw new McpError(`${label} schema를 안전하게 컴파일하지 못했습니다.`, { cause: error });
  }
  freezeJson(stableSchema);
  return Object.freeze({ schema: stableSchema, validator });
}

function validationDetails(errors: readonly ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "schema 조건 불일치";
  return errors.slice(0, MAX_VALIDATION_ERRORS).map((error) => {
    const path = error.instancePath || "$";
    return `${path}:${error.keyword}`;
  }).join(", ");
}

function inputFailure(message: string): never {
  throw new ToolInputValidationError(message);
}

export function compileMcpInputSchema(schema: JsonObject, toolName: string): CompiledMcpInputSchema {
  const compiled = compileSchema(schema, `${toolName} input`);
  return Object.freeze({
    schema: compiled.schema,
    validate(input: unknown): JsonObject {
      assertBoundedJson(
        input,
        `${toolName} 입력`,
        MAX_INPUT_BYTES,
        MAX_INPUT_DEPTH,
        MAX_INPUT_NODES,
        inputFailure,
      );
      if (!record(input)) inputFailure(`${toolName}: 도구 인자는 JSON 객체여야 합니다.`);
      if (!compiled.validator(input)) {
        inputFailure(`${toolName}: 입력이 MCP schema와 일치하지 않습니다 (${validationDetails(compiled.validator.errors)}).`);
      }
      return input as JsonObject;
    },
  });
}

export function compileMcpOutputSchema(schema: JsonObject, toolName: string): CompiledMcpOutputSchema {
  const compiled = compileSchema(schema, `${toolName} output`);
  return Object.freeze({
    schema: compiled.schema,
    validate(output: unknown): JsonObject {
      assertBoundedJson(
        output,
        `${toolName} structuredContent`,
        MAX_INPUT_BYTES,
        MAX_INPUT_DEPTH,
        MAX_INPUT_NODES,
        schemaFail,
      );
      if (!record(output)) schemaFail(`${toolName}: structuredContent는 JSON 객체여야 합니다.`);
      if (!compiled.validator(output)) {
        schemaFail(
          `${toolName}: structuredContent가 output schema와 일치하지 않습니다 ` +
            `(${validationDetails(compiled.validator.errors)}).`,
        );
      }
      return output as JsonObject;
    },
  });
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new McpError("MCP tool version 값을 직렬화하지 못했습니다.");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(",")}}`;
}

export function mcpToolVersion(tool: McpNamespacedTool): string {
  const material: JsonObject = {
    apiName: tool.apiName,
    description: tool.description,
    inputSchema: tool.inputSchema ?? null,
    outputSchema: tool.outputSchema ?? null,
    protocolVersion: tool.protocolVersion,
    serverName: tool.serverName,
    toolName: tool.toolName,
  };
  return createHash("sha256").update(canonicalJson(material), "utf8").digest("hex");
}

function boundedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "MCP schema를 준비하지 못했습니다.";
  const sanitized = message.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "�");
  const bytes = Buffer.from(sanitized, "utf8");
  if (bytes.byteLength <= MAX_DISABLED_REASON_BYTES) return sanitized;
  let end = MAX_DISABLED_REASON_BYTES - Buffer.byteLength("…", "utf8");
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}…`;
}

export function prepareMcpTool(tool: McpNamespacedTool): McpToolPreparation {
  try {
    if (tool.schemaIssue) throw new McpError(`${tool.apiName}: ${tool.schemaIssue}`);
    if (!tool.inputSchema) throw new McpError(`${tool.apiName}: inputSchema가 없어 도구를 활성화할 수 없습니다.`);
    const compiledInput = compileMcpInputSchema(tool.inputSchema as JsonObject, tool.apiName);
    const compiledOutput = tool.outputSchema
      ? compileMcpOutputSchema(tool.outputSchema as JsonObject, tool.apiName)
      : undefined;
    const prepared: PreparedMcpTool = Object.freeze({
      ...tool,
      toolVersion: mcpToolVersion(tool),
      compiledInput,
      ...(compiledOutput === undefined ? {} : { compiledOutput }),
    });
    return Object.freeze({ enabled: true, tool: prepared });
  } catch (error) {
    return Object.freeze({
      enabled: false,
      apiName: tool.apiName,
      serverName: tool.serverName,
      toolName: tool.toolName,
      reason: boundedReason(error),
    });
  }
}

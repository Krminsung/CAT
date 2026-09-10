import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "../core/json.js";
import { McpError } from "./errors.js";
import type { McpProtocolAdapter, McpProtocolVersion } from "./protocol.js";

export const MCP_MAX_DISCOVERY_PAGES = 100;
export const MCP_MAX_DISCOVERED_TOOLS = 10_000;

const MAX_CURSOR_CODE_POINTS = 4_096;
const MAX_CURSOR_BYTES = 16 * 1024;
const MAX_TOOL_METADATA_BYTES = 256 * 1024;
const MAX_DISCOVERY_METADATA_BYTES = 32 * 1024 * 1024;
const MAX_DESCRIPTION_BYTES = 4_096;
const MAX_DISCOVERY_NOTICES = 256;
const API_NAME_MAX_LENGTH = 128;
const API_NAME_HASH_LENGTH = 12;

export interface McpDiscoveredTool {
  readonly serverName: string;
  readonly protocolVersion: McpProtocolVersion;
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema?: Readonly<JsonObject>;
  readonly outputSchema?: Readonly<JsonObject>;
  readonly annotations?: Readonly<JsonObject>;
  readonly schemaIssue?: string;
}

export interface McpNamespacedTool extends McpDiscoveredTool {
  readonly apiName: string;
}

export interface McpDiscoveryResult {
  readonly tools: readonly McpDiscoveredTool[];
  readonly notices: readonly string[];
  readonly pages: number;
  readonly metadataBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneObject(value: JsonObject): JsonObject {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new McpError("MCP tool metadata를 복제하지 못했습니다.");
  const cloned = JSON.parse(serialized) as unknown;
  if (!isRecord(cloned)) throw new McpError("MCP tool metadata 복제 결과가 올바르지 않습니다.");
  return cloned as JsonObject;
}

function freezeJson(value: JsonValue): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Array.isArray(value) ? value : Object.values(value)) freezeJson(child);
  Object.freeze(value);
}

function boundedDescription(value: unknown, serverName: string, toolName: string): string {
  const fallback = `MCP tool ${serverName}.${toolName}`;
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") return fallback;
  const sanitized = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "�");
  const bytes = Buffer.from(sanitized, "utf8");
  if (bytes.byteLength <= MAX_DESCRIPTION_BYTES) return sanitized;
  let end = MAX_DESCRIPTION_BYTES - Buffer.byteLength("…", "utf8");
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}…`;
}

function validToolName(value: unknown): value is string {
  return typeof value === "string" &&
    [...value].length >= 1 &&
    [...value].length <= 128 &&
    Buffer.byteLength(value, "utf8") <= 512 &&
    /^[A-Za-z0-9_.-]+$/u.test(value);
}

function cursorValue(value: JsonValue | undefined, serverName: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "string" ||
    [...value].length > MAX_CURSOR_CODE_POINTS ||
    Buffer.byteLength(value, "utf8") > MAX_CURSOR_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new McpError(`MCP tools/list cursor가 올바르지 않습니다: ${serverName}`);
  }
  return value;
}

function metadataBytes(value: JsonObject, serverName: string): number {
  let serialized: string;
  try {
    const candidate = JSON.stringify(value);
    if (candidate === undefined) throw new Error("undefined JSON");
    serialized = candidate;
  } catch (error) {
    throw new McpError(`MCP tool metadata를 직렬화하지 못했습니다: ${serverName}`, { cause: error });
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_TOOL_METADATA_BYTES) {
    throw new McpError(`MCP tool metadata가 ${MAX_TOOL_METADATA_BYTES} bytes 제한을 초과했습니다: ${serverName}`);
  }
  return bytes;
}

function optionalObject(value: JsonValue | undefined): Readonly<JsonObject> | undefined {
  if (value === undefined || !isRecord(value)) return undefined;
  const cloned = cloneObject(value as JsonObject);
  freezeJson(cloned);
  return cloned;
}

export async function discoverMcpTools(
  serverName: string,
  adapter: McpProtocolAdapter,
  signal?: AbortSignal,
): Promise<McpDiscoveryResult> {
  const tools: McpDiscoveredTool[] = [];
  const notices: string[] = [];
  const names = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let totalBytes = 0;
  let totalEntries = 0;

  const notice = (message: string): void => {
    if (notices.length < MAX_DISCOVERY_NOTICES) notices.push(message);
  };

  for (let page = 0; page < MCP_MAX_DISCOVERY_PAGES; page += 1) {
    const result = await adapter.listToolsPage(cursor, signal);
    if (!Array.isArray(result.tools)) {
      throw new McpError(`MCP tools/list 응답에 tools 배열이 없습니다: ${serverName}`);
    }
    totalEntries += result.tools.length;
    if (totalEntries > MCP_MAX_DISCOVERED_TOOLS) {
      throw new McpError(`MCP discovery가 ${MCP_MAX_DISCOVERED_TOOLS}개 도구 제한을 초과했습니다: ${serverName}`);
    }
    for (const [index, value] of result.tools.entries()) {
      if (!isRecord(value)) {
        notice(`${serverName} tools/list page ${page + 1} index ${index}: 객체가 아니라 제외했습니다.`);
        continue;
      }
      const raw = value as JsonObject;
      totalBytes += metadataBytes(raw, serverName);
      if (totalBytes > MAX_DISCOVERY_METADATA_BYTES) {
        throw new McpError(
          `MCP discovery metadata가 ${MAX_DISCOVERY_METADATA_BYTES} bytes 제한을 초과했습니다: ${serverName}`,
        );
      }
      const toolName = raw.name;
      if (!validToolName(toolName)) {
        notice(`${serverName} tools/list page ${page + 1} index ${index}: tool 이름이 올바르지 않아 제외했습니다.`);
        continue;
      }
      if (names.has(toolName)) {
        notice(`${serverName}.${toolName}: 같은 server의 중복 tool 이름이라 제외했습니다.`);
        continue;
      }
      names.add(toolName);
      const schemaIssues: string[] = [];
      if (raw.inputSchema !== undefined && !isRecord(raw.inputSchema)) {
        schemaIssues.push("inputSchema가 객체가 아닙니다");
      }
      if (raw.outputSchema !== undefined && !isRecord(raw.outputSchema)) {
        schemaIssues.push("outputSchema가 객체가 아닙니다");
      }
      if (raw.annotations !== undefined && !isRecord(raw.annotations)) {
        notice(`${serverName}.${toolName}: annotations가 객체가 아니라 무시합니다.`);
      }
      const inputSchema = optionalObject(raw.inputSchema);
      const outputSchema = optionalObject(raw.outputSchema);
      const annotations = optionalObject(raw.annotations);
      const schemaIssue = schemaIssues.length === 0 ? undefined : schemaIssues.join(", ");
      tools.push(Object.freeze({
        serverName,
        protocolVersion: adapter.version,
        toolName,
        description: boundedDescription(raw.description, serverName, toolName),
        ...(inputSchema === undefined ? {} : { inputSchema }),
        ...(outputSchema === undefined ? {} : { outputSchema }),
        ...(annotations === undefined ? {} : { annotations }),
        ...(schemaIssue === undefined ? {} : { schemaIssue }),
      }));
    }
    const next = cursorValue(result.nextCursor, serverName);
    if (next === undefined) {
      return Object.freeze({
        tools: Object.freeze(tools),
        notices: Object.freeze(notices),
        pages: page + 1,
        metadataBytes: totalBytes,
      });
    }
    if (cursors.has(next) || next === cursor) {
      throw new McpError(`MCP tools/list cursor가 반복되었습니다: ${serverName}`);
    }
    cursors.add(next);
    cursor = next;
  }
  throw new McpError(`MCP tools/list가 ${MCP_MAX_DISCOVERY_PAGES}페이지 제한을 초과했습니다: ${serverName}`);
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/gu, "_").replace(/^_+|_+$/gu, "");
  return normalized || "unnamed";
}

function baseApiName(tool: McpDiscoveredTool): string {
  return `mcp__${slug(tool.serverName)}__${slug(tool.toolName)}`.slice(0, API_NAME_MAX_LENGTH);
}

function digestName(tool: McpDiscoveredTool, base: string, salt = ""): string {
  const digest = createHash("sha256")
    .update(tool.serverName, "utf8")
    .update("\0", "utf8")
    .update(tool.toolName, "utf8")
    .update("\0", "utf8")
    .update(salt, "utf8")
    .digest("hex")
    .slice(0, API_NAME_HASH_LENGTH);
  return `${base.slice(0, API_NAME_MAX_LENGTH - API_NAME_HASH_LENGTH - 1)}_${digest}`;
}

function compareText(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const difference = (leftPoints[index]?.codePointAt(0) ?? 0) -
      (rightPoints[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

export function namespaceMcpTools(
  tools: readonly McpDiscoveredTool[],
  reservedNames: ReadonlySet<string> = new Set(),
): readonly McpNamespacedTool[] {
  const entries = tools.map((tool) => ({ tool, base: baseApiName(tool) }));
  const counts = new Map<string, number>();
  const identities = new Set<string>();
  for (const entry of entries) counts.set(entry.base, (counts.get(entry.base) ?? 0) + 1);
  for (const entry of entries) {
    const identity = `${entry.tool.serverName}\0${entry.tool.toolName}`;
    if (identities.has(identity)) {
      throw new McpError(`MCP tool identity가 중복되었습니다: ${entry.tool.serverName}.${entry.tool.toolName}`);
    }
    identities.add(identity);
  }
  const used = new Set(reservedNames);
  const output: McpNamespacedTool[] = [];
  const ordered = [...entries].sort((left, right) =>
    compareText(left.tool.serverName, right.tool.serverName) ||
    compareText(left.tool.toolName, right.tool.toolName)
  );
  for (const entry of ordered) {
    let apiName = counts.get(entry.base) === 1 && !used.has(entry.base)
      ? entry.base
      : digestName(entry.tool, entry.base);
    let salt = 0;
    while (used.has(apiName)) {
      salt += 1;
      if (salt > 16) throw new McpError("고유한 MCP tool namespace를 만들 수 없습니다.");
      apiName = digestName(entry.tool, entry.base, String(salt));
    }
    used.add(apiName);
    output.push(Object.freeze({ ...entry.tool, apiName }));
  }
  return Object.freeze(output);
}

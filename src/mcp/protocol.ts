import type { JsonObject, JsonValue } from "../core/json.js";
import { PRODUCT_NAME, VERSION } from "../core/version.js";
import { McpError } from "./errors.js";
import type { McpStdioTransport } from "./stdio-transport.js";

export const MCP_LEGACY_PROTOCOL_VERSION = "2025-11-25";
export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28";

export const MCP_PROTOCOL_VERSIONS = Object.freeze([
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_MODERN_PROTOCOL_VERSION,
] as const);

export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];

export interface McpServerProtocolInfo {
  readonly protocolVersion: McpProtocolVersion;
  readonly serverInfo: Readonly<JsonObject>;
  readonly capabilities: Readonly<JsonObject>;
}

export interface McpProtocolAdapter {
  readonly version: McpProtocolVersion;
  connect(signal?: AbortSignal): Promise<void>;
  request(method: string, params?: JsonObject, signal?: AbortSignal): Promise<JsonObject>;
  listToolsPage(cursor?: string, signal?: AbortSignal): Promise<JsonObject>;
  callTool(name: string, args: JsonObject, signal?: AbortSignal): Promise<JsonObject>;
  info(): McpServerProtocolInfo;
  connected(): boolean;
  close(reason?: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonObject(value: JsonValue, label: string): JsonObject {
  if (!isRecord(value)) throw new McpError(`${label}은 JSON 객체여야 합니다.`);
  return value as JsonObject;
}

function cloneObject(value: JsonObject): JsonObject {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new McpError("MCP JSON 객체를 복제하지 못했습니다.");
  const cloned = JSON.parse(serialized) as unknown;
  if (!isRecord(cloned)) throw new McpError("MCP JSON 객체 복제 결과가 올바르지 않습니다.");
  return cloned as JsonObject;
}

function freezeJson(value: JsonValue): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Array.isArray(value) ? value : Object.values(value)) freezeJson(child);
  Object.freeze(value);
}

function frozenObject(value: JsonObject): Readonly<JsonObject> {
  const cloned = cloneObject(value);
  freezeJson(cloned);
  return cloned;
}

function displayObject(value: JsonValue | undefined): JsonObject {
  return value !== undefined && isRecord(value) ? cloneObject(value as JsonObject) : {};
}

function validateToolName(name: string): void {
  if (
    !name ||
    [...name].length > 128 ||
    Buffer.byteLength(name, "utf8") > 512 ||
    !/^[A-Za-z0-9_.-]+$/u.test(name)
  ) {
    throw new McpError("MCP tool 이름이 올바르지 않습니다.");
  }
}

abstract class BaseMcpProtocolAdapter implements McpProtocolAdapter {
  abstract readonly version: McpProtocolVersion;
  readonly transport: McpStdioTransport;
  protected serverInfo: JsonObject = {};
  protected capabilities: JsonObject = {};

  constructor(transport: McpStdioTransport) {
    this.transport = transport;
  }

  abstract connect(signal?: AbortSignal): Promise<void>;
  abstract request(method: string, params?: JsonObject, signal?: AbortSignal): Promise<JsonObject>;

  async listToolsPage(cursor?: string, signal?: AbortSignal): Promise<JsonObject> {
    return await this.request(
      "tools/list",
      cursor === undefined ? {} : { cursor },
      signal,
    );
  }

  async callTool(name: string, args: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
    validateToolName(name);
    return await this.request("tools/call", { name, arguments: args }, signal);
  }

  info(): McpServerProtocolInfo {
    return Object.freeze({
      protocolVersion: this.version,
      serverInfo: frozenObject(this.serverInfo),
      capabilities: frozenObject(this.capabilities),
    });
  }

  connected(): boolean {
    return this.transport.connected();
  }

  async close(reason = "protocol adapter closed"): Promise<void> {
    await this.transport.close(reason);
  }
}

export class LegacyMcpProtocolAdapter extends BaseMcpProtocolAdapter {
  readonly version = MCP_LEGACY_PROTOCOL_VERSION;
  #initialized = false;

  override async connect(signal?: AbortSignal): Promise<void> {
    if (this.#initialized && this.transport.connected()) return;
    await this.transport.start(signal);
    try {
      const result = jsonObject(
        await this.transport.request(
          "initialize",
          {
            protocolVersion: this.version,
            capabilities: {},
            clientInfo: { name: PRODUCT_NAME, version: VERSION },
          },
          signal,
        ),
        `MCP initialize 응답 (${this.transport.serverName})`,
      );
      if (result.protocolVersion !== this.version) {
        throw new McpError(
          `MCP 서버가 선택한 legacy protocol과 다른 버전을 반환했습니다: ` +
            `${String(result.protocolVersion)} (요청 ${this.version})`,
        );
      }
      const capabilities = result.capabilities;
      if (!isRecord(capabilities)) {
        throw new McpError(`MCP initialize capabilities가 올바르지 않습니다: ${this.transport.serverName}`);
      }
      if (!isRecord(capabilities.tools)) {
        throw new McpError(`MCP 서버가 tools capability를 선언하지 않았습니다: ${this.transport.serverName}`);
      }
      const serverInfo = result.serverInfo;
      if (serverInfo !== undefined && !isRecord(serverInfo)) {
        throw new McpError(`MCP initialize serverInfo가 올바르지 않습니다: ${this.transport.serverName}`);
      }
      this.capabilities = cloneObject(capabilities as JsonObject);
      this.serverInfo = displayObject(serverInfo as JsonValue | undefined);
      await this.transport.notify("notifications/initialized", {}, signal);
      this.#initialized = true;
    } catch (error) {
      this.#initialized = false;
      await this.transport.close("legacy initialization failed").catch(() => undefined);
      throw error;
    }
  }

  override async request(
    method: string,
    params: JsonObject = {},
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    if (!this.#initialized || !this.transport.connected()) {
      throw new McpError(`Legacy MCP initialize가 완료되지 않았습니다: ${this.transport.serverName}`);
    }
    return jsonObject(
      await this.transport.request(method, params, signal),
      `MCP ${method} 응답 (${this.transport.serverName})`,
    );
  }

  override async close(reason = "legacy adapter closed"): Promise<void> {
    this.#initialized = false;
    await super.close(reason);
  }
}

const MODERN_PROTOCOL_KEY = "io.modelcontextprotocol/protocolVersion";
const MODERN_CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";
const MODERN_CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const MODERN_SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";

function modernParams(params: JsonObject): JsonObject {
  if (params._meta !== undefined && !isRecord(params._meta)) {
    throw new McpError("Modern MCP 요청의 _meta는 객체여야 합니다.");
  }
  const metadata = params._meta === undefined
    ? {}
    : cloneObject(params._meta as JsonObject);
  metadata[MODERN_PROTOCOL_KEY] = MCP_MODERN_PROTOCOL_VERSION;
  metadata[MODERN_CLIENT_INFO_KEY] = { name: PRODUCT_NAME, version: VERSION };
  metadata[MODERN_CLIENT_CAPABILITIES_KEY] = {};
  return { ...cloneObject(params), _meta: metadata };
}

function validateModernResult(result: JsonObject, method: string, serverName: string): JsonObject {
  const resultType = result.resultType;
  if (resultType !== undefined && resultType !== "complete") {
    throw new McpError(
      `지원하지 않는 modern MCP resultType입니다 (${serverName}.${method}): ${String(resultType)}`,
    );
  }
  const metadata = result._meta;
  if (metadata !== undefined && !isRecord(metadata)) {
    throw new McpError(`Modern MCP 응답 _meta가 올바르지 않습니다: ${serverName}.${method}`);
  }
  return result;
}

export class ModernMcpProtocolAdapter extends BaseMcpProtocolAdapter {
  readonly version = MCP_MODERN_PROTOCOL_VERSION;
  #started = false;

  override async connect(signal?: AbortSignal): Promise<void> {
    if (this.#started && this.transport.connected()) return;
    await this.transport.start(signal);
    this.#started = true;
  }

  override async request(
    method: string,
    params: JsonObject = {},
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    if (!this.#started || !this.transport.connected()) {
      throw new McpError(`Modern MCP stdio transport가 시작되지 않았습니다: ${this.transport.serverName}`);
    }
    const result = validateModernResult(
      jsonObject(
        await this.transport.request(method, modernParams(params), signal),
        `Modern MCP ${method} 응답 (${this.transport.serverName})`,
      ),
      method,
      this.transport.serverName,
    );
    const metadata = result._meta;
    if (isRecord(metadata) && isRecord(metadata[MODERN_SERVER_INFO_KEY])) {
      this.serverInfo = cloneObject(metadata[MODERN_SERVER_INFO_KEY] as JsonObject);
    }
    return result;
  }

  override async close(reason = "modern adapter closed"): Promise<void> {
    this.#started = false;
    await super.close(reason);
  }
}

export function createMcpProtocolAdapter(
  version: McpProtocolVersion,
  transport: McpStdioTransport,
): McpProtocolAdapter {
  if (version === MCP_LEGACY_PROTOCOL_VERSION) {
    return new LegacyMcpProtocolAdapter(transport);
  }
  if (version === MCP_MODERN_PROTOCOL_VERSION) {
    return new ModernMcpProtocolAdapter(transport);
  }
  throw new McpError(`지원하지 않는 MCP protocol version입니다: ${String(version)}`);
}

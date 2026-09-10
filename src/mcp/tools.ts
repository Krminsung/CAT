import type { JsonObject, JsonValue } from "../core/json.js";
import type { ToolExecutionResult } from "../core/tools.js";
import {
  type ToolPreflightResult,
  type ToolRegistry,
} from "../tools/runtime.js";
import {
  createMcpServerConfig,
  type McpConfigScope,
  type McpConfigurationSnapshot,
  type McpConfigStore,
  type McpExecutionPlan,
  type McpServerConfig,
} from "./config.js";
import { McpError } from "./errors.js";
import type { McpManager, McpServerStatus } from "./manager.js";
import { MCP_PROTOCOL_VERSIONS } from "./protocol.js";

const MANAGEMENT_OUTPUT_BYTES = 512 * 1024;
const MCP_SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

function objectSchema(properties: JsonObject, required: readonly string[]): JsonObject {
  return {
    type: "object",
    properties,
    required: [...required],
    additionalProperties: false,
  };
}

function stringSchema(description: string, maximum: number): JsonObject {
  return { type: "string", description, minLength: 1, maxLength: maximum };
}

function success(content: JsonValue): ToolExecutionResult {
  return { status: "success", output: { content, truncated: false } };
}

function failure(
  code: string,
  message: string,
  execution: "not_started" | "failed" | "unknown",
  details?: JsonValue,
): ToolExecutionResult {
  return {
    status: "failure",
    error: { code, message, retryable: false, ...(details === undefined ? {} : { details }) },
    execution,
  };
}

function scopeValue(value: JsonValue | undefined): McpConfigScope {
  if (value !== "user" && value !== "project" && value !== "local") {
    throw new McpError("MCP 설정 scope는 user, project, local 중 하나여야 합니다.");
  }
  return value;
}

function requiredText(input: JsonObject, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || !value) throw new McpError(`${name} 문자열 인자가 필요합니다.`);
  return value;
}

function serverName(input: JsonObject): string {
  const value = requiredText(input, "name");
  if (!MCP_SERVER_NAME_PATTERN.test(value)) {
    throw new McpError(`MCP 서버 이름이 올바르지 않습니다: ${value}`);
  }
  return value;
}

function environmentConfig(value: JsonValue | undefined): JsonObject | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new McpError("environment는 secret 참조 배열이어야 합니다.");
  const output = Object.create(null) as JsonObject;
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new McpError("environment 항목은 target/source 객체여야 합니다.");
    }
    const target = item.target;
    const source = item.source;
    if (typeof target !== "string" || typeof source !== "string") {
      throw new McpError("environment target/source는 문자열이어야 합니다.");
    }
    if (Object.hasOwn(output, target)) throw new McpError(`environment target이 중복됐습니다: ${target}`);
    output[target] = { source: "environment", name: source };
  }
  return output;
}

function saveConfig(input: JsonObject): { readonly scope: McpConfigScope; readonly config: McpServerConfig } {
  if (input.action !== "save") throw new McpError("MCP 저장 action이 올바르지 않습니다.");
  const args = input.args;
  if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) {
    throw new McpError("args는 문자열 배열이어야 합니다.");
  }
  const protocolVersion = input.protocol_version;
  if (
    typeof protocolVersion !== "string" ||
    !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(protocolVersion)
  ) {
    throw new McpError("protocol_version이 지원 범위를 벗어났습니다.");
  }
  if (input.disabled !== undefined && typeof input.disabled !== "boolean") {
    throw new McpError("disabled는 boolean이어야 합니다.");
  }
  const environment = environmentConfig(input.environment);
  const raw: JsonObject = {
    command: requiredText(input, "command"),
    args: args as string[],
    protocolVersion,
    disabled: input.disabled === true,
    ...(input.cwd === undefined ? {} : { cwd: requiredText(input, "cwd") }),
    ...(environment === undefined ? {} : { env: environment }),
  };
  return Object.freeze({
    scope: scopeValue(input.scope),
    config: createMcpServerConfig(requiredText(input, "name"), raw),
  });
}

function assertReconnectInput(input: JsonObject): void {
  if (input.action !== "reconnect" || Object.keys(input).some((key) => key !== "action")) {
    throw new McpError("MCP reconnect에는 action: reconnect만 지정해야 합니다.");
  }
}

function statusJson(status: McpServerStatus): JsonObject {
  return {
    name: status.name,
    command: status.command,
    args: [...status.args],
    configured_cwd: status.configuredCwd,
    resolved_cwd: status.resolvedCwd,
    environment_references: { ...status.environmentReferences },
    protocol_version: status.protocolVersion,
    state: status.state,
    server: status.serverDisplayName,
    active_tools: status.activeTools,
    disabled_tools: status.disabledTools,
    error: status.error,
    config_version: status.configVersion,
  };
}

function statusContent(manager: McpManager): JsonObject {
  const servers = manager.statuses().map(statusJson);
  return {
    servers,
    count: servers.length,
    notices: [...manager.notices()],
  };
}

function expectedText(preflight: ToolPreflightResult, key: string): string {
  const value = preflight.approvalScope.target[key];
  if (typeof value !== "string") throw new McpError(`MCP 승인 scope의 ${key} 값이 없습니다.`);
  return value;
}

async function reconnectPreflight(
  store: McpConfigStore,
  manager: McpManager,
): Promise<{
  readonly snapshot: McpConfigurationSnapshot;
  readonly plan: McpExecutionPlan;
  readonly result: ToolPreflightResult;
}> {
  const snapshot = await store.snapshot();
  const plan = await manager.prepareExecutionPlan(snapshot.configs);
  const active = snapshot.configs.filter((config) => !config.disabled);
  const details = active.map((config) => {
    const target = plan.targets.find((item) => item.name === config.name);
    const cwd = target?.cwd;
    const path = typeof cwd === "object" && cwd !== null && !Array.isArray(cwd) && typeof cwd.path === "string"
      ? cwd.path
      : config.cwd ?? ".";
    return `${config.name}: ${JSON.stringify([config.command, ...config.args])} · cwd ${path} · ` +
      `${config.protocolVersion} · config ${config.configVersion}`;
  });
  const summary = `설정된 MCP stdio 서버 ${active.length}개 재연결` +
    (details.length === 0 ? "" : `\n${details.join("\n")}`);
  if (Buffer.byteLength(summary, "utf8") > 120 * 1024) {
    throw new McpError("MCP 재연결 실행 요약이 너무 큽니다. 서버 수 또는 command 인자를 줄여야 합니다.");
  }
  return Object.freeze({
    snapshot,
    plan,
    result: {
      summary,
      approvalScope: {
        kind: "external",
        target: {
          action: "reconnect",
          workspace: plan.workspace,
          settingsVersion: snapshot.version,
          executionVersion: plan.version,
          servers: plan.targets.map((target) => structuredClone(target) as JsonObject),
        },
      },
    },
  });
}

export function registerMcpManagementTools(
  registry: ToolRegistry,
  options: {
    readonly manager: McpManager;
    readonly store: McpConfigStore;
  },
): void {
  const { manager, store } = options;
  const reconnectPlans = new WeakMap<JsonObject, Awaited<ReturnType<typeof reconnectPreflight>>>();
  const layerApprovals = new WeakMap<JsonObject, { readonly path: string; readonly revision: string }>();

  registry.register({
    definition: {
      name: "list_mcp_servers",
      description: "List configured MCP servers, live connection state, and enabled or disabled dynamic tool counts.",
      inputSchema: objectSchema({}, []),
      category: "read",
      permission: { kind: "none" },
      outputLimitBytes: MANAGEMENT_OUTPUT_BYTES,
      handler: async () => success(statusContent(manager)),
    },
  });

  registry.register({
    definition: {
      name: "add_mcp_server",
      description: "Save one stdio MCP server configuration, closing stale live connections without starting the new configuration, or explicitly reconnect all saved servers. Environment credentials must be references to host environment variable names, never inline secret values.",
      inputSchema: objectSchema(
        {
          action: { type: "string", enum: ["save", "reconnect"] },
          name: stringSchema("Lowercase MCP server name", 64),
          command: stringSchema("Exact executable without a shell", 4_096),
          args: {
            type: "array",
            items: { type: "string", maxLength: 32_768 },
            maxItems: 256,
          },
          scope: { type: "string", enum: ["user", "project", "local"] },
          protocol_version: { type: "string", enum: [...MCP_PROTOCOL_VERSIONS] },
          cwd: stringSchema("Workspace-contained working directory", 4_096),
          disabled: { type: "boolean" },
          environment: {
            type: "array",
            maxItems: 64,
            items: objectSchema(
              {
                target: stringSchema("Child environment variable name", 256),
                source: stringSchema("Host environment variable name containing the secret", 256),
              },
              ["target", "source"],
            ),
          },
        },
        ["action"],
      ),
      category: "external",
      permission: { kind: "external", service: "mcp:configuration" },
      outputLimitBytes: MANAGEMENT_OUTPUT_BYTES,
      handler: async (input, context): Promise<ToolExecutionResult> => {
        if (input.action === "reconnect") {
          try {
            assertReconnectInput(input);
            const approved = reconnectPlans.get(input);
            reconnectPlans.delete(input);
            if (!approved) throw new McpError("검증된 MCP 실행 계획이 없습니다.");
            const current = await reconnectPreflight(store, manager);
            if (
              JSON.stringify(current.result.approvalScope.target) !==
                JSON.stringify(approved.result.approvalScope.target)
            ) {
              throw new McpError("승인 직후 MCP 실행 설정 또는 cwd identity가 변경됐습니다.");
            }
            await manager.reconfigure(structuredClone(current.snapshot.raw) as JsonObject);
            const statuses = await manager.reconnect(current.plan, context.signal);
            return success({
              action: "reconnect",
              servers: statuses.map(statusJson),
              notices: [...manager.notices()],
            });
          } catch (error) {
            return failure(
              context.signal.aborted ? "mcp_reconnect_cancelled" : "mcp_reconnect_failed",
              context.signal.aborted
                ? "MCP 재연결을 취소했습니다. 시작됐던 소유 process는 종료를 시도했습니다."
                : error instanceof Error
                  ? error.message
                  : "MCP 재연결에 실패했습니다.",
              "unknown",
            );
          }
        }
        let selected: ReturnType<typeof saveConfig>;
        try {
          selected = saveConfig(input);
          manager.assertConfiguration(selected.config);
          await manager.assertWorkspaceCurrent();
        } catch (error) {
          return failure(
            "mcp_configuration_invalid",
            error instanceof Error ? error.message : "MCP 설정이 올바르지 않습니다.",
            "not_started",
          );
        }
        const approvedLayer = layerApprovals.get(input);
        layerApprovals.delete(input);
        if (!approvedLayer) {
          return failure("mcp_configuration_not_validated", "검증된 MCP 설정 저장 대상이 없습니다.", "not_started");
        }
        let path: string;
        try {
          path = await store.upsert(selected.scope, selected.config, approvedLayer.revision);
        } catch (error) {
          return failure(
            "mcp_configuration_save_failed",
            error instanceof Error ? error.message : "MCP 설정을 저장하지 못했습니다.",
            "not_started",
          );
        }
        try {
          const snapshot = await store.snapshot();
          await manager.reconfigure(structuredClone(snapshot.raw) as JsonObject);
          return success({
            action: "save",
            server: selected.config.name,
            scope: selected.scope,
            path,
            config_version: selected.config.configVersion,
            started: false,
            stale_connections_closed: true,
            next: "사용자가 명시적으로 /mcp reconnect를 실행한 뒤 중앙 승인을 완료해야 시작됩니다.",
          });
        } catch (error) {
          const cleanup = await manager.disconnect("MCP configuration reload failed").catch((closeError) => ({
            complete: false,
            failures: [closeError instanceof Error ? closeError.message : "알 수 없는 종료 오류"],
          }));
          return failure(
            "mcp_configuration_saved_reload_failed",
            "MCP 설정은 저장했지만 현재 manager에 다시 읽지 못했습니다.",
            cleanup.complete ? "failed" : "unknown",
            {
              path,
              error: error instanceof Error ? error.message : "알 수 없는 오류",
              connections_closed: cleanup.complete,
              close_failures: [...cleanup.failures],
            },
          );
        }
      },
    },
    preflight: async (input) => {
      if (input.action === "reconnect") {
        assertReconnectInput(input);
        const prepared = await reconnectPreflight(store, manager);
        reconnectPlans.set(input, prepared);
        return prepared.result;
      }
      const selected = saveConfig(input);
      manager.assertConfiguration(selected.config);
      await manager.assertWorkspaceCurrent();
      const layer = await store.layerRevision(selected.scope);
      layerApprovals.set(input, layer);
      return {
        summary: `MCP 서버 설정 저장(기존 MCP 연결 종료, 새 실행 안 함): ${selected.config.name} · ` +
          `${selected.config.command} · 인자 ${selected.config.args.length}개 · ${selected.scope}`,
        approvalScope: {
          kind: "external",
          target: {
            action: "save",
            server: selected.config.name,
            scope: selected.scope,
            path: layer.path,
            layerRevision: layer.revision,
            configVersion: selected.config.configVersion,
          },
        },
      };
    },
    revalidate: async (input, _context, preflight) => {
      if (input.action === "reconnect") {
        assertReconnectInput(input);
        const approved = reconnectPlans.get(input);
        if (!approved) throw new McpError("승인 전 MCP 실행 계획이 없습니다.");
        const current = await reconnectPreflight(store, manager);
        if (
          JSON.stringify(current.result.approvalScope.target) !==
            JSON.stringify(preflight.approvalScope.target)
        ) {
          throw new McpError("승인 대기 중 MCP 실행 설정, secret 참조 값 또는 cwd identity가 변경됐습니다.");
        }
        reconnectPlans.set(input, current);
        return;
      }
      const selected = saveConfig(input);
      manager.assertConfiguration(selected.config);
      await manager.assertWorkspaceCurrent();
      const current = await store.layerRevision(selected.scope);
      if (current.revision !== expectedText(preflight, "layerRevision")) {
        throw new McpError("승인 대기 중 MCP 설정 파일이 변경됐습니다.");
      }
      layerApprovals.set(input, current);
    },
  });

  registry.register({
    definition: {
      name: "remove_mcp_server",
      description: "Remove one MCP server from an exact settings scope, close stale live connections, and do not start another server.",
      inputSchema: objectSchema(
        {
          name: stringSchema("Lowercase configured MCP server name", 64),
          scope: { type: "string", enum: ["user", "project", "local"] },
        },
        ["name", "scope"],
      ),
      category: "external",
      permission: { kind: "external", service: "mcp:configuration" },
      outputLimitBytes: MANAGEMENT_OUTPUT_BYTES,
      handler: async (input): Promise<ToolExecutionResult> => {
        const name = serverName(input);
        const scope = scopeValue(input.scope);
        try {
          await manager.assertWorkspaceCurrent();
        } catch (error) {
          return failure(
            "mcp_workspace_changed",
            error instanceof Error ? error.message : "MCP workspace identity가 변경됐습니다.",
            "not_started",
          );
        }
        const approvedLayer = layerApprovals.get(input);
        layerApprovals.delete(input);
        if (!approvedLayer) {
          return failure("mcp_configuration_not_validated", "검증된 MCP 설정 제거 대상이 없습니다.", "not_started");
        }
        let result: Awaited<ReturnType<McpConfigStore["remove"]>>;
        try {
          result = await store.remove(scope, name, approvedLayer.revision);
        } catch (error) {
          return failure(
            "mcp_configuration_remove_failed",
            error instanceof Error ? error.message : "MCP 설정을 제거하지 못했습니다.",
            "not_started",
          );
        }
        if (!result.removed) {
          return failure("mcp_server_not_found", `${scope} scope에서 MCP 서버를 찾을 수 없습니다: ${name}`, "not_started");
        }
        try {
          const snapshot = await store.snapshot();
          await manager.reconfigure(structuredClone(snapshot.raw) as JsonObject);
          return success({
            action: "remove",
            server: name,
            scope,
            path: result.path,
            removed: true,
            stale_connections_closed: true,
          });
        } catch (error) {
          const cleanup = await manager.disconnect("MCP configuration reload failed").catch((closeError) => ({
            complete: false,
            failures: [closeError instanceof Error ? closeError.message : "알 수 없는 종료 오류"],
          }));
          return failure(
            "mcp_configuration_removed_reload_failed",
            "MCP 설정은 제거했지만 현재 manager에 다시 읽지 못했습니다.",
            cleanup.complete ? "failed" : "unknown",
            {
              path: result.path,
              error: error instanceof Error ? error.message : "알 수 없는 오류",
              connections_closed: cleanup.complete,
              close_failures: [...cleanup.failures],
            },
          );
        }
      },
    },
    preflight: async (input) => {
      const name = serverName(input);
      const scope = scopeValue(input.scope);
      await manager.assertWorkspaceCurrent();
      const layer = await store.layerRevision(scope);
      layerApprovals.set(input, layer);
      return {
        summary: `MCP 서버 설정 제거(기존 MCP 연결 종료, 다른 서버 실행 안 함): ${name} · ${scope}`,
        approvalScope: {
          kind: "external",
          target: {
            action: "remove",
            server: name,
            scope,
            path: layer.path,
            layerRevision: layer.revision,
          },
        },
      };
    },
    revalidate: async (input, _context, preflight) => {
      await manager.assertWorkspaceCurrent();
      const current = await store.layerRevision(scopeValue(input.scope));
      if (current.revision !== expectedText(preflight, "layerRevision")) {
        throw new McpError("승인 대기 중 MCP 설정 파일이 변경됐습니다.");
      }
      layerApprovals.set(input, current);
    },
  });
}

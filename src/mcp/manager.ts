import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "../core/json.js";
import type { ToolExecutionResult } from "../core/tools.js";
import { PermissionDeniedError } from "../core/errors.js";
import { Redactor } from "../security/redaction.js";
import {
  workspaceIdentity,
  type WorkspaceIdentity,
} from "../security/trust.js";
import {
  BUILTIN_TOOL_NAMES,
  type McpToolRegistration,
  type ToolRegistry,
} from "../tools/runtime.js";
import {
  assertMcpConfigSecretSeparation,
  mcpConfigContainsSecret,
  mcpConfigurationVersion,
  mcpModelCredentialValues,
  parseMcpServerConfigs,
  prepareMcpExecutionPlan,
  revalidateMcpCwd,
  type McpExecutionPlan,
  type McpServerConfig,
  type ResolvedMcpCwd,
} from "./config.js";
import {
  discoverMcpTools,
  namespaceMcpTools,
  type McpDiscoveredTool,
} from "./discovery.js";
import { McpError } from "./errors.js";
import {
  createMcpProtocolAdapter,
  type McpProtocolAdapter,
} from "./protocol.js";
import {
  prepareMcpTool,
  type PreparedMcpTool,
} from "./schema.js";
import { McpStdioTransport } from "./stdio-transport.js";

export type McpServerRuntimeState = "configured" | "disabled" | "connecting" | "connected" | "failed";

export interface McpServerStatus {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly configuredCwd: string;
  readonly resolvedCwd: string;
  readonly environmentReferences: Readonly<Record<string, string>>;
  readonly protocolVersion: string;
  readonly state: McpServerRuntimeState;
  readonly serverDisplayName: string;
  readonly activeTools: number;
  readonly disabledTools: number;
  readonly error: string;
  readonly configVersion: string;
}

export interface McpManagerCloseResult {
  readonly complete: boolean;
  readonly failures: readonly string[];
}

interface McpConnection {
  readonly config: McpServerConfig;
  readonly adapter: McpProtocolAdapter;
  readonly cwd: ResolvedMcpCwd;
  readonly environmentVersion: string;
  readonly generation: number;
}

interface MutableServerStatus {
  state: McpServerRuntimeState;
  serverDisplayName: string;
  activeTools: number;
  disabledTools: number;
  error: string;
}

const MAX_ACTIVE_MCP_TOOLS = 100;
const MAX_MANAGER_DISCOVERED_TOOLS = 10_000;
const MAX_MANAGER_DISCOVERY_BYTES = 32 * 1024 * 1024;
const MAX_MANAGER_NOTICES = 256;
const MAX_STATUS_TEXT_BYTES = 4_096;
const MCP_TOOL_OUTPUT_BYTES = 1024 * 1024;
const MCP_RECONNECT_TIMEOUT_MS = 5 * 60_000;
const SENSITIVE_OUTPUT_FIELD = /(?:^|[_ -])(?:api[_ -]?key|authorization|cookies?|password|passwd|secrets?|tokens?|credentials?|private[_ -]?key)(?:$|[_ -])/iu;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new McpError("MCP version 값을 직렬화하지 못했습니다.");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(",")}}`;
}

function digest(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function boundedText(value: string, maximumBytes = MAX_STATUS_TEXT_BYTES): string {
  const cleaned = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "�");
  const bytes = Buffer.from(cleaned, "utf8");
  if (bytes.byteLength <= maximumBytes) return cleaned;
  let end = maximumBytes - Buffer.byteLength("…", "utf8");
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}…`;
}

function redactJson(
  value: JsonValue,
  redactor: Redactor,
  state: { nodes: number } = { nodes: 0 },
  depth = 0,
): JsonValue {
  state.nodes += 1;
  if (state.nodes > 100_000 || depth > 64) return "[MCP 출력 구조 생략]";
  if (typeof value === "string") return redactor.redact(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactJson(item, redactor, state, depth + 1));
  }
  const result = Object.create(null) as JsonObject;
  for (const [key, child] of Object.entries(value)) {
    let safeKey = redactor.redact(key);
    if (Object.hasOwn(result, safeKey)) {
      safeKey = `[중복 redaction key ${Object.keys(result).length + 1}]`;
    }
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/gu, "$1_$2");
    result[safeKey] = SENSITIVE_OUTPUT_FIELD.test(normalizedKey)
      ? "[REDACTED]"
      : redactJson(child, redactor, state, depth + 1);
  }
  return result;
}

function registryVersion(
  connection: McpConnection,
  tools: readonly PreparedMcpTool[],
): string {
  return digest({
    configVersion: connection.config.configVersion,
    environmentVersion: connection.environmentVersion,
    cwd: {
      path: connection.cwd.path,
      device: String(connection.cwd.device),
      inode: String(connection.cwd.inode),
    },
    protocolVersion: connection.config.protocolVersion,
    toolVersions: tools.map((tool) => tool.toolVersion).sort(),
  });
}

function toolFailure(
  code: string,
  message: string,
  execution: "not_started" | "failed" | "unknown",
  details?: JsonValue,
): ToolExecutionResult {
  return {
    status: "failure",
    error: {
      code,
      message,
      retryable: false,
      ...(details === undefined ? {} : { details }),
    },
    execution,
  };
}

function initialStatus(config: McpServerConfig): MutableServerStatus {
  return {
    state: config.disabled ? "disabled" : "configured",
    serverDisplayName: "",
    activeTools: 0,
    disabledTools: 0,
    error: "",
  };
}

export class McpManager {
  readonly #registry: ToolRegistry;
  readonly #workspace: string;
  readonly #workspaceTrusted: boolean;
  readonly #workspaceIdentity: WorkspaceIdentity;
  readonly #environment: NodeJS.ProcessEnv;
  #registerSecrets: ((secrets: readonly string[]) => Promise<void>) | undefined;
  readonly #modelSecrets = new Set<string>();
  readonly #dynamicSecrets = new Set<string>();
  readonly #activeSecrets = new Set<string>();
  #configs: readonly McpServerConfig[];
  readonly #connections = new Map<string, McpConnection>();
  readonly #status = new Map<string, MutableServerStatus>();
  #notices: readonly string[] = Object.freeze([]);
  #generation = 0;
  #disposed = false;
  #shutdownResult: McpManagerCloseResult | undefined;

  constructor(options: {
    readonly registry: ToolRegistry;
    readonly workspace: string;
    readonly workspaceTrusted: boolean;
    readonly workspaceIdentity: WorkspaceIdentity;
    readonly environment: NodeJS.ProcessEnv;
    readonly rawConfigs?: JsonObject;
    readonly knownSecrets?: readonly string[];
  }) {
    this.#registry = options.registry;
    this.#workspace = options.workspace;
    this.#workspaceTrusted = options.workspaceTrusted;
    if (options.workspaceIdentity.canonicalPath !== options.workspace) {
      throw new McpError("MCP manager의 workspace identity가 현재 workspace와 다릅니다.");
    }
    this.#workspaceIdentity = Object.freeze({ ...options.workspaceIdentity });
    this.#environment = options.environment;
    for (const secret of [
      ...(options.knownSecrets ?? []),
      ...mcpModelCredentialValues(options.environment),
    ]) this.#modelSecrets.add(secret);
    this.#configs = parseMcpServerConfigs(options.rawConfigs);
    for (const config of this.#configs) {
      assertMcpConfigSecretSeparation(config, this.#modelSecrets);
    }
    this.#resetStatuses();
  }

  statuses(): readonly McpServerStatus[] {
    return Object.freeze(this.#configs.map((config) => {
      const current = this.#status.get(config.name) ?? initialStatus(config);
      const connection = this.#connections.get(config.name);
      const state = current.state === "connected" && !connection?.adapter.connected()
        ? "failed"
        : current.state;
      const error = state === "failed" && !current.error
        ? "MCP 서버 프로세스 연결이 종료되었습니다."
        : current.error;
      return Object.freeze({
        name: config.name,
        command: config.command,
        args: Object.freeze([...config.args]),
        configuredCwd: config.cwd ?? ".",
        resolvedCwd: connection?.cwd.path ?? "",
        environmentReferences: Object.freeze(Object.fromEntries(
          Object.entries(config.env).map(([target, reference]) => [target, reference.name]),
        )),
        protocolVersion: config.protocolVersion,
        state,
        serverDisplayName: current.serverDisplayName,
        activeTools: state === "connected" ? current.activeTools : 0,
        disabledTools: current.disabledTools,
        error,
        configVersion: config.configVersion,
      });
    }));
  }

  notices(): readonly string[] {
    return this.#notices;
  }

  setSecretRegistrar(registrar: (secrets: readonly string[]) => Promise<void>): void {
    this.#assertUsable();
    if (this.#connections.size > 0 || this.#registerSecrets !== undefined) {
      throw new McpError("MCP secret registrar는 process 시작 전에 한 번만 연결할 수 있습니다.");
    }
    this.#registerSecrets = registrar;
  }

  assertConfiguration(config: McpServerConfig): void {
    this.#assertUsable();
    assertMcpConfigSecretSeparation(config, this.#modelSecrets);
  }

  async prepareExecutionPlan(configs: readonly McpServerConfig[]): Promise<McpExecutionPlan> {
    this.#assertUsable();
    await this.assertWorkspaceCurrent();
    for (const config of configs) assertMcpConfigSecretSeparation(config, this.#modelSecrets);
    const plan = await prepareMcpExecutionPlan(
      this.#workspace,
      configs,
      this.#environment,
      this.#modelSecrets,
    );
    await this.assertWorkspaceCurrent();
    return plan;
  }

  async assertWorkspaceCurrent(): Promise<void> {
    this.#assertUsable();
    await this.#assertWorkspaceUnchanged();
  }

  async addModelCredentials(secrets: readonly string[]): Promise<void> {
    this.#assertUsable();
    const selected = [...new Set(secrets.filter((secret) => typeof secret === "string" && secret.length > 0))];
    const selectedSet = new Set(selected);
    const conflictsWithActiveMcp = selected.some((secret) =>
      [...this.#activeSecrets].some((activeSecret) => activeSecret.includes(secret))
    ) ||
      [...this.#connections.values()].some((connection) =>
        mcpConfigContainsSecret(connection.config, selectedSet)
      );
    for (const secret of selected) this.#modelSecrets.add(secret);
    if (!conflictsWithActiveMcp) return;
    const closed = await this.disconnect("model credential conflicts with active MCP secret");
    if (!closed.complete) {
      throw new McpError(`Model credential 충돌 뒤 MCP 연결을 모두 닫지 못했습니다: ${closed.failures.join("; ")}`);
    }
  }

  async reconfigure(rawConfigs: JsonObject | undefined): Promise<void> {
    this.#assertUsable();
    const next = parseMcpServerConfigs(rawConfigs);
    for (const config of next) assertMcpConfigSecretSeparation(config, this.#modelSecrets);
    const closed = await this.#disconnect("MCP configuration changed");
    if (!closed.complete) {
      throw new McpError(`기존 MCP 연결을 모두 닫지 못했습니다: ${closed.failures.join("; ")}`);
    }
    this.#configs = next;
    this.#notices = Object.freeze([]);
    this.#resetStatuses();
  }

  async disconnect(reason = "MCP session changed"): Promise<McpManagerCloseResult> {
    this.#assertUsable();
    const result = await this.#disconnect(reason);
    if (result.complete) {
      this.#notices = Object.freeze([]);
      this.#resetStatuses();
    }
    return result;
  }

  async reconnect(
    plan: McpExecutionPlan,
    signal?: AbortSignal,
  ): Promise<readonly McpServerStatus[]> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), MCP_RECONNECT_TIMEOUT_MS);
    timer.unref();
    const boundedSignal = signal === undefined
      ? deadline.signal
      : AbortSignal.any([signal, deadline.signal]);
    try {
      return await this.#reconnect(plan, boundedSignal);
    } catch (error) {
      if (deadline.signal.aborted && !signal?.aborted) {
        throw new McpError("MCP 재연결 전체 제한 시간이 초과되었습니다.", { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async #reconnect(
    plan: McpExecutionPlan,
    signal: AbortSignal,
  ): Promise<readonly McpServerStatus[]> {
    this.#assertUsable();
    if (!this.#workspaceTrusted) {
      throw new PermissionDeniedError("신뢰하지 않은 workspace에서는 MCP 서버를 시작할 수 없습니다.");
    }
    await this.#assertWorkspaceUnchanged();
    if (signal?.aborted) throw new McpError("MCP 재연결을 시작하기 전에 취소했습니다.");
    const executions = new Map(
      plan.executions.map((execution) => [execution.config.name, execution]),
    );
    const targets = new Map<string, Readonly<JsonObject>>();
    for (const target of plan.targets) {
      const name = target.name;
      if (typeof name !== "string" || targets.has(name)) {
        throw new McpError("승인된 MCP 실행 계획의 server target이 올바르지 않습니다.");
      }
      targets.set(name, target);
    }
    const targetMismatch = this.#configs.some((config) => {
      const target = targets.get(config.name);
      if (!target) return true;
      if (config.disabled) {
        return canonicalJson(target as unknown as JsonValue) !== canonicalJson({
          name: config.name,
          configVersion: config.configVersion,
          disabled: true,
        });
      }
      const execution = executions.get(config.name);
      if (!execution) return true;
      return canonicalJson(target as unknown as JsonValue) !== canonicalJson({
        name: config.name,
        command: config.command,
        argsHash: digest([...config.args]),
        cwd: {
          path: execution.cwd.path,
          device: String(execution.cwd.device),
          inode: String(execution.cwd.inode),
        },
        protocolVersion: config.protocolVersion,
        configVersion: config.configVersion,
        environmentVersion: execution.environment.version,
        disabled: false,
      });
    });
    if (
      plan.workspace !== this.#workspace ||
      plan.configurationVersion !== mcpConfigurationVersion(this.#configs) ||
      plan.version !== digest(plan.targets as unknown as JsonValue) ||
      targets.size !== this.#configs.length ||
      targetMismatch ||
      executions.size !== this.#configs.filter((config) => !config.disabled).length ||
      this.#configs.some((config) => config.disabled
        ? executions.has(config.name)
        : executions.get(config.name)?.config.configVersion !== config.configVersion)
    ) {
      throw new McpError("승인된 MCP 실행 계획과 현재 manager 설정이 다릅니다.");
    }
    for (const execution of executions.values()) await revalidateMcpCwd(execution.cwd);
    if (signal?.aborted) throw new McpError("MCP 재연결을 시작하기 전에 취소했습니다.");
    const planSecrets = [...new Set(
      [...executions.values()].flatMap((execution) => execution.environment.secrets),
    )];
    if (planSecrets.length > 0 && !this.#registerSecrets) {
      throw new McpError("MCP secret redaction registrar가 연결되지 않았습니다.");
    }
    const closed = await this.#disconnect("MCP reconnect");
    if (!closed.complete) {
      throw new McpError(`재연결 전 기존 MCP 연결을 모두 닫지 못했습니다: ${closed.failures.join("; ")}`);
    }
    if (signal?.aborted) throw new McpError("기존 MCP 연결을 닫은 뒤 재연결을 취소했습니다.");
    await this.#assertWorkspaceUnchanged();
    await this.#registerSecrets?.(planSecrets);
    if (signal?.aborted) throw new McpError("MCP secret 등록 뒤 재연결을 취소했습니다.");
    for (const secret of planSecrets) {
      this.#dynamicSecrets.add(secret);
      this.#activeSecrets.add(secret);
    }
    this.#resetStatuses();
    const generation = this.#generation;
    const discovered: McpDiscoveredTool[] = [];
    let discoveryBytes = 0;
    const notices: string[] = [];
    const addNotice = (message: string): void => {
      if (notices.length < MAX_MANAGER_NOTICES) notices.push(this.#safe(message));
    };

    for (const config of this.#configs) {
      const status = this.#status.get(config.name) ?? initialStatus(config);
      this.#status.set(config.name, status);
      if (config.disabled) continue;
      if (signal?.aborted) {
        const cancelledClose = await this.#disconnect("MCP reconnect cancelled");
        if (!cancelledClose.complete) {
          throw new McpError(
            `MCP 재연결 취소 뒤 process를 모두 닫지 못했습니다: ${cancelledClose.failures.join("; ")}`,
          );
        }
        throw new McpError("MCP 재연결을 취소했습니다.");
      }
      status.state = "connecting";
      let adapter: McpProtocolAdapter | undefined;
      try {
        const execution = executions.get(config.name);
        if (!execution) throw new McpError(`MCP 실행 계획에서 서버를 찾을 수 없습니다: ${config.name}`);
        await this.#assertWorkspaceUnchanged();
        await revalidateMcpCwd(execution.cwd);
        const redactor = new Redactor([...this.#modelSecrets, ...this.#dynamicSecrets]);
        adapter = createMcpProtocolAdapter(
          config.protocolVersion,
          new McpStdioTransport({
            serverName: config.name,
            command: config.command,
            args: config.args,
            cwd: execution.cwd.path,
            environment: execution.environment.environment,
            redactor,
          }),
        );
        await adapter.connect(signal);
        const discovery = await discoverMcpTools(config.name, adapter, signal);
        if (
          discovered.length + discovery.tools.length > MAX_MANAGER_DISCOVERED_TOOLS ||
          discoveryBytes + discovery.metadataBytes > MAX_MANAGER_DISCOVERY_BYTES
        ) {
          throw new McpError("MCP manager 전체 discovery 크기 제한을 초과했습니다.");
        }
        const connection: McpConnection = Object.freeze({
          config,
          adapter,
          cwd: execution.cwd,
          environmentVersion: execution.environment.version,
          generation,
        });
        this.#connections.set(config.name, connection);
        discovered.push(...discovery.tools);
        discoveryBytes += discovery.metadataBytes;
        for (const notice of discovery.notices) addNotice(notice);
        const serverName = adapter.info().serverInfo.name;
        status.serverDisplayName = typeof serverName === "string"
          ? boundedText(this.#safe(serverName), 512)
          : "";
        status.state = "connected";
      } catch (error) {
        if (error instanceof PermissionDeniedError) {
          await this.#abortReconnect(error, "MCP workspace or cwd identity changed");
        }
        let closeError: unknown;
        if (adapter) {
          try {
            await adapter.close("MCP connection failed");
          } catch (failure) {
            closeError = failure;
          }
        }
        if (closeError !== undefined) {
          const execution = executions.get(config.name);
          if (adapter && execution) {
            this.#connections.set(config.name, Object.freeze({
              config,
              adapter,
              cwd: execution.cwd,
              environmentVersion: execution.environment.version,
              generation,
            }));
          }
          const cleanup = await this.#disconnect("MCP failed connection cleanup retry");
          throw new McpError(
            cleanup.complete
              ? `MCP 서버 연결 실패 뒤 첫 종료 확인에 실패해 재연결을 중단했습니다: ${config.name}`
              : `MCP 서버 연결 실패 뒤 process를 닫지 못했습니다: ${cleanup.failures.join("; ")}`,
            { cause: closeError },
          );
        }
        this.#connections.delete(config.name);
        status.state = "failed";
        status.error = this.#safe(error instanceof Error ? error.message : "MCP 서버 연결에 실패했습니다.");
      }
    }

    if (signal?.aborted) {
      const cancelledClose = await this.#disconnect("MCP reconnect cancelled");
      if (!cancelledClose.complete) {
        throw new McpError(
          `MCP 재연결 취소 뒤 process를 모두 닫지 못했습니다: ${cancelledClose.failures.join("; ")}`,
        );
      }
      throw new McpError("MCP 재연결을 취소했습니다.");
    }

    try {
      await this.#assertWorkspaceUnchanged();
      const namespaced = namespaceMcpTools(discovered, new Set(BUILTIN_TOOL_NAMES));
      const registrations: McpToolRegistration[] = [];
      const preparedByServer = new Map<string, PreparedMcpTool[]>();
      let selectedCount = 0;
      for (const tool of namespaced) {
        const status = this.#status.get(tool.serverName);
        if (selectedCount >= MAX_ACTIVE_MCP_TOOLS) {
          if (status) status.disabledTools += 1;
          addNotice(`${tool.apiName}: 활성 MCP 도구 ${MAX_ACTIVE_MCP_TOOLS}개 상한으로 비활성화했습니다.`);
          continue;
        }
        const preparation = prepareMcpTool(tool);
        if (!preparation.enabled) {
          if (status) status.disabledTools += 1;
          addNotice(`${preparation.apiName}: ${preparation.reason}`);
          continue;
        }
        const list = preparedByServer.get(tool.serverName) ?? [];
        list.push(preparation.tool);
        preparedByServer.set(tool.serverName, list);
        selectedCount += 1;
      }
      for (const [serverName, tools] of preparedByServer) {
        const connection = this.#connections.get(serverName);
        const status = this.#status.get(serverName);
        if (!connection || !status) continue;
        const version = registryVersion(connection, tools);
        for (const tool of tools) registrations.push(this.#registration(tool, connection, version));
        status.activeTools = tools.length;
      }
      this.#registry.replaceMcpTools(registrations);
      this.#notices = Object.freeze(notices);
      return this.statuses();
    } catch (error) {
      const failedClose = await this.#disconnect("MCP tool registration failed");
      if (!failedClose.complete) {
        throw new McpError(
          `MCP 도구 등록 실패 뒤 process를 모두 닫지 못했습니다: ${failedClose.failures.join("; ")}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async shutdown(reason = "MCP manager shutdown"): Promise<McpManagerCloseResult> {
    if (this.#disposed) {
      return this.#shutdownResult ?? Object.freeze({
        complete: false,
        failures: Object.freeze(["MCP manager 종료 결과를 확인할 수 없습니다."]),
      });
    }
    this.#disposed = true;
    const result = await this.#disconnect(reason);
    this.#shutdownResult = result;
    return result;
  }

  #registration(
    tool: PreparedMcpTool,
    connection: McpConnection,
    version: string,
  ): McpToolRegistration {
    const service = `mcp:${tool.serverName}:${version}`;
    const descriptionPrefix = `[External MCP ${tool.serverName}; annotations are untrusted] `;
    const description = `${descriptionPrefix}${this.#safe(tool.description)}`.slice(0, 4_096);
    const assertCurrent = (): void => {
      const current = this.#connections.get(tool.serverName);
      if (
        current !== connection ||
        current.generation !== this.#generation ||
        !current.adapter.connected()
      ) {
        throw new McpError(`MCP 서버 연결 또는 도구 version이 변경됐습니다: ${tool.serverName}`);
      }
    };
    return {
      serverName: tool.serverName,
      registryVersion: version,
      validateInput: (input) => tool.compiledInput.validate(input),
      definition: {
        name: tool.apiName,
        description,
        inputSchema: structuredClone(tool.compiledInput.schema) as JsonObject,
        category: "external",
        permission: { kind: "external", service },
        outputLimitBytes: MCP_TOOL_OUTPUT_BYTES,
        handler: async (input, context): Promise<ToolExecutionResult> => {
          try {
            assertCurrent();
          } catch (error) {
            return toolFailure(
              "mcp_connection_changed",
              error instanceof Error ? error.message : "MCP 서버 연결이 변경됐습니다.",
              "not_started",
            );
          }
          let result: JsonObject;
          try {
            result = await connection.adapter.callTool(tool.toolName, input, context.signal);
          } catch (error) {
            return toolFailure(
              context.signal.aborted ? "mcp_call_cancelled_after_start" : "mcp_call_failed",
              context.signal.aborted
                ? "MCP 호출을 취소했습니다. 원격 도구의 부작용은 남아 있을 수 있습니다."
                : error instanceof Error
                  ? this.#safe(error.message)
                  : "MCP 도구 호출에 실패했습니다.",
              "unknown",
            );
          }
          if (result.isError !== undefined && typeof result.isError !== "boolean") {
            return toolFailure("mcp_result_invalid", "MCP isError 결과가 boolean이 아닙니다.", "failed");
          }
          const content = result.content ?? [];
          if (!Array.isArray(content)) {
            return toolFailure("mcp_result_invalid", "MCP content 결과가 배열이 아닙니다.", "failed");
          }
          const structured = result.structuredContent;
          if (structured !== undefined && !record(structured)) {
            return toolFailure("mcp_result_invalid", "MCP structuredContent 결과가 객체가 아닙니다.", "failed");
          }
          let validatedStructured: JsonObject | undefined;
          try {
            if (tool.compiledOutput) {
              if (structured === undefined) {
                throw new McpError("선언된 MCP output schema에 필요한 structuredContent가 없습니다.");
              }
              validatedStructured = tool.compiledOutput.validate(structured);
            } else if (structured !== undefined) {
              validatedStructured = structured as JsonObject;
            }
          } catch (error) {
            return toolFailure(
              "mcp_output_schema_mismatch",
              error instanceof Error
                ? this.#safe(error.message)
                : "MCP structuredContent 검증에 실패했습니다.",
              "failed",
            );
          }
          const details: JsonObject = {
            server: tool.serverName,
            tool: tool.toolName,
            content: this.#redactJson(content),
            structured_content: validatedStructured === undefined
              ? null
              : this.#redactJson(validatedStructured),
          };
          if (result.isError === true) {
            return toolFailure("mcp_tool_error", "MCP 서버가 도구 실행 오류를 반환했습니다.", "failed", details);
          }
          return {
            status: "success",
            output: { content: details, truncated: false },
          };
        },
      },
      preflight: async (input) => {
        await this.#assertWorkspaceUnchanged();
        assertCurrent();
        const serialized = JSON.stringify(input);
        if (serialized === undefined) throw new McpError("MCP 도구 인자를 JSON으로 표시하지 못했습니다.");
        const preview = this.#safe(serialized, 16 * 1024);
        return {
          summary: `외부 MCP 도구 실행: ${tool.serverName}.${tool.toolName}\narguments: ${preview}`,
          approvalScope: {
            kind: "external",
            target: {
              service,
              server: tool.serverName,
              tool: tool.toolName,
              toolVersion: tool.toolVersion,
              registryVersion: version,
              argumentsHash: digest(input),
            },
          },
        };
      },
      revalidate: async () => {
        await this.#assertWorkspaceUnchanged();
        assertCurrent();
      },
    };
  }

  async #disconnect(reason: string): Promise<McpManagerCloseResult> {
    this.#generation += 1;
    this.#registry.clearMcpTools();
    const connections = [...this.#connections.values()];
    const outcomes = await Promise.all(connections.map(async (connection) => {
      try {
        await connection.adapter.close(reason);
        if (this.#connections.get(connection.config.name) === connection) {
          this.#connections.delete(connection.config.name);
        }
        return undefined;
      } catch (error) {
        return this.#safe(
          `${connection.config.name}: ${error instanceof Error ? error.message : "종료 실패"}`,
        );
      }
    }));
    const failures = outcomes.filter((failure): failure is string => failure !== undefined);
    if (failures.length === 0) this.#activeSecrets.clear();
    for (const config of this.#configs) {
      const status = this.#status.get(config.name);
      if (status && !config.disabled) {
        status.state = this.#connections.has(config.name) ? "failed" : "configured";
        status.activeTools = 0;
        status.serverDisplayName = "";
        if (this.#connections.has(config.name)) {
          status.error = "MCP 서버 process 종료를 확인하지 못했습니다.";
        } else {
          status.error = "";
        }
      }
    }
    return Object.freeze({ complete: failures.length === 0, failures: Object.freeze(failures) });
  }

  #resetStatuses(): void {
    this.#status.clear();
    for (const config of this.#configs) this.#status.set(config.name, initialStatus(config));
  }

  #safe(message: string, maximumBytes = MAX_STATUS_TEXT_BYTES): string {
    return boundedText(
      new Redactor([...this.#modelSecrets, ...this.#dynamicSecrets]).redact(message),
      maximumBytes,
    );
  }

  #redactJson(value: JsonValue): JsonValue {
    return redactJson(value, new Redactor([...this.#modelSecrets, ...this.#dynamicSecrets]));
  }

  async #abortReconnect(error: unknown, reason: string): Promise<never> {
    const cleanup = await this.#disconnect(reason);
    if (!cleanup.complete) {
      throw new McpError(
        `MCP 실행 대상 변경 뒤 process를 모두 닫지 못했습니다: ${cleanup.failures.join("; ")}`,
        { cause: error },
      );
    }
    throw error;
  }

  async #assertWorkspaceUnchanged(): Promise<void> {
    let current: WorkspaceIdentity;
    try {
      current = await workspaceIdentity(this.#workspaceIdentity.canonicalPath);
    } catch (error) {
      throw new PermissionDeniedError(
        "MCP 실행 전에 workspace filesystem identity를 다시 확인하지 못했습니다.",
        { cause: error },
      );
    }
    const inodeMatches = process.platform === "win32" &&
        (current.inode === 0 || this.#workspaceIdentity.inode === 0)
      ? true
      : current.inode === this.#workspaceIdentity.inode;
    if (
      current.canonicalPath !== this.#workspaceIdentity.canonicalPath ||
      current.device !== this.#workspaceIdentity.device ||
      !inodeMatches
    ) {
      throw new PermissionDeniedError("MCP 실행 전에 workspace filesystem identity가 변경됐습니다.");
    }
  }

  #assertUsable(): void {
    if (this.#disposed) throw new McpError("MCP manager가 이미 종료됐습니다.");
  }
}

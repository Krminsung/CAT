import type { JsonObject } from "../core/json.js";
import {
  assertMcpConfigSecretSeparation,
  createMcpServerConfig,
  mcpServerConfigJson,
  type McpConfigScope,
  type McpConfigStore,
  type McpEnvironmentReference,
} from "../mcp/config.js";
import {
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSIONS,
  type McpProtocolVersion,
} from "../mcp/protocol.js";
import { CliUsageError } from "./args.js";
import type { CliOutput } from "./output.js";

const MCP_COMMANDS = ["list", "get", "add", "remove", "rm"] as const;
type McpCommand = (typeof MCP_COMMANDS)[number];
const MAX_MCP_ARGUMENT_BYTES = 512 * 1024;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function mcpHelp(): string {
  return "usage: cat-tui mcp <list|get|add|remove|rm> ...\n\n" +
    "stdio MCP 서버 설정을 관리합니다. 이 명령은 서버 process를 시작하지 않습니다.\n\n" +
    "commands:\n" +
    "  list                    병합된 서버 설정 목록\n" +
    "  get NAME                secret 값 없는 병합 설정 보기\n" +
    "  add [options] NAME COMMAND [ARG ...]\n" +
    "                          서버 설정 저장\n" +
    "  remove [--scope SCOPE] NAME\n" +
    "                          정확한 scope에서 서버 설정 제거\n\n" +
    "add options:\n" +
    "  --scope user|project|local              기본: local\n" +
    "  --protocol-version 2025-11-25|2026-07-28\n" +
    "  --cwd WORKSPACE_PATH                    workspace 내부 cwd\n" +
    "  --env CHILD_NAME=HOST_SECRET_NAME       값 대신 환경변수 참조 저장(반복 가능)\n" +
    "  --disabled                              시작 대상에서 제외\n\n" +
    "저장한 서버는 신뢰된 대화형 세션에서 /mcp reconnect를 명시적으로 승인해야 시작됩니다.\n";
}

function assertArguments(args: readonly string[]): void {
  let bytes = 0;
  for (const value of args) {
    bytes += Buffer.byteLength(value, "utf8") + 1;
    if (value.includes("\0") || bytes > MAX_MCP_ARGUMENT_BYTES) {
      throw new CliUsageError("mcp 인자의 형식 또는 전체 크기가 올바르지 않습니다.");
    }
  }
}

function isMcpCommand(value: string): value is McpCommand {
  return (MCP_COMMANDS as readonly string[]).includes(value);
}

function scope(value: string): McpConfigScope {
  if (value !== "user" && value !== "project" && value !== "local") {
    throw new CliUsageError("--scope는 user, project, local 중 하나여야 합니다.");
  }
  return value;
}

function protocol(value: string): McpProtocolVersion {
  if (!(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(value)) {
    throw new CliUsageError(
      `--protocol-version은 ${MCP_PROTOCOL_VERSIONS.join(" 또는 ")}이어야 합니다.`,
    );
  }
  return value as McpProtocolVersion;
}

function optionValue(
  args: readonly string[],
  index: number,
  option: string,
  inline: string | undefined,
): { readonly value: string; readonly nextIndex: number } {
  const value = inline ?? args[index + 1];
  if (value === undefined || (!inline && value.startsWith("-"))) {
    throw new CliUsageError(`${option} 옵션에 값이 필요합니다.`);
  }
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new CliUsageError(`${option} 값의 형식이 올바르지 않습니다.`);
  }
  return Object.freeze({ value, nextIndex: inline === undefined ? index + 1 : index });
}

function environmentAssignment(value: string): { readonly target: string; readonly reference: McpEnvironmentReference } {
  const equals = value.indexOf("=");
  const target = equals < 0 ? "" : value.slice(0, equals);
  const source = equals < 0 ? "" : value.slice(equals + 1);
  if (!ENVIRONMENT_NAME_PATTERN.test(target) || !ENVIRONMENT_NAME_PATTERN.test(source)) {
    throw new CliUsageError("--env는 CHILD_NAME=HOST_SECRET_NAME 형식이어야 합니다.");
  }
  return Object.freeze({ target, reference: Object.freeze({ source: "environment", name: source }) });
}

interface AddArguments {
  readonly scope: McpConfigScope;
  readonly name: string;
  readonly config: JsonObject;
}

function addArguments(args: readonly string[]): AddArguments {
  let selectedScope: McpConfigScope = "local";
  let selectedProtocol: McpProtocolVersion = MCP_LEGACY_PROTOCOL_VERSION;
  let cwd: string | undefined;
  let disabled = false;
  const environment = Object.create(null) as JsonObject;
  const positional: string[] = [];
  const seen = new Set<string>();
  let positionalOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    let argument = args[index] ?? "";
    if (!positionalOnly && argument === "--") {
      positionalOnly = true;
      continue;
    }
    const commandRemainder = positional.length >= 2;
    if (positionalOnly || commandRemainder || !argument.startsWith("-")) {
      positional.push(argument);
      continue;
    }
    if (argument === "--disabled") {
      if (seen.has(argument)) throw new CliUsageError("--disabled를 중복 지정할 수 없습니다.");
      seen.add(argument);
      disabled = true;
      continue;
    }
    const assignment = argument.match(/^(--[^=]+)=(.*)$/su);
    const option = assignment?.[1] ?? argument;
    const inline = assignment?.[2];
    if (option !== "--scope" && option !== "--protocol-version" && option !== "--cwd" && option !== "--env") {
      throw new CliUsageError(`mcp add의 알 수 없는 옵션입니다: ${option}`);
    }
    if (option !== "--env" && seen.has(option)) {
      throw new CliUsageError(`${option} 옵션을 중복 지정할 수 없습니다.`);
    }
    seen.add(option);
    const selected = optionValue(args, index, option, inline);
    index = selected.nextIndex;
    if (option === "--scope") selectedScope = scope(selected.value);
    else if (option === "--protocol-version") selectedProtocol = protocol(selected.value);
    else if (option === "--cwd") cwd = selected.value;
    else {
      const parsed = environmentAssignment(selected.value);
      if (Object.hasOwn(environment, parsed.target)) {
        throw new CliUsageError(`--env child 이름이 중복됐습니다: ${parsed.target}`);
      }
      environment[parsed.target] = { source: parsed.reference.source, name: parsed.reference.name };
    }
  }
  const name = positional[0];
  const command = positional[1];
  if (!name || !command) {
    throw new CliUsageError("사용법: cat-tui mcp add [options] NAME COMMAND [ARG ...]");
  }
  const config: JsonObject = {
    command,
    args: positional.slice(2),
    protocolVersion: selectedProtocol,
    disabled,
    ...(cwd === undefined ? {} : { cwd }),
    ...(Object.keys(environment).length === 0 ? {} : { env: environment }),
  };
  return Object.freeze({ scope: selectedScope, name, config });
}

function removeArguments(args: readonly string[]): { readonly scope: McpConfigScope; readonly name: string } {
  let selectedScope: McpConfigScope = "local";
  const positional: string[] = [];
  let scopeSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    const assignment = argument.match(/^--scope=(.*)$/su);
    if (argument === "--scope" || assignment) {
      if (scopeSeen) throw new CliUsageError("--scope 옵션을 중복 지정할 수 없습니다.");
      scopeSeen = true;
      const selected = optionValue(args, index, "--scope", assignment?.[1]);
      index = selected.nextIndex;
      selectedScope = scope(selected.value);
    } else if (argument.startsWith("-")) {
      throw new CliUsageError(`mcp remove의 알 수 없는 옵션입니다: ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  if (positional.length !== 1 || !positional[0]) {
    throw new CliUsageError("사용법: cat-tui mcp remove [--scope SCOPE] NAME");
  }
  return Object.freeze({ scope: selectedScope, name: positional[0] });
}

export class McpManagementController {
  readonly #store: McpConfigStore;
  readonly #modelSecrets: ReadonlySet<string>;

  constructor(store: McpConfigStore, modelSecrets: readonly string[] = []) {
    this.#store = store;
    this.#modelSecrets = new Set(modelSecrets);
  }

  async run(args: readonly string[], output: CliOutput): Promise<number> {
    assertArguments(args);
    const command = args[0];
    if (command === undefined || command === "-h" || command === "--help") {
      output.writeTrustedText(mcpHelp());
      return 0;
    }
    if (!isMcpCommand(command)) throw new CliUsageError(`mcp 명령을 찾을 수 없습니다: ${command}`);
    const commandArgs = args.slice(1);
    if (
      (command === "add" && (commandArgs[0] === "-h" || commandArgs[0] === "--help")) ||
      (command !== "add" && (commandArgs.includes("-h") || commandArgs.includes("--help")))
    ) {
      output.writeTrustedText(mcpHelp());
      return 0;
    }
    if (command === "list") {
      if (commandArgs.length !== 0) throw new CliUsageError("mcp list에는 추가 인자를 사용할 수 없습니다.");
      const snapshot = await this.#store.snapshot();
      for (const config of snapshot.configs) {
        assertMcpConfigSecretSeparation(config, this.#modelSecrets);
      }
      if (snapshot.settings.projectSettingsSkipped) {
        output.diagnostic("cat: workspace trust가 없어 project/local MCP 설정은 목록에서 제외했습니다.");
      }
      if (snapshot.configs.length === 0) {
        output.writeText("설정된 MCP 서버가 없습니다.");
        return 0;
      }
      output.writeText(snapshot.configs.map((config) =>
        `${config.name}${config.disabled ? " (disabled)" : ""}\t` +
        `${JSON.stringify([config.command, ...config.args])}` +
        `\t${config.protocolVersion}`
      ).join("\n"));
      return 0;
    }
    if (command === "get") {
      if (commandArgs.length !== 1 || !commandArgs[0]) {
        throw new CliUsageError("사용법: cat-tui mcp get NAME");
      }
      const snapshot = await this.#store.snapshot();
      for (const config of snapshot.configs) {
        assertMcpConfigSecretSeparation(config, this.#modelSecrets);
      }
      if (snapshot.settings.projectSettingsSkipped) {
        output.diagnostic("cat: workspace trust가 없어 project/local MCP 설정은 조회에서 제외했습니다.");
      }
      const config = snapshot.configs.find((item) => item.name === commandArgs[0]);
      if (!config) throw new CliUsageError(`MCP 서버를 찾을 수 없습니다: ${commandArgs[0]}`);
      output.writeText(JSON.stringify({
        name: config.name,
        ...mcpServerConfigJson(config),
        configVersion: config.configVersion,
      }, null, 2));
      return 0;
    }
    if (command === "add") {
      const selected = addArguments(commandArgs);
      const config = createMcpServerConfig(selected.name, selected.config);
      assertMcpConfigSecretSeparation(config, this.#modelSecrets);
      const path = await this.#store.upsert(selected.scope, config);
      output.writeText(
        `MCP 서버 설정을 저장했습니다(아직 시작하지 않음): ${config.name} (${path})\n` +
        "신뢰된 대화형 세션에서 /mcp reconnect를 실행하고 중앙 승인을 완료하면 시작됩니다.",
      );
      return 0;
    }
    const selected = removeArguments(commandArgs);
    const removed = await this.#store.remove(selected.scope, selected.name);
    output.writeText(removed.removed
      ? `MCP 서버 설정을 제거했습니다: ${selected.name} (${removed.path})`
      : `${selected.scope} scope에서 MCP 서버를 찾을 수 없습니다: ${selected.name}`);
    return removed.removed ? 0 : 1;
  }
}

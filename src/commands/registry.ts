import { ConfigurationError } from "../core/errors.js";
import {
  SLASH_COMMAND_CAPABILITIES,
  SLASH_COMMAND_DEFINITIONS,
  isSlashCommandName,
  type SlashCommandCapability,
  type SlashCommandDefinition,
  type SlashCommandName,
} from "./definitions.js";

const MAX_COMMAND_INPUT_BYTES = 512 * 1024;
const MAX_COMMAND_ARGUMENT_BYTES = 500 * 1024;
const COMMAND_LINE = /^\/([A-Za-z][A-Za-z0-9-]{0,63})(?:[ \t]+([\s\S]*))?$/u;

export interface SlashCommandInvocation {
  readonly name: SlashCommandName;
  readonly argument: string;
  readonly raw: string;
}

export type SlashCommandHandler<Context> = (
  invocation: SlashCommandInvocation,
  context: Context,
) => void | Promise<void>;

export type SlashCommandHandlers<Context> = Partial<{
  readonly [Name in SlashCommandName]: SlashCommandHandler<Context>;
}>;

export interface SlashCommandRegistryOptions<Context> {
  readonly capabilities: readonly SlashCommandCapability[];
  readonly handlers: SlashCommandHandlers<Context>;
}

export interface SlashCommandCompletion {
  readonly name: string;
  readonly description: string;
  readonly argumentHint?: string;
}

export type SlashCommandAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

export type SlashCommandDispatchResult =
  | { readonly status: "not_command" }
  | { readonly status: "unknown"; readonly enteredName: string }
  | {
      readonly status: "unavailable";
      readonly name: SlashCommandName;
      readonly reason: string;
    }
  | { readonly status: "handled"; readonly name: SlashCommandName };

interface ParsedCommand {
  readonly enteredName: string;
  readonly argument: string;
  readonly raw: string;
}

const DEFINITION_BY_NAME = new Map<SlashCommandName, SlashCommandDefinition>(
  SLASH_COMMAND_DEFINITIONS.map(
    (definition): readonly [SlashCommandName, SlashCommandDefinition] => [
      definition.name,
      definition,
    ],
  ),
);

function parseCommandLine(input: string): ParsedCommand | undefined {
  if (Buffer.byteLength(input, "utf8") > MAX_COMMAND_INPUT_BYTES || input.includes("\0")) {
    throw new ConfigurationError("slash 명령 입력이 허용 크기 또는 형식을 벗어났습니다.");
  }
  const raw = input.trim();
  if (!raw.startsWith("/") && !raw.startsWith("?")) return undefined;
  if (raw === "?" || raw.startsWith("? ") || raw.startsWith("?\t")) {
    const argument = raw.slice(1).trim();
    return Object.freeze({ enteredName: "help", argument, raw });
  }
  const match = raw.match(COMMAND_LINE);
  if (!match) {
    const token = raw.slice(1).split(/[ \t\r\n]/u, 1)[0] ?? "";
    return Object.freeze({ enteredName: token.toLowerCase(), argument: "", raw });
  }
  const argument = (match[2] ?? "").trim();
  if (Buffer.byteLength(argument, "utf8") > MAX_COMMAND_ARGUMENT_BYTES) {
    throw new ConfigurationError("slash 명령 인자가 허용 크기를 초과했습니다.");
  }
  return Object.freeze({
    enteredName: (match[1] ?? "").toLowerCase(),
    argument,
    raw,
  });
}

function argumentHint(definition: SlashCommandDefinition): string | undefined {
  const prefix = `/${definition.name}`;
  const suffix = definition.usage.slice(prefix.length).trim();
  return suffix || undefined;
}

export class SlashCommandRegistry<Context> {
  readonly #capabilities: ReadonlySet<SlashCommandCapability>;
  readonly #handlers = new Map<SlashCommandName, SlashCommandHandler<Context>>();

  constructor(options: SlashCommandRegistryOptions<Context>) {
    const knownCapabilities = new Set<string>(SLASH_COMMAND_CAPABILITIES);
    const capabilities = new Set<SlashCommandCapability>();
    for (const capability of options.capabilities) {
      if (!knownCapabilities.has(capability)) {
        throw new ConfigurationError(`알 수 없는 slash 명령 capability입니다: ${capability}`);
      }
      capabilities.add(capability);
    }
    for (const key of Object.keys(options.handlers)) {
      if (!isSlashCommandName(key)) {
        throw new ConfigurationError(`알 수 없는 slash 명령 handler입니다: ${key}`);
      }
      const handler = options.handlers[key];
      if (handler !== undefined) this.#handlers.set(key, handler);
    }
    this.#capabilities = capabilities;
  }

  definitions(): readonly SlashCommandDefinition[] {
    return SLASH_COMMAND_DEFINITIONS;
  }

  availability(name: SlashCommandName): SlashCommandAvailability {
    const definition = DEFINITION_BY_NAME.get(name);
    if (!definition) return Object.freeze({ available: false, reason: "명령 정의를 찾을 수 없습니다." });
    if (!this.#capabilities.has(definition.capability)) {
      return Object.freeze({ available: false, reason: definition.unavailableReason });
    }
    if (!this.#handlers.has(name)) {
      return Object.freeze({ available: false, reason: `${definition.usage} handler가 연결되지 않았습니다.` });
    }
    return Object.freeze({ available: true });
  }

  activeDefinitions(): readonly SlashCommandDefinition[] {
    return Object.freeze(
      SLASH_COMMAND_DEFINITIONS.filter((definition) => this.availability(definition.name).available),
    );
  }

  completions(prefix = ""): readonly SlashCommandCompletion[] {
    const selected = prefix.trim().replace(/^\//u, "").toLowerCase();
    if (selected.length > 64 || /[^a-z0-9-]/u.test(selected)) return Object.freeze([]);
    return Object.freeze(
      this.activeDefinitions()
        .filter((definition) => definition.name.startsWith(selected))
        .map((definition) => {
          const hint = argumentHint(definition);
          return Object.freeze({
            name: definition.name,
            description: definition.description,
            ...(hint === undefined ? {} : { argumentHint: hint }),
          });
        }),
    );
  }

  helpText(): string {
    const active = this.activeDefinitions();
    const rows = active.map((definition) => `  ${definition.usage.padEnd(42)} ${definition.description}`);
    return "사용 가능한 slash 명령\n\n" +
      `${rows.join("\n") || "  현재 사용할 수 있는 명령이 없습니다."}\n\n` +
      "별칭: ? → /help\n" +
      "단축키: Ctrl+J 줄바꿈 · Ctrl+O 상세 · Ctrl+P 세션 · Shift+Tab/Alt+M 권한 모드";
  }

  async dispatch(input: string, context: Context): Promise<SlashCommandDispatchResult> {
    const parsed = parseCommandLine(input);
    if (!parsed) return Object.freeze({ status: "not_command" });
    if (!isSlashCommandName(parsed.enteredName)) {
      return Object.freeze({ status: "unknown", enteredName: parsed.enteredName });
    }
    const availability = this.availability(parsed.enteredName);
    if (!availability.available) {
      return Object.freeze({
        status: "unavailable",
        name: parsed.enteredName,
        reason: availability.reason,
      });
    }
    const handler = this.#handlers.get(parsed.enteredName);
    if (!handler) {
      return Object.freeze({
        status: "unavailable",
        name: parsed.enteredName,
        reason: `/${parsed.enteredName} handler가 연결되지 않았습니다.`,
      });
    }
    await handler(Object.freeze({
      name: parsed.enteredName,
      argument: parsed.argument,
      raw: parsed.raw,
    }), context);
    return Object.freeze({ status: "handled", name: parsed.enteredName });
  }
}

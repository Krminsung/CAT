import type { AgentEvent } from "../core/events.js";
import { ProtocolError } from "../core/errors.js";
import type { RunBudget, RunTermination } from "../core/execution.js";
import type { ProviderUsage } from "../core/provider.js";
import { Redactor } from "../security/redaction.js";
import {
  sanitizeTerminalText,
  type TerminalTextRedactor,
} from "../tui/terminal-text.js";
import type { CliOutputFormat } from "./args.js";

const MAX_TEXT_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_JSON_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_JSON_DEPTH = 40;
const MAX_JSON_NODES = 100_000;
const MAX_DYNAMIC_SECRETS = 256;
const MAX_DYNAMIC_SECRET_BYTES = 64 * 1024;
const MAX_DYNAMIC_SECRETS_BYTES = 1024 * 1024;

export interface CliWritable {
  write(text: string): unknown;
}

export interface CliRunResultOutput {
  readonly sessionId: string;
  readonly runId: string;
  readonly termination: RunTermination;
  readonly text: string;
  readonly message?: string;
  readonly usage: ProviderUsage;
  readonly budget?: RunBudget;
}

interface JsonCopyState {
  nodes: number;
  readonly ancestors: WeakSet<object>;
}

function safeJsonCopy(
  value: unknown,
  redactor: TerminalTextRedactor,
  state: JsonCopyState,
  depth = 0,
): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new ProtocolError("구조화 출력의 JSON 크기 또는 깊이가 제한을 초과했습니다.");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return redactor.redact(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ProtocolError("구조화 출력에는 유한한 숫자만 사용할 수 있습니다.");
    return value;
  }
  if (typeof value !== "object") {
    throw new ProtocolError("구조화 출력에 JSON이 아닌 값이 포함됐습니다.");
  }
  if (state.ancestors.has(value)) {
    throw new ProtocolError("구조화 출력에 순환 참조가 포함됐습니다.");
  }
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => safeJsonCopy(item, redactor, state, depth + 1));
    }
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      const safeKey = redactor.redact(key);
      if (Object.hasOwn(output, safeKey)) {
        throw new ProtocolError("구조화 출력 key가 redaction 뒤 충돌했습니다.");
      }
      output[safeKey] = safeJsonCopy(item, redactor, state, depth + 1);
    }
    return output;
  } finally {
    state.ancestors.delete(value);
  }
}

function jsonLine(value: unknown, redactor: TerminalTextRedactor): string {
  const safe = safeJsonCopy(
    value,
    redactor,
    { nodes: 0, ancestors: new WeakSet<object>() },
  );
  const serialized = JSON.stringify(safe);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_JSON_RECORD_BYTES) {
    throw new ProtocolError("구조화 출력 record가 허용 크기를 초과했습니다.");
  }
  return `${serialized}\n`;
}

export class CliOutput {
  readonly #format: CliOutputFormat;
  readonly #stdout: CliWritable;
  readonly #stderr: CliWritable;
  readonly #baseRedactor: TerminalTextRedactor;
  readonly #knownSecrets = new Set<string>();
  #knownSecretBytes = 0;
  #dynamicRedactor = new Redactor();
  readonly #redactor: TerminalTextRedactor;

  constructor(options: {
    readonly format: CliOutputFormat;
    readonly stdout?: CliWritable;
    readonly stderr?: CliWritable;
    readonly redactor?: Redactor;
  }) {
    this.#format = options.format;
    this.#stdout = options.stdout ?? process.stdout;
    this.#stderr = options.stderr ?? process.stderr;
    this.#baseRedactor = options.redactor ?? new Redactor();
    this.#redactor = {
      redact: (text) => this.#dynamicRedactor.redact(this.#baseRedactor.redact(text)),
    };
  }

  get format(): CliOutputFormat {
    return this.#format;
  }

  addKnownSecrets(secrets: readonly string[]): void {
    const additions = new Set<string>();
    let nextSecretBytes = this.#knownSecretBytes;
    for (const secret of secrets) {
      if (
        typeof secret !== "string" ||
        !secret ||
        this.#knownSecrets.has(secret) ||
        additions.has(secret)
      ) continue;
      const bytes = Buffer.byteLength(secret, "utf8");
      if (bytes < 8 || bytes > MAX_DYNAMIC_SECRET_BYTES) {
        throw new ProtocolError("CLI redaction secret의 크기가 안전한 범위를 벗어났습니다.");
      }
      if (
        this.#knownSecrets.size + additions.size >= MAX_DYNAMIC_SECRETS ||
        nextSecretBytes + bytes > MAX_DYNAMIC_SECRETS_BYTES
      ) {
        throw new ProtocolError("CLI redaction secret 전체 상한을 초과했습니다.");
      }
      additions.add(secret);
      nextSecretBytes += bytes;
    }
    for (const secret of additions) {
      this.#knownSecrets.add(secret);
    }
    this.#knownSecretBytes = nextSecretBytes;
    if (additions.size > 0) {
      this.#dynamicRedactor = new Redactor([...this.#knownSecrets]);
    }
  }

  writeTrustedText(text: string): void {
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_OUTPUT_BYTES) {
      throw new ProtocolError("CLI 출력이 허용 크기를 초과했습니다.");
    }
    this.#stdout.write(text);
  }

  writeText(text: string): void {
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_OUTPUT_BYTES) {
      throw new ProtocolError("CLI 출력이 허용 크기를 초과했습니다.");
    }
    const safe = sanitizeTerminalText(text, {
      maximumBytes: MAX_TEXT_OUTPUT_BYTES,
      redactor: this.#redactor,
    }).text.replaceAll("\r", "");
    if (safe) this.#stdout.write(safe.endsWith("\n") ? safe : `${safe}\n`);
  }

  diagnostic(message: string): void {
    const safe = sanitizeTerminalText(message, {
      maximumBytes: MAX_DIAGNOSTIC_BYTES,
      redactor: this.#redactor,
    }).text.replaceAll("\r", "").trimEnd();
    this.#stderr.write(`${safe || "알 수 없는 오류"}\n`);
  }

  agentEvent(event: AgentEvent): void {
    if (this.#format !== "stream-json") return;
    this.#stdout.write(jsonLine({ schemaVersion: 1, type: "agent_event", event }, this.#redactor));
  }

  runResult(result: CliRunResultOutput): void {
    if (this.#format === "text") {
      const safe = sanitizeTerminalText(result.text, {
        maximumBytes: MAX_TEXT_OUTPUT_BYTES,
        redactor: this.#redactor,
      }).text;
      if (safe) this.#stdout.write(safe.endsWith("\n") ? safe : `${safe}\n`);
      if (result.termination !== "completed" && result.message) this.diagnostic(result.message);
      return;
    }
    this.#stdout.write(jsonLine({
      schemaVersion: 1,
      type: "result",
      sessionId: result.sessionId,
      runId: result.runId,
      termination: result.termination,
      text: result.text,
      ...(result.message === undefined ? {} : { message: result.message }),
      usage: result.usage,
      ...(result.budget === undefined ? {} : { budget: result.budget }),
    }, this.#redactor));
  }
}

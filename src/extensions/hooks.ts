import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { CancelledError, ConfigurationError, HookError } from "../core/errors.js";
import type { JsonObject, JsonValue } from "../core/json.js";
import type { ToolExecutionResult } from "../core/tools.js";
import { buildChildEnvironment } from "../security/environment.js";
import type { PermissionMode } from "../security/permissions.js";
import { Redactor } from "../security/redaction.js";
import type {
  ToolBoundaryRequest,
  ToolHookPort,
} from "../tools/runtime.js";

export const HOOK_EVENTS = Object.freeze([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "PreCompact",
  "SessionEnd",
] as const);

export type HookEvent = (typeof HOOK_EVENTS)[number];

const EVENT_NAMES = new Set<string>(HOOK_EVENTS);
const BLOCKABLE_EVENTS = new Set<HookEvent>(["UserPromptSubmit", "PreToolUse", "Stop"]);
const CONTEXT_EVENTS = new Set<HookEvent>(["SessionStart", "UserPromptSubmit"]);
const MAX_INPUT_BYTES = 1_000_000;
const MAX_OUTPUT_BYTES = 256_000;
const MAX_CONTEXT_BYTES = 64_000;
const MAX_REASON_BYTES = 4_000;
const MAX_NOTICE_BYTES = 64 * 1024;
const MAX_NOTICES = 128;
const MAX_COMMAND_BYTES = 32 * 1024;
const MAX_MATCHER_BYTES = 4_096;
const MAX_GROUPS_PER_EVENT = 256;
const MAX_HOOKS = 512;
const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 600;
const RESERVED_PAYLOAD_FIELDS = new Set([
  "session_id",
  "transcript_path",
  "cwd",
  "permission_mode",
  "hook_event_name",
]);

interface CommandHook {
  readonly command: string;
  readonly timeoutMs: number;
}

interface HookGroup {
  readonly matcher: string;
  readonly expression?: RegExp;
  readonly hooks: readonly CommandHook[];
}

export interface HookOutcome {
  readonly blocked: boolean;
  readonly reason: string;
  readonly context: readonly string[];
  readonly notices: readonly string[];
}

export interface HookEngineOptions {
  readonly workspace: string;
  readonly workspaceTrusted: boolean;
  readonly hooks?: JsonObject;
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly permissionMode: () => PermissionMode;
  readonly environment?: NodeJS.ProcessEnv;
  readonly redactor?: Redactor;
  readonly onNotice?: (message: string) => void;
}

interface HookProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Prefix(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function cleanHookText(value: string, redactor: Redactor): string {
  return redactor.redact(value).replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu,
    "�",
  );
}

function commandTimeout(value: unknown, event: HookEvent): number {
  const normalized = typeof value === "string" && /^\d+$/u.test(value.trim())
    ? Number(value.trim())
    : value ?? DEFAULT_TIMEOUT_SECONDS;
  if (
    typeof normalized !== "number" ||
    !Number.isSafeInteger(normalized) ||
    normalized < 1 ||
    normalized > MAX_TIMEOUT_SECONDS
  ) {
    throw new ConfigurationError(
      `${event} hook timeout은 1–${MAX_TIMEOUT_SECONDS} 범위의 정수 초여야 합니다.`,
    );
  }
  return normalized * 1_000;
}

function parseHooks(raw: JsonValue | undefined): ReadonlyMap<HookEvent, readonly HookGroup[]> {
  const parsed = new Map<HookEvent, readonly HookGroup[]>();
  if (raw === undefined || raw === null) return parsed;
  if (!record(raw)) throw new ConfigurationError("hooks 설정은 객체여야 합니다.");
  let totalHooks = 0;
  for (const [eventValue, groupsValue] of Object.entries(raw)) {
    if (!EVENT_NAMES.has(eventValue)) {
      throw new ConfigurationError(
        `지원하지 않는 hook event입니다: ${eventValue}. 지원 event: ${HOOK_EVENTS.join(", ")}`,
      );
    }
    const event = eventValue as HookEvent;
    if (!Array.isArray(groupsValue) || groupsValue.length > MAX_GROUPS_PER_EVENT) {
      throw new ConfigurationError(
        `${event} hook groups는 최대 ${MAX_GROUPS_PER_EVENT}개의 배열이어야 합니다.`,
      );
    }
    const groups: HookGroup[] = [];
    for (const groupValue of groupsValue) {
      if (!record(groupValue)) throw new ConfigurationError(`${event} hook group은 객체여야 합니다.`);
      const unknownGroupKeys = Object.keys(groupValue).filter((key) => key !== "matcher" && key !== "hooks");
      if (unknownGroupKeys.length > 0) {
        throw new ConfigurationError(`${event} hook group에 알 수 없는 key가 있습니다: ${unknownGroupKeys.join(", ")}`);
      }
      const matcherValue = groupValue.matcher ?? "";
      if (
        typeof matcherValue !== "string" ||
        matcherValue.includes("\0") ||
        Buffer.byteLength(matcherValue, "utf8") > MAX_MATCHER_BYTES
      ) {
        throw new ConfigurationError(`${event} hook matcher 형식 또는 크기가 올바르지 않습니다.`);
      }
      let expression: RegExp | undefined;
      if (matcherValue) {
        try {
          expression = new RegExp(matcherValue, "u");
        } catch (error) {
          throw new ConfigurationError(`${event} hook matcher 정규식이 올바르지 않습니다.`, {
            cause: error,
          });
        }
      }
      if (!Array.isArray(groupValue.hooks)) {
        throw new ConfigurationError(`${event} hook group의 hooks는 배열이어야 합니다.`);
      }
      const commands: CommandHook[] = [];
      for (const hookValue of groupValue.hooks) {
        totalHooks += 1;
        if (totalHooks > MAX_HOOKS) {
          throw new ConfigurationError(`hook은 전체 ${MAX_HOOKS}개 이하여야 합니다.`);
        }
        if (!record(hookValue)) throw new ConfigurationError(`${event} hook은 객체여야 합니다.`);
        const unknownHookKeys = Object.keys(hookValue)
          .filter((key) => key !== "type" && key !== "command" && key !== "timeout");
        if (unknownHookKeys.length > 0) {
          throw new ConfigurationError(`${event} hook에 알 수 없는 key가 있습니다: ${unknownHookKeys.join(", ")}`);
        }
        if (hookValue.type !== undefined && hookValue.type !== "command") {
          throw new ConfigurationError(`${event}에서 command hook만 지원합니다.`);
        }
        const command = hookValue.command;
        if (
          typeof command !== "string" ||
          !command.trim() ||
          command.includes("\0") ||
          Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES
        ) {
          throw new ConfigurationError(`${event} hook command 형식 또는 크기가 올바르지 않습니다.`);
        }
        commands.push(Object.freeze({
          command,
          timeoutMs: commandTimeout(hookValue.timeout, event),
        }));
      }
      groups.push(Object.freeze({
        matcher: matcherValue,
        ...(expression === undefined ? {} : { expression }),
        hooks: Object.freeze(commands),
      }));
    }
    parsed.set(event, Object.freeze(groups));
  }
  return parsed;
}

function matches(group: HookGroup, value: string): boolean {
  return group.expression?.test(value) ?? true;
}

function decodeOutput(chunks: readonly Buffer[], stream: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    throw new HookError(`hook ${stream}이 유효한 UTF-8이 아닙니다.`, { cause: error });
  }
}

async function executeHook(
  hook: CommandHook,
  options: HookEngineOptions,
  event: HookEvent,
  payload: string,
  signal?: AbortSignal,
): Promise<HookProcessResult> {
  if (signal?.aborted) throw new CancelledError(`${event} hook 실행이 취소됐습니다.`);
  return await new Promise<HookProcessResult>((resolvePromise, rejectPromise) => {
    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn("/bin/sh", ["-c", hook.command], {
        cwd: options.workspace,
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: buildChildEnvironment({
          source: options.environment ?? process.env,
          additions: {
            CAT_PROJECT_DIR: options.workspace,
            CAT_SESSION_ID: options.sessionId,
            CAT_HOOK_EVENT: event,
          },
        }),
      });
    } catch (error) {
      rejectPromise(new HookError(`${event} hook process를 시작하지 못했습니다.`, { cause: error }));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let terminating = false;
    let timedOut = false;
    let cancelled = false;
    let overflow = false;
    let processError: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let forceCloseTimer: NodeJS.Timeout | undefined;

    const sendSignal = (processSignal: NodeJS.Signals): void => {
      if (!child.pid) return;
      if (process.platform !== "win32") {
        try {
          process.kill(-child.pid, processSignal);
          return;
        } catch {
          // Fall back to the exact owned child below.
        }
      }
      try {
        child.kill(processSignal);
      } catch {
        // The owned process already exited.
      }
    };
    const terminate = (): void => {
      if (terminating || settled) return;
      terminating = true;
      sendSignal("SIGTERM");
      killTimer = setTimeout(() => {
        sendSignal("SIGKILL");
        forceCloseTimer = setTimeout(() => {
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          finish(null);
        }, 1_000);
      }, 250);
    };
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (forceCloseTimer) clearTimeout(forceCloseTimer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted || cancelled) {
        rejectPromise(new CancelledError(`${event} hook 실행이 취소됐습니다.`));
        return;
      }
      if (timedOut) {
        rejectPromise(new HookError(`${event} hook 실행 시간이 ${hook.timeoutMs / 1_000}초를 초과했습니다.`));
        return;
      }
      if (overflow) {
        rejectPromise(new HookError(`${event} hook 출력이 ${MAX_OUTPUT_BYTES} bytes 제한을 초과했습니다.`));
        return;
      }
      if (processError) {
        rejectPromise(new HookError(`${event} hook process 실행에 실패했습니다.`, { cause: processError }));
        return;
      }
      try {
        resolvePromise(Object.freeze({
          exitCode: code ?? 1,
          stdout: decodeOutput(stdout, "stdout"),
          stderr: decodeOutput(stderr, "stderr"),
        }));
      } catch (error) {
        rejectPromise(error);
      }
    };
    const collect = (stream: Readable, chunks: Buffer[]): void => {
      stream.on("data", (value: Buffer | string) => {
        if (settled) return;
        const chunk = typeof value === "string" ? Buffer.from(value) : value;
        const available = Math.max(0, MAX_OUTPUT_BYTES - outputBytes);
        const accepted = chunk.subarray(0, available);
        if (accepted.byteLength > 0) chunks.push(Buffer.from(accepted));
        outputBytes += accepted.byteLength;
        if (accepted.byteLength < chunk.byteLength) {
          overflow = true;
          terminate();
        }
      });
    };
    const abort = (): void => {
      cancelled = true;
      terminate();
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, hook.timeoutMs);

    collect(child.stdout, stdout);
    collect(child.stderr, stderr);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.once("error", (error) => {
      processError = error;
      if (!child.pid) finish(null);
    });
    child.once("close", finish);
    child.stdin.on("error", () => undefined);
    child.stdin.end(payload, "utf8");
  });
}

function payloadJson(
  options: HookEngineOptions,
  event: HookEvent,
  data: JsonObject,
): string {
  for (const key of RESERVED_PAYLOAD_FIELDS) {
    if (key in data) throw new ConfigurationError(`hook data가 예약 field ${key}을 덮어쓸 수 없습니다.`);
  }
  let payload: string;
  try {
    payload = JSON.stringify({
      ...data,
      session_id: options.sessionId,
      transcript_path: options.transcriptPath,
      cwd: options.workspace,
      permission_mode: options.permissionMode(),
      hook_event_name: event,
    }) + "\n";
  } catch (error) {
    throw new HookError(`${event} hook 입력을 JSON으로 만들 수 없습니다.`, { cause: error });
  }
  if (Buffer.byteLength(payload, "utf8") > MAX_INPUT_BYTES) {
    throw new HookError(`${event} hook 입력이 ${MAX_INPUT_BYTES} bytes 제한을 초과했습니다.`);
  }
  return payload;
}

function structuredOutput(stdout: string, event: HookEvent): Record<string, unknown> | undefined {
  if (!stdout) return undefined;
  try {
    const value = JSON.parse(stdout) as unknown;
    if (!record(value)) throw new HookError(`${event} hook JSON 출력은 객체여야 합니다.`);
    return value;
  } catch (error) {
    if (error instanceof HookError) throw error;
    return undefined;
  }
}

function additionalContext(
  structured: Record<string, unknown> | undefined,
  plain: string,
  event: HookEvent,
): string | undefined {
  if (!CONTEXT_EVENTS.has(event)) return undefined;
  const specificValue = structured?.hookSpecificOutput;
  if (specificValue !== undefined && !record(specificValue)) {
    throw new HookError(`${event} hookSpecificOutput은 객체여야 합니다.`);
  }
  const specific = record(specificValue) ? specificValue : undefined;
  const value = specific?.additionalContext ?? structured?.additionalContext;
  if (value !== undefined && typeof value !== "string") {
    throw new HookError(`${event} additionalContext는 문자열이어야 합니다.`);
  }
  return typeof value === "string" ? value : structured === undefined ? plain : undefined;
}

function preToolDenial(
  structured: Record<string, unknown> | undefined,
): string | undefined {
  const specificValue = structured?.hookSpecificOutput;
  if (specificValue !== undefined && !record(specificValue)) {
    throw new HookError("PreToolUse hookSpecificOutput은 객체여야 합니다.");
  }
  const specific = record(specificValue) ? specificValue : undefined;
  if (specific?.permissionDecision !== "deny") return undefined;
  const reason = specific.permissionDecisionReason;
  return typeof reason === "string" && reason.trim()
    ? reason.trim()
    : "PreToolUse hook이 도구 실행을 거부했습니다.";
}

export class HookEngine {
  readonly implementation: "none" | "configured";
  readonly #options: HookEngineOptions;
  readonly #groups: ReadonlyMap<HookEvent, readonly HookGroup[]>;
  readonly #redactor: Redactor;
  #sessionId: string;
  #transcriptPath: string;
  #running = false;

  constructor(options: HookEngineOptions) {
    if (!options.workspace || options.workspace.includes("\0")) {
      throw new ConfigurationError("Hook workspace 경로가 올바르지 않습니다.");
    }
    if (!options.sessionId || !options.transcriptPath) {
      throw new ConfigurationError("Hook session 정보가 올바르지 않습니다.");
    }
    this.#groups = parseHooks(options.hooks);
    if (this.#groups.size > 0 && !options.workspaceTrusted) {
      throw new ConfigurationError("신뢰하지 않은 workspace의 hook은 구성할 수 없습니다.");
    }
    this.#options = options;
    this.#redactor = options.redactor ?? new Redactor();
    this.#sessionId = options.sessionId;
    this.#transcriptPath = options.transcriptPath;
    this.implementation = this.#groups.size === 0 ? "none" : "configured";
  }

  setSession(sessionId: string, transcriptPath: string): void {
    if (this.#running) throw new HookError("Hook 실행 중에는 session을 바꿀 수 없습니다.");
    if (!sessionId || !transcriptPath || sessionId.includes("\0") || transcriptPath.includes("\0")) {
      throw new ConfigurationError("Hook session 정보가 올바르지 않습니다.");
    }
    this.#sessionId = sessionId;
    this.#transcriptPath = transcriptPath;
  }

  async run(
    event: HookEvent,
    matchValue = "",
    data: JsonObject = {},
    signal?: AbortSignal,
  ): Promise<HookOutcome> {
    if (!EVENT_NAMES.has(event)) throw new ConfigurationError(`지원하지 않는 hook event입니다: ${event}`);
    if (this.#running) throw new HookError("Hook은 다른 hook 실행 중에 재진입할 수 없습니다.");
    if (matchValue.includes("\0") || Buffer.byteLength(matchValue, "utf8") > MAX_INPUT_BYTES) {
      throw new ConfigurationError("Hook matcher 입력 형식 또는 크기가 올바르지 않습니다.");
    }
    const context: string[] = [];
    const notices: string[] = [];
    let contextBytes = 0;
    let noticeBytes = 0;
    const report = (message: string): void => {
      if (notices.length >= MAX_NOTICES || noticeBytes >= MAX_NOTICE_BYTES) return;
      const safe = cleanHookText(message, this.#redactor);
      const selected = utf8Prefix(safe, MAX_NOTICE_BYTES - noticeBytes);
      if (!selected) return;
      notices.push(selected);
      noticeBytes += Buffer.byteLength(selected, "utf8");
      this.#options.onNotice?.(selected);
    };
    this.#running = true;
    try {
      const runtimeOptions: HookEngineOptions = {
        ...this.#options,
        sessionId: this.#sessionId,
        transcriptPath: this.#transcriptPath,
      };
      let payload: string | undefined;
      for (const group of this.#groups.get(event) ?? []) {
        if (!matches(group, matchValue)) continue;
        for (const hook of group.hooks) {
          payload ??= payloadJson(runtimeOptions, event, data);
          const result = await executeHook(hook, runtimeOptions, event, payload, signal);
          const stdout = result.stdout.trim();
          const stderr = result.stderr.trim();
          if (result.exitCode === 2 && BLOCKABLE_EVENTS.has(event)) {
            const reason = utf8Prefix(
              cleanHookText(stderr || `${event} hook이 작업을 차단했습니다.`, this.#redactor),
              MAX_REASON_BYTES,
            );
            report(reason);
            return Object.freeze({
              blocked: true,
              reason,
              context: Object.freeze([...context]),
              notices: Object.freeze([...notices]),
            });
          }
          if (result.exitCode !== 0) {
            report(
              `${event} hook 오류: ${utf8Prefix(
                cleanHookText(stderr.split("\n", 1)[0] || `exit ${result.exitCode}`, this.#redactor),
                MAX_REASON_BYTES,
              )}`,
            );
            continue;
          }
          if (!stdout) continue;
          const structured = structuredOutput(stdout, event);
          if (event === "PreToolUse") {
            const denial = preToolDenial(structured);
            if (denial) {
              const reason = utf8Prefix(cleanHookText(denial, this.#redactor), MAX_REASON_BYTES);
              report(reason);
              return Object.freeze({
                blocked: true,
                reason,
                context: Object.freeze([...context]),
                notices: Object.freeze([...notices]),
              });
            }
          }
          const additional = additionalContext(structured, stdout, event);
          if (additional !== undefined && additional.length > 0) {
            const safe = cleanHookText(additional, this.#redactor);
            const bytes = Buffer.byteLength(safe, "utf8");
            if (contextBytes + bytes > MAX_CONTEXT_BYTES) {
              throw new HookError(`${event} hook context가 ${MAX_CONTEXT_BYTES} bytes 제한을 초과했습니다.`);
            }
            context.push(safe);
            contextBytes += bytes;
          }
        }
      }
      return Object.freeze({
        blocked: false,
        reason: "",
        context: Object.freeze(context),
        notices: Object.freeze(notices),
      });
    } finally {
      this.#running = false;
    }
  }
}

export class HookToolPort implements ToolHookPort {
  readonly implementation = "configured" as const;

  constructor(readonly hooks: HookEngine) {}

  async beforeTool(
    request: ToolBoundaryRequest,
  ): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    const outcome = await this.hooks.run(
      "PreToolUse",
      request.toolName,
      {
        tool_name: request.toolName,
        tool_input: request.input as JsonObject,
      },
      request.context.signal,
    );
    return outcome.blocked
      ? { allowed: false, reason: outcome.reason }
      : { allowed: true };
  }

  async afterTool(
    request: ToolBoundaryRequest,
    result: ToolExecutionResult,
  ): Promise<void> {
    const event: HookEvent = result.status === "success" ? "PostToolUse" : "PostToolUseFailure";
    await this.hooks.run(
      event,
      request.toolName,
      {
        tool_name: request.toolName,
        tool_input: request.input as JsonObject,
        tool_response: result as unknown as JsonValue,
      },
      request.context.signal,
    );
  }
}

import type { JsonObject, JsonValue } from "../core/json.js";
import type { ProviderToolSpec } from "../core/provider.js";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolFailure,
} from "../core/index.js";
import { CatError, PermissionDeniedError } from "../core/errors.js";
import { Redactor } from "../security/redaction.js";
import type {
  ApprovalScope,
  PermissionCheck,
} from "../security/permissions.js";
import { PermissionPolicy } from "../security/permissions.js";
import {
  assertSupportedToolSchema,
  ToolInputValidationError,
  validateToolInput,
} from "./schema.js";

export const BUILTIN_TOOL_NAMES = [
  "list_files",
  "read_file",
  "search_text",
  "edit_file",
  "write_file",
  "apply_patch",
  "update_plan",
  "request_user_input",
  "load_skill",
  "web_search",
  "fetch_url",
  "run_command",
  "list_tasks",
  "get_task_output",
  "stop_task",
  "list_mcp_servers",
  "add_mcp_server",
  "remove_mcp_server",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export interface ToolPreflightResult {
  summary: string;
  approvalScope: ApprovalScope;
}

export interface ToolRegistration {
  definition: ToolDefinition;
  preflight?: (
    input: JsonObject,
    context: ToolExecutionContext,
  ) => Promise<ToolPreflightResult>;
  revalidate?: (
    input: JsonObject,
    context: ToolExecutionContext,
    preflight: ToolPreflightResult,
  ) => Promise<void>;
}

export interface ToolBoundaryRequest {
  toolName: string;
  input: Readonly<JsonObject>;
  context: ToolExecutionContext;
  preflight: ToolPreflightResult;
}

export interface ToolHookPort {
  readonly implementation: "none" | "configured";
  beforeTool(request: ToolBoundaryRequest): Promise<{ allowed: true } | { allowed: false; reason: string }>;
  afterTool(request: ToolBoundaryRequest, result: ToolExecutionResult): Promise<void>;
}

/** P09 전까지 hook 실행을 가장하지 않는 명시적인 빈 port다. */
export class NoopToolHookPort implements ToolHookPort {
  readonly implementation = "none" as const;

  async beforeTool(_request: ToolBoundaryRequest): Promise<{ allowed: true }> {
    return { allowed: true };
  }

  async afterTool(_request: ToolBoundaryRequest, _result: ToolExecutionResult): Promise<void> {}
}

export interface CentralToolExecutorOptions {
  policy: PermissionPolicy;
  hooks?: ToolHookPort;
  redactor?: Redactor;
}

interface InternalRegistration {
  definition: ToolDefinition;
  preflight: NonNullable<ToolRegistration["preflight"]>;
  revalidate: NonNullable<ToolRegistration["revalidate"]>;
}

const registryContents = new WeakMap<ToolRegistry, Map<string, InternalRegistration>>();
const BUILTIN_ORDER = new Map<string, number>(
  BUILTIN_TOOL_NAMES.map((name, index) => [name, index] as const),
);
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,127}$/u;
const MIN_OUTPUT_BYTES = 1_024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function contents(registry: ToolRegistry): Map<string, InternalRegistration> {
  const registered = registryContents.get(registry);
  if (!registered) throw new Error("도구 registry가 초기화되지 않았습니다.");
  return registered;
}

function cloneJsonObject(value: JsonObject): JsonObject {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("도구 schema를 JSON으로 복제할 수 없습니다.");
  return JSON.parse(serialized) as JsonObject;
}

function defaultPreflight(
  definition: ToolDefinition,
  input: JsonObject,
): ToolPreflightResult {
  return {
    summary: definition.description,
    approvalScope: { kind: "invocation", target: { input } },
  };
}

export class ToolRegistry {
  constructor() {
    registryContents.set(this, new Map());
  }

  register(registration: ToolRegistration): void {
    const definition = registration.definition;
    if (!TOOL_NAME_PATTERN.test(definition.name)) {
      throw new Error("도구 이름 형식이 올바르지 않습니다.");
    }
    if (!BUILTIN_ORDER.has(definition.name)) {
      throw new Error(`현재 단계의 built-in registry에는 ${definition.name} 도구를 등록할 수 없습니다.`);
    }
    if (!definition.description.trim() || definition.description.length > 4_096) {
      throw new Error(`${definition.name} 도구 설명이 올바르지 않습니다.`);
    }
    if (
      !Number.isSafeInteger(definition.outputLimitBytes) ||
      definition.outputLimitBytes < MIN_OUTPUT_BYTES ||
      definition.outputLimitBytes > MAX_OUTPUT_BYTES
    ) {
      throw new Error(`${definition.name} 도구 출력 제한이 올바르지 않습니다.`);
    }
    assertSupportedToolSchema(definition.inputSchema, definition.name);
    const registered = contents(this);
    if (registered.has(definition.name)) {
      throw new Error(`${definition.name} 도구가 중복 등록되었습니다.`);
    }
    const storedDefinition: ToolDefinition = {
      ...definition,
      inputSchema: cloneJsonObject(definition.inputSchema),
    };
    registered.set(definition.name, {
      definition: storedDefinition,
      preflight: registration.preflight ?? (async (input) => defaultPreflight(storedDefinition, input)),
      revalidate: registration.revalidate ?? (async () => undefined),
    });
  }

  implementedNames(): readonly string[] {
    return [...contents(this).keys()].sort(
      (left, right) => (BUILTIN_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (BUILTIN_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER),
    );
  }
}

function providerSpec(registration: InternalRegistration): ProviderToolSpec {
  return {
    name: registration.definition.name,
    description: registration.definition.description,
    inputSchema: cloneJsonObject(registration.definition.inputSchema),
    strict: true,
  };
}

function requiresTrustedWorkspace(definition: ToolDefinition): boolean {
  return definition.permission.kind === "workspace" ||
    definition.permission.kind === "command" ||
    definition.permission.kind === "external";
}

function failure(code: string, message: string, execution: "not_started" | "failed" | "unknown", retryable = false): ToolExecutionResult {
  return { status: "failure", error: { code, message, retryable }, execution };
}

function safeMessage(value: string, redactor: Redactor, maximumBytes = 8_192): string {
  const redacted = redactor.redact(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�");
  const bytes = Buffer.from(redacted, "utf8");
  if (bytes.byteLength <= maximumBytes) return redacted;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}…`;
}

function redactJson(value: JsonValue, redactor: Redactor, depth = 0): JsonValue {
  if (typeof value === "string") return redactor.redact(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 32) return "[출력 중첩 생략]";
  if (Array.isArray(value)) return value.slice(0, 20_000).map((item) => redactJson(item, redactor, depth + 1));
  const result: JsonObject = {};
  let count = 0;
  for (const [key, child] of Object.entries(value)) {
    count += 1;
    if (count > 20_000) {
      result.output_notice = "[출력 항목 생략]";
      break;
    }
    result[key] = redactJson(child, redactor, depth + 1);
  }
  return result;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function boundedOutput(
  content: JsonValue,
  limit: number,
): { content: JsonValue; truncated: boolean; omittedBytes?: number } {
  const serialized = JSON.stringify(content);
  if (serialized === undefined) {
    return {
      content: { output_notice: "도구 출력을 JSON으로 표현할 수 없습니다." },
      truncated: true,
    };
  }
  const totalBytes = Buffer.byteLength(serialized, "utf8");
  if (totalBytes <= limit) return { content, truncated: false };
  let previewBytes = Math.max(0, Math.floor((limit - 256) / 2));
  let bounded: JsonObject;
  while (true) {
    bounded = {
      preview: utf8Prefix(serialized, previewBytes),
      output_notice: `도구 출력이 ${limit} bytes 제한에서 잘렸습니다.`,
    };
    if (Buffer.byteLength(JSON.stringify(bounded), "utf8") <= limit || previewBytes === 0) break;
    previewBytes = Math.floor(previewBytes / 2);
  }
  return {
    content: bounded,
    truncated: true,
    omittedBytes: Math.max(0, totalBytes - previewBytes),
  };
}

function addWarning(result: ToolExecutionResult, warning: ToolFailure): ToolExecutionResult {
  return { ...result, warnings: [...(result.warnings ?? []), warning] };
}

function sanitizeFailure(
  failureValue: ToolFailure,
  redactor: Redactor,
  maximumDetailsBytes: number,
): ToolFailure {
  const details = failureValue.details === undefined
    ? undefined
    : boundedOutput(
        redactJson(failureValue.details, redactor),
        Math.max(256, maximumDetailsBytes),
      ).content;
  return {
    ...failureValue,
    message: safeMessage(failureValue.message, redactor),
    ...(details === undefined ? {} : { details }),
  };
}

function sanitizeResult(
  result: ToolExecutionResult,
  definition: ToolDefinition,
  redactor: Redactor,
): ToolExecutionResult {
  const warnings = result.warnings?.map((warning) =>
    sanitizeFailure(warning, redactor, 4_096)
  );
  if (result.status === "success") {
    const bounded = boundedOutput(redactJson(result.output.content, redactor), definition.outputLimitBytes);
    const output = {
      ...bounded,
      truncated: result.output.truncated || bounded.truncated,
      ...((result.output.omittedBytes ?? 0) + (bounded.omittedBytes ?? 0) > 0
        ? { omittedBytes: (result.output.omittedBytes ?? 0) + (bounded.omittedBytes ?? 0) }
        : {}),
    };
    return { status: "success", output, ...(warnings ? { warnings } : {}) };
  }
  if (result.status === "failure") {
    return {
      ...result,
      error: sanitizeFailure(
        result.error,
        redactor,
        definition.outputLimitBytes - 16_384,
      ),
      ...(warnings ? { warnings } : {}),
    };
  }
  return {
    ...result,
    ...(result.status === "denied"
      ? { reason: safeMessage(result.reason, redactor) }
      : result.reason
        ? { reason: safeMessage(result.reason, redactor) }
        : {}),
    ...(warnings ? { warnings } : {}),
  };
}

export class CentralToolExecutor {
  readonly #registry: ToolRegistry;
  readonly #policy: PermissionPolicy;
  readonly #hooks: ToolHookPort;
  readonly #redactor: Redactor;

  constructor(registry: ToolRegistry, options: CentralToolExecutorOptions) {
    this.#registry = registry;
    this.#policy = options.policy;
    this.#hooks = options.hooks ?? new NoopToolHookPort();
    this.#redactor = options.redactor ?? new Redactor();
  }

  providerTools(): readonly ProviderToolSpec[] {
    return [...contents(this.#registry).values()]
      .filter((registration) => this.#policy.exposes(
        registration.definition.name,
        registration.definition.category,
      ))
      .sort(
        (left, right) =>
          (BUILTIN_ORDER.get(left.definition.name) ?? Number.MAX_SAFE_INTEGER) -
          (BUILTIN_ORDER.get(right.definition.name) ?? Number.MAX_SAFE_INTEGER),
      )
      .map(providerSpec);
  }

  async execute(
    toolName: string,
    rawInput: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (!TOOL_NAME_PATTERN.test(toolName)) {
      return failure(
        "unknown_tool",
        safeMessage("도구 이름이 올바르지 않거나 등록되지 않았습니다.", this.#redactor),
        "not_started",
      );
    }
    const registration = contents(this.#registry).get(toolName);
    if (!registration) {
      return failure(
        "unknown_tool",
        safeMessage(`등록되지 않았거나 비활성화된 도구입니다: ${toolName}`, this.#redactor),
        "not_started",
      );
    }
    let input: JsonObject;
    try {
      input = validateToolInput(rawInput, registration.definition.inputSchema, toolName);
    } catch (error) {
      const message = error instanceof ToolInputValidationError
        ? error.message
        : `${toolName} 입력을 검증하지 못했습니다.`;
      return sanitizeResult(failure("invalid_tool_input", message, "not_started"), registration.definition, this.#redactor);
    }
    const hardDenial = this.#policy.hardDenial(toolName);
    if (hardDenial) {
      return sanitizeResult({ status: "denied", reason: hardDenial }, registration.definition, this.#redactor);
    }
    if (requiresTrustedWorkspace(registration.definition) && !context.workspaceTrusted) {
      return sanitizeResult(
        { status: "denied", reason: "신뢰하지 않은 workspace에서는 이 도구를 실행할 수 없습니다." },
        registration.definition,
        this.#redactor,
      );
    }

    let preflight: ToolPreflightResult;
    try {
      preflight = await registration.preflight(input, context);
    } catch (error) {
      if (error instanceof PermissionDeniedError) {
        return sanitizeResult({ status: "denied", reason: error.message }, registration.definition, this.#redactor);
      }
      const message = error instanceof Error ? error.message : "도구 실행 대상을 확인하지 못했습니다.";
      return sanitizeResult(failure("tool_preflight_failed", message, "not_started"), registration.definition, this.#redactor);
    }

    const boundaryRequest: ToolBoundaryRequest = { toolName, input, context, preflight };
    let hookDecision: Awaited<ReturnType<ToolHookPort["beforeTool"]>>;
    try {
      hookDecision = await this.#hooks.beforeTool(boundaryRequest);
    } catch {
      return sanitizeResult(
        { status: "denied", reason: "도구 사전 hook 확인에 실패해 실행하지 않았습니다." },
        registration.definition,
        this.#redactor,
      );
    }
    if (!hookDecision.allowed) {
      return sanitizeResult({ status: "denied", reason: hookDecision.reason }, registration.definition, this.#redactor);
    }

    const permissionCheck: PermissionCheck = {
      toolName,
      category: registration.definition.category,
      permission: registration.definition.permission,
      summary: preflight.summary,
      scope: preflight.approvalScope,
      workspace: context.workspace,
      sessionId: context.sessionId,
      runId: context.runId,
      signal: context.signal,
    };
    const authorization = await this.#policy.authorize(permissionCheck);
    if (!authorization.allowed) {
      const result: ToolExecutionResult = authorization.cancelled
        ? { status: "cancelled", reason: authorization.reason }
        : { status: "denied", reason: authorization.reason };
      return sanitizeResult(result, registration.definition, this.#redactor);
    }
    if (context.signal.aborted) {
      return { status: "cancelled", reason: "도구 실행 전에 작업이 취소되었습니다." };
    }
    try {
      await registration.revalidate(input, context, preflight);
    } catch (error) {
      if (error instanceof PermissionDeniedError) {
        return sanitizeResult({ status: "denied", reason: error.message }, registration.definition, this.#redactor);
      }
      const message = error instanceof Error ? error.message : "승인 뒤 실행 대상을 다시 확인하지 못했습니다.";
      return sanitizeResult(failure("tool_target_changed", message, "not_started"), registration.definition, this.#redactor);
    }
    if (context.signal.aborted) {
      return { status: "cancelled", reason: "도구 실행 직전에 작업이 취소되었습니다." };
    }

    let result: ToolExecutionResult;
    try {
      result = await registration.definition.handler(input, context);
    } catch (error) {
      if (context.signal.aborted) {
        result = { status: "cancelled", reason: "도구 실행 중 작업이 취소되었습니다." };
      } else if (error instanceof PermissionDeniedError) {
        result = { status: "denied", reason: error.message };
      } else {
        const message = error instanceof Error ? error.message : "도구 handler에서 알 수 없는 오류가 발생했습니다.";
        const code = error instanceof CatError ? error.code : "tool_handler_failed";
        const execution = registration.definition.category === "read" || registration.definition.category === "web"
          ? "failed"
          : "unknown";
        result = failure(code, message, execution);
      }
    }

    try {
      await this.#hooks.afterTool(boundaryRequest, result);
    } catch {
      result = addWarning(result, {
        code: "post_tool_hook_failed",
        message: "도구 실행 뒤 hook 처리에 실패했습니다. 이미 끝난 도구는 다시 실행하지 않았습니다.",
        retryable: false,
      });
    }
    return sanitizeResult(result, registration.definition, this.#redactor);
  }
}

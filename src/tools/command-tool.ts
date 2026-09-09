import { stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { JsonObject, JsonValue } from "../core/json.js";
import type { ToolExecutionContext, ToolExecutionResult } from "../core/index.js";
import { ConfigurationError, PermissionDeniedError } from "../core/errors.js";
import { captureChildProcess } from "../process/child-process.js";
import {
  assertShellCommandAllowed,
  validateShellCommand,
} from "../security/command-policy.js";
import { buildChildEnvironment } from "../security/environment.js";
import { listSensitiveStoragePaths } from "../security/sensitive-paths.js";
import type { StoragePaths } from "../storage/paths.js";
import { canonicalWorkspace } from "../storage/paths.js";
import { stringArgument } from "./file-common.js";
import type { ToolPreflightResult } from "./runtime.js";
import { ToolRegistry } from "./runtime.js";

const MAX_COMMAND_CODE_POINTS = 32_000;
const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;
const COMMAND_TOOL_OUTPUT_BYTES = 1024 * 1024;

export interface ForegroundCommandToolOptions {
  paths: StoragePaths;
  userHome?: string;
}

interface WorkspaceIdentity {
  path: string;
  device: number;
  inode: number;
}

function objectSchema(properties: JsonObject, required: readonly string[]): JsonObject {
  return {
    type: "object",
    properties,
    required: [...required],
    additionalProperties: false,
  };
}

function identityMatches(actual: Stats, expected: WorkspaceIdentity): boolean {
  if (!actual.isDirectory() || actual.dev !== expected.device) return false;
  return process.platform === "win32" && (actual.ino === 0 || expected.inode === 0)
    ? true
    : actual.ino === expected.inode;
}

async function captureWorkspaceIdentity(workspace: string): Promise<WorkspaceIdentity> {
  const path = await canonicalWorkspace(workspace);
  const info = await stat(path);
  return { path, device: info.dev, inode: info.ino };
}

async function assertWorkspaceUnchanged(
  expected: WorkspaceIdentity,
  context: ToolExecutionContext,
): Promise<void> {
  const contextPath = await canonicalWorkspace(context.workspace);
  if (contextPath !== expected.path) {
    throw new PermissionDeniedError(
      "도구 실행 context의 workspace가 등록된 workspace와 다릅니다.",
    );
  }
  const currentPath = await canonicalWorkspace(expected.path);
  const info = await stat(currentPath);
  if (currentPath !== expected.path || !identityMatches(info, expected)) {
    throw new PermissionDeniedError("명령 실행 전에 workspace identity가 변경되었습니다.");
  }
}

function cleanCapturedText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "�");
}

function commandDetails(
  result: Awaited<ReturnType<typeof captureChildProcess>>,
  workspace: string,
): JsonObject {
  return {
    ok: result.exitCode === 0 &&
      !result.timedOut &&
      !result.cancelled &&
      !result.outputLimitReached &&
      result.spawnErrorMessage === undefined,
    started: result.started,
    cwd: workspace,
    exit_code: result.exitCode,
    exit_signal: result.exitSignal,
    timed_out: result.timedOut,
    cancelled: result.cancelled,
    output_limit_reached: result.outputLimitReached,
    stdout: cleanCapturedText(result.stdout),
    stderr: cleanCapturedText(result.stderr),
    output_truncated: result.outputLimitReached,
  };
}

function commandFailure(
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

export async function registerForegroundCommandTool(
  registry: ToolRegistry,
  options: ForegroundCommandToolOptions,
): Promise<void> {
  const workspace = await captureWorkspaceIdentity(options.paths.workspace);
  const policyOptions = {
    protectedPaths: listSensitiveStoragePaths(options.paths, options.userHome),
    protectedRoots: [workspace.path],
  };

  const inspect = async (
    input: JsonObject,
    context: ToolExecutionContext,
  ): Promise<{ command: string; timeoutSeconds: number }> => {
    if (input.background !== false) {
      throw new ConfigurationError(
        "background 명령은 P12 작업 관리자 연결 전까지 지원하지 않습니다.",
      );
    }
    const command = validateShellCommand(stringArgument(input, "command"));
    const timeoutSeconds = input.timeout_seconds;
    if (
      typeof timeoutSeconds !== "number" ||
      !Number.isSafeInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > 300
    ) {
      throw new ConfigurationError("timeout_seconds는 1–300 사이의 정수여야 합니다.");
    }
    assertShellCommandAllowed(command, policyOptions);
    await assertWorkspaceUnchanged(workspace, context);
    return { command, timeoutSeconds };
  };

  registry.register({
    definition: {
      name: "run_command",
      description: "Run /bin/sh in the registered workspace with bounded foreground output; background execution is unavailable until P12.",
      inputSchema: objectSchema(
        {
          command: {
            type: "string",
            description: "Exact shell command to run",
            minLength: 1,
            maxLength: MAX_COMMAND_CODE_POINTS,
          },
          timeout_seconds: {
            type: "integer",
            description: "Foreground timeout in seconds",
            minimum: 1,
            maximum: 300,
          },
          background: {
            type: "boolean",
            description: "Must be false until the managed task service is added in P12",
          },
        },
        ["command", "timeout_seconds", "background"],
      ),
      category: "shell",
      permission: { kind: "command" },
      outputLimitBytes: COMMAND_TOOL_OUTPUT_BYTES,
      handler: async (input, context) => {
        let inspected: { command: string; timeoutSeconds: number };
        try {
          inspected = await inspect(input, context);
        } catch (error) {
          if (error instanceof PermissionDeniedError) {
            return { status: "denied", reason: error.message };
          }
          return commandFailure(
            "command_target_changed",
            error instanceof Error ? error.message : "명령 실행 대상을 다시 확인하지 못했습니다.",
            "not_started",
          );
        }
        if (context.signal.aborted) {
          return { status: "cancelled", reason: "명령 실행 직전에 작업이 취소되었습니다." };
        }
        let environment: NodeJS.ProcessEnv;
        try {
          environment = buildChildEnvironment();
        } catch (error) {
          return commandFailure(
            "command_environment_invalid",
            error instanceof Error ? error.message : "최소 child environment를 구성하지 못했습니다.",
            "not_started",
          );
        }
        const completed = await captureChildProcess(
          "/bin/sh",
          ["-c", inspected.command],
          {
            cwd: workspace.path,
            environment,
            timeoutMs: inspected.timeoutSeconds * 1_000,
            maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
            signal: context.signal,
          },
        );
        const details = commandDetails(completed, workspace.path);
        if (completed.spawnErrorMessage !== undefined) {
          return commandFailure(
            "command_spawn_failed",
            completed.spawnErrorCode
              ? `셸 프로세스를 시작하지 못했습니다(${completed.spawnErrorCode}).`
              : "셸 프로세스를 시작하지 못했습니다.",
            completed.started ? "unknown" : "not_started",
            details,
          );
        }
        if (completed.cancelled) {
          return commandFailure(
            "command_cancelled_after_start",
            "명령 실행을 취소했습니다. 이미 수행된 변경은 남아 있을 수 있습니다.",
            "unknown",
            details,
          );
        }
        if (completed.timedOut) {
          return commandFailure(
            "command_timed_out",
            `명령 실행이 ${inspected.timeoutSeconds}초를 초과해 중지됐습니다. 이미 수행된 변경은 남아 있을 수 있습니다.`,
            "unknown",
            details,
          );
        }
        if (completed.outputLimitReached) {
          return commandFailure(
            "command_output_limit_reached",
            "명령 출력이 1 MB 수집 제한에 도달해 중지됐습니다. 이미 수행된 변경은 남아 있을 수 있습니다.",
            "unknown",
            details,
          );
        }
        if (completed.exitCode !== 0) {
          if (completed.exitCode === null && completed.exitSignal === null) {
            return commandFailure(
              "command_status_unknown",
              "셸 프로세스의 종료 상태를 확인하지 못했습니다. 이미 수행된 변경은 남아 있을 수 있습니다.",
              "unknown",
              details,
            );
          }
          return commandFailure(
            "command_failed",
            completed.exitSignal
              ? `명령이 ${completed.exitSignal} signal로 종료됐습니다.`
              : `명령이 종료 코드 ${completed.exitCode ?? "unknown"}로 실패했습니다.`,
            "failed",
            details,
          );
        }
        return {
          status: "success",
          output: { content: details, truncated: false },
        };
      },
    },
    preflight: async (input, context): Promise<ToolPreflightResult> => {
      const inspected = await inspect(input, context);
      return {
        summary: `명령 실행\ncwd: ${workspace.path}\ntimeout: ${inspected.timeoutSeconds}초\ncommand: ${inspected.command}`,
        approvalScope: {
          kind: "command",
          target: {
            command: inspected.command,
            cwd: workspace.path,
            timeout_seconds: inspected.timeoutSeconds,
            background: false,
          },
        },
      };
    },
    revalidate: async (input, context, preflight) => {
      const inspected = await inspect(input, context);
      const currentTarget: JsonObject = {
        command: inspected.command,
        cwd: workspace.path,
        timeout_seconds: inspected.timeoutSeconds,
        background: false,
      };
      if (JSON.stringify(currentTarget) !== JSON.stringify(preflight.approvalScope.target)) {
        throw new Error("승인 뒤 명령 또는 실행 대상이 변경되었습니다.");
      }
    },
  });
}

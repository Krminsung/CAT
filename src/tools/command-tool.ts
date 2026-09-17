import { stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { JsonObject, JsonValue } from "../core/json.js";
import type { ToolExecutionContext, ToolExecutionResult } from "../core/index.js";
import { ConfigurationError, PermissionDeniedError } from "../core/errors.js";
import { captureChildProcess } from "../process/child-process.js";
import {
  BackgroundTaskManager,
  type BackgroundTaskIdentity,
} from "../process/background-tasks.js";
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
const TASK_TOOL_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_BACKGROUND_DEADLINE_SECONDS = 3_600;
const MAX_BACKGROUND_DEADLINE_SECONDS = 86_400;
const DEFAULT_TASK_READ_BYTES = 60_000;
const MAX_TASK_READ_BYTES = 96 * 1024;
const MAX_TASK_LIST_COMMAND_BYTES = 1_024;
const MAX_TASK_LIST_ERROR_BYTES = 512;

export interface CommandToolOptions {
  paths: StoragePaths;
  tasks: BackgroundTaskManager;
  userHome?: string;
}

interface WorkspaceIdentity {
  path: string;
  device: number;
  inode: number;
}

type InspectedCommand =
  | {
      readonly command: string;
      readonly background: false;
      readonly timeoutSeconds: number;
    }
  | {
      readonly command: string;
      readonly background: true;
      readonly deadlineSeconds: number;
    };

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

function taskListText(value: string, maximumBytes: number, omitted: string): string {
  return Buffer.byteLength(value, "utf8") <= maximumBytes ? value : omitted;
}

function taskListSnapshot(task: JsonObject): JsonObject {
  const command = task.command;
  const outputError = task.output_error;
  const commandPreview = typeof command === "string"
    ? taskListText(command, MAX_TASK_LIST_COMMAND_BYTES, "[긴 command 생략]")
    : undefined;
  const errorPreview = typeof outputError === "string"
    ? taskListText(outputError, MAX_TASK_LIST_ERROR_BYTES, "[긴 오류 상세 생략]")
    : undefined;
  return {
    ...task,
    ...(commandPreview === undefined ? {} : { command: commandPreview }),
    ...(errorPreview === undefined ? {} : { output_error: errorPreview }),
    ...(commandPreview !== undefined && commandPreview !== command
      ? { command_truncated: true }
      : {}),
    ...(errorPreview !== undefined && errorPreview !== outputError
      ? { output_error_truncated: true }
      : {}),
  };
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
    termination_confirmed: result.terminationConfirmed ?? !result.started,
    process_group_id: result.processGroupId ?? null,
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

function containsBackgroundOperator(command: string): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (character === "\\") escaped = true;
      else if (character === '"') {
        quote = undefined;
        continue;
      } else if (character !== "&") {
        continue;
      }
      // 큰따옴표 안에는 command substitution이 올 수 있으므로 단독 &도 보수적으로 차단한다.
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character !== "&") continue;
    const previous = command[index - 1];
    const next = command[index + 1];
    if (previous === "&" || next === "&") continue;
    if ((previous === ">" || previous === "<") && (next === "-" || /[0-9]/u.test(next ?? ""))) {
      continue;
    }
    return true;
  }
  return false;
}

function commandApprovalTarget(
  inspected: InspectedCommand,
  workspace: string,
): JsonObject {
  return {
    command: inspected.command,
    cwd: workspace,
    background: inspected.background,
    ...(inspected.background
      ? { deadline_seconds: inspected.deadlineSeconds }
      : { timeout_seconds: inspected.timeoutSeconds }),
  };
}

function taskApprovalTarget(identity: BackgroundTaskIdentity, workspace: string): JsonObject {
  return {
    task_id: identity.taskId,
    session_id: identity.sessionId,
    started_at: identity.startedAt,
    command_digest: identity.commandDigest,
    cwd: workspace,
  };
}

export async function registerCommandTools(
  registry: ToolRegistry,
  options: CommandToolOptions,
): Promise<void> {
  const workspace = await captureWorkspaceIdentity(options.paths.workspace);
  const policyOptions = {
    protectedPaths: listSensitiveStoragePaths(options.paths, options.userHome),
    protectedRoots: [workspace.path],
  };

  const inspect = async (
    input: JsonObject,
    context: ToolExecutionContext,
  ): Promise<InspectedCommand> => {
    const command = validateShellCommand(stringArgument(input, "command"));
    if (containsBackgroundOperator(command)) {
      throw new ConfigurationError(
        "명령 문자열 내부의 background 연산자는 관리 process 소유권을 벗어날 수 있어 지원하지 않습니다. background field를 사용하세요.",
      );
    }
    const background = input.background;
    if (typeof background !== "boolean") {
      throw new ConfigurationError("background는 boolean이어야 합니다.");
    }
    if (background) {
      if (input.timeout_seconds !== undefined) {
        throw new ConfigurationError("timeout_seconds는 background=false일 때만 사용할 수 있습니다.");
      }
      const candidate = input.deadline_seconds ?? DEFAULT_BACKGROUND_DEADLINE_SECONDS;
      if (
        typeof candidate !== "number" ||
        !Number.isSafeInteger(candidate) ||
        candidate < 1 ||
        candidate > MAX_BACKGROUND_DEADLINE_SECONDS
      ) {
        throw new ConfigurationError(
          `deadline_seconds는 1–${MAX_BACKGROUND_DEADLINE_SECONDS} 사이의 정수여야 합니다.`,
        );
      }
      assertShellCommandAllowed(command, policyOptions);
      await assertWorkspaceUnchanged(workspace, context);
      return { command, background: true, deadlineSeconds: candidate };
    }
    if (input.deadline_seconds !== undefined) {
      throw new ConfigurationError("deadline_seconds는 background=true일 때만 사용할 수 있습니다.");
    }
    const timeoutSeconds = input.timeout_seconds;
    if (
      typeof timeoutSeconds !== "number" ||
      !Number.isSafeInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > 300
    ) {
      throw new ConfigurationError(
        "background=false일 때 timeout_seconds는 1–300 사이의 정수여야 합니다.",
      );
    }
    assertShellCommandAllowed(command, policyOptions);
    await assertWorkspaceUnchanged(workspace, context);
    return { command, background: false, timeoutSeconds };
  };

  registry.register({
    definition: {
      name: "run_command",
      description: "Run /bin/sh in the registered workspace. Foreground execution has a 1 MB capture and timeout; background=true creates a session-owned task with an 8 MiB tail and a separate deadline.",
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
            description: "Foreground timeout in seconds; required only when background=false",
            minimum: 1,
            maximum: 300,
          },
          background: {
            type: "boolean",
            description: "Start a managed session-owned background task",
          },
          deadline_seconds: {
            type: "integer",
            description: "Background lifetime deadline; optional only when background=true (default 3600)",
            minimum: 1,
            maximum: MAX_BACKGROUND_DEADLINE_SECONDS,
          },
        },
        ["command", "background"],
      ),
      category: "shell",
      permission: { kind: "command" },
      outputLimitBytes: COMMAND_TOOL_OUTPUT_BYTES,
      handler: async (input, context) => {
        let inspected: InspectedCommand;
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
        if (inspected.background) {
          try {
            const task = options.tasks.start({
              sessionId: context.sessionId,
              command: inspected.command,
              environment,
              deadlineSeconds: inspected.deadlineSeconds,
            });
            return {
              status: "success",
              output: {
                content: {
                  background: true,
                  cwd: workspace.path,
                  ...task,
                },
                truncated: false,
              },
            };
          } catch (error) {
            return commandFailure(
              "background_task_start_failed",
              error instanceof Error ? error.message : "background task를 시작하지 못했습니다.",
              "unknown",
            );
          }
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
        if (completed.terminationConfirmed === false) {
          return commandFailure(
            "command_cleanup_unknown",
            "직접 자식은 종료됐을 수 있지만 소유 프로세스 그룹의 정리를 확인하지 못했습니다. 후손이 계속 실행 중일 수 있습니다.",
            "unknown",
            details,
          );
        }
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
          if (!completed.started) {
            return {
              status: "cancelled",
              reason: "셸 프로세스를 시작하기 전에 작업이 취소되었습니다.",
            };
          }
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
        summary: inspected.background
          ? `background 명령 시작\ncwd: ${workspace.path}\ndeadline: ${inspected.deadlineSeconds}초\ncommand: ${inspected.command}`
          : `foreground 명령 실행\ncwd: ${workspace.path}\ntimeout: ${inspected.timeoutSeconds}초\ncommand: ${inspected.command}`,
        approvalScope: {
          kind: "command",
          target: commandApprovalTarget(inspected, workspace.path),
        },
      };
    },
    revalidate: async (input, context, preflight) => {
      const inspected = await inspect(input, context);
      const currentTarget = commandApprovalTarget(inspected, workspace.path);
      if (JSON.stringify(currentTarget) !== JSON.stringify(preflight.approvalScope.target)) {
        throw new Error("승인 뒤 명령 또는 실행 대상이 변경되었습니다.");
      }
    },
  });

  registry.register({
    definition: {
      name: "list_tasks",
      description: "List bounded background task snapshots owned by the current session only.",
      inputSchema: objectSchema({}, []),
      category: "read",
      permission: { kind: "workspace", access: "read" },
      outputLimitBytes: TASK_TOOL_OUTPUT_BYTES,
      handler: async (_input, context) => {
        await assertWorkspaceUnchanged(workspace, context);
        const tasks = options.tasks.list(context.sessionId).map(taskListSnapshot);
        return {
          status: "success",
          output: {
            content: {
              tasks: [...tasks],
              count: tasks.length,
              stale_scan_truncated: options.tasks.scanTruncated,
            },
            truncated: false,
          },
        };
      },
    },
    preflight: async (_input, context) => {
      await assertWorkspaceUnchanged(workspace, context);
      return {
        summary: "현재 세션이 소유한 background task 목록 조회",
        approvalScope: {
          kind: "workspace",
          target: { cwd: workspace.path, session_id: context.sessionId },
        },
      };
    },
    revalidate: async (_input, context, preflight) => {
      await assertWorkspaceUnchanged(workspace, context);
      const target: JsonObject = { cwd: workspace.path, session_id: context.sessionId };
      if (JSON.stringify(target) !== JSON.stringify(preflight.approvalScope.target)) {
        throw new Error("조회 전에 background task session 또는 workspace가 변경되었습니다.");
      }
    },
  });

  registry.register({
    definition: {
      name: "get_task_output",
      description: "Read a bounded output tail and status for one background task owned by the current session.",
      inputSchema: objectSchema(
        {
          task_id: {
            type: "string",
            description: "Exact task ID or an unambiguous prefix",
            pattern: "^[a-f0-9]{1,16}$",
            minLength: 1,
            maxLength: 16,
          },
          max_bytes: {
            type: "integer",
            description: "Maximum output tail bytes",
            minimum: 1,
            maximum: MAX_TASK_READ_BYTES,
          },
        },
        ["task_id"],
      ),
      category: "read",
      permission: { kind: "workspace", access: "read" },
      outputLimitBytes: TASK_TOOL_OUTPUT_BYTES,
      handler: async (input, context) => {
        await assertWorkspaceUnchanged(workspace, context);
        const maximumBytes = typeof input.max_bytes === "number"
          ? input.max_bytes
          : DEFAULT_TASK_READ_BYTES;
        const task = options.tasks.read(
          context.sessionId,
          stringArgument(input, "task_id"),
          maximumBytes,
        );
        return {
          status: "success",
          output: { content: task, truncated: false },
        };
      },
    },
    preflight: async (input, context) => {
      await assertWorkspaceUnchanged(workspace, context);
      const identity = options.tasks.identity(context.sessionId, stringArgument(input, "task_id"));
      return {
        summary: `현재 세션 background task 출력 조회: ${identity.taskId}`,
        approvalScope: {
          kind: "workspace",
          target: taskApprovalTarget(identity, workspace.path),
        },
      };
    },
    revalidate: async (input, context, preflight) => {
      await assertWorkspaceUnchanged(workspace, context);
      const identity = options.tasks.identity(context.sessionId, stringArgument(input, "task_id"));
      const target = taskApprovalTarget(identity, workspace.path);
      if (JSON.stringify(target) !== JSON.stringify(preflight.approvalScope.target)) {
        throw new Error("조회 전에 background task identity가 변경되었습니다.");
      }
    },
  });

  registry.register({
    definition: {
      name: "stop_task",
      description: "Stop one live background child owned by the current session; stale process IDs are never signalled.",
      inputSchema: objectSchema(
        {
          task_id: {
            type: "string",
            description: "Exact task ID or an unambiguous prefix",
            pattern: "^[a-f0-9]{1,16}$",
            minLength: 1,
            maxLength: 16,
          },
        },
        ["task_id"],
      ),
      category: "shell",
      permission: { kind: "command" },
      outputLimitBytes: TASK_TOOL_OUTPUT_BYTES,
      handler: async (input, context) => {
        await assertWorkspaceUnchanged(workspace, context);
        const result = await options.tasks.stop(
          context.sessionId,
          stringArgument(input, "task_id"),
        );
        const details: JsonObject = {
          ...result.task,
          stop_signal_sent: result.signalSent,
          termination_confirmed: result.terminationConfirmed,
          already_terminal: result.alreadyTerminal,
        };
        if (!result.terminationConfirmed && !result.alreadyTerminal) {
          return commandFailure(
            "background_task_stop_unconfirmed",
            "현재 process가 소유한 background child의 종료를 확인하지 못했습니다. stale PID에는 signal을 보내지 않았습니다.",
            "unknown",
            details,
          );
        }
        return {
          status: "success",
          output: { content: details, truncated: false },
        };
      },
    },
    preflight: async (input, context) => {
      await assertWorkspaceUnchanged(workspace, context);
      const identity = options.tasks.identity(context.sessionId, stringArgument(input, "task_id"));
      return {
        summary: `현재 세션 background task 중지: ${identity.taskId}`,
        approvalScope: {
          kind: "command",
          target: taskApprovalTarget(identity, workspace.path),
        },
      };
    },
    revalidate: async (input, context, preflight) => {
      await assertWorkspaceUnchanged(workspace, context);
      const identity = options.tasks.identity(context.sessionId, stringArgument(input, "task_id"));
      const target = taskApprovalTarget(identity, workspace.path);
      if (
        !options.tasks.identityMatches(identity) ||
        JSON.stringify(target) !== JSON.stringify(preflight.approvalScope.target)
      ) {
        throw new Error("승인 뒤 background task identity가 변경되었습니다.");
      }
    },
  });
}

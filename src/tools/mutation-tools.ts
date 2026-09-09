import { relative } from "node:path";
import type { JsonObject, JsonValue } from "../core/json.js";
import type { ToolExecutionContext, ToolExecutionResult } from "../core/index.js";
import { PermissionDeniedError } from "../core/errors.js";
import type {
  WorkspacePathGuard,
  WorkspacePathResolution,
} from "../security/workspace-path.js";
import {
  CheckpointManager,
  type CheckpointRestoreResult,
} from "../storage/checkpoints.js";
import {
  deleteWorkspaceFile,
  MAX_WORKSPACE_FILE_BYTES,
  WorkspaceFileOperationError,
  writeWorkspaceFileAtomic,
} from "../storage/workspace-file.js";
import {
  DEFAULT_TOOL_OUTPUT_BYTES,
  FileObservationStore,
  digestBytes,
  readWorkspaceUtf8File,
  stringArgument,
  toolSuccess,
} from "./file-common.js";
import {
  addedFileContent,
  applyPatchToText,
  parseWorkspacePatch,
  unifiedDiff,
  type WorkspacePatchSection,
} from "./patch.js";
import type { ToolPreflightResult } from "./runtime.js";
import { ToolRegistry } from "./runtime.js";

const MAX_TEXT_ARGUMENT_CODE_POINTS = 1_000_000;
const MAX_PATCH_CODE_POINTS = 900_000;

export interface WorkspaceMutationToolOptions {
  guard: WorkspacePathGuard;
  observations: FileObservationStore;
  checkpoints?: CheckpointManager;
}

export interface WorkspaceMutationServices {
  checkpoints: CheckpointManager;
  observations: FileObservationStore;
}

interface StagedMutation {
  action: "add" | "update" | "delete";
  displayPath: string;
  resolution: WorkspacePathResolution;
  before: Buffer | undefined;
  beforeText: string;
  after: Buffer | undefined;
  afterText: string;
}

function objectSchema(properties: JsonObject, required: readonly string[]): JsonObject {
  return {
    type: "object",
    properties,
    required: [...required],
    additionalProperties: false,
  };
}

function stringSchema(description: string, maximum: number): JsonObject {
  return { type: "string", description, maxLength: maximum };
}

function mutationFailure(
  code: string,
  message: string,
  execution: "not_started" | "failed" | "unknown",
): ToolExecutionResult {
  return {
    status: "failure",
    error: { code, message, retryable: false },
    execution,
  };
}

function validationFailure(code: string, error: unknown): ToolExecutionResult {
  if (error instanceof PermissionDeniedError) {
    return { status: "denied", reason: error.message };
  }
  return mutationFailure(
    code,
    error instanceof Error ? error.message : "변경 대상을 검증하지 못했습니다.",
    "not_started",
  );
}

function textBytes(value: string, label: string): Buffer {
  if (value.includes("\0")) throw new Error(`${label}에는 NUL 문자를 포함할 수 없습니다.`);
  const bytes = Buffer.from(value, "utf8");
  if (bytes.toString("utf8") !== value) {
    throw new Error(`${label}에 올바르지 않은 Unicode surrogate가 있습니다.`);
  }
  if (bytes.byteLength > MAX_WORKSPACE_FILE_BYTES) {
    throw new Error(`${label}이 ${MAX_WORKSPACE_FILE_BYTES} bytes 제한을 초과했습니다.`);
  }
  return bytes;
}

function countOccurrences(content: string, fragment: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = content.indexOf(fragment, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + fragment.length;
  }
}

function expectedCanonicalPath(preflight: ToolPreflightResult): string {
  const path = preflight.approvalScope.target.path;
  if (typeof path !== "string") throw new Error("변경 도구의 사전 검사 경로가 유실되었습니다.");
  return path;
}

function writableScopeTarget(resolved: WorkspacePathResolution): JsonObject {
  return {
    path: resolved.absolutePath,
    exists: resolved.exists,
    kind: resolved.kind,
    device: resolved.device === undefined ? null : String(resolved.device),
    inode: resolved.inode === undefined ? null : String(resolved.inode),
    parent_path: resolved.parentPath,
    parent_device: String(resolved.parentDevice),
    parent_inode: String(resolved.parentInode),
  };
}

async function mutationPathPreflight(
  guard: WorkspacePathGuard,
  requested: string,
  summary: string,
): Promise<ToolPreflightResult> {
  const resolved = await guard.resolveWritable(requested);
  return {
    summary,
    approvalScope: {
      kind: "path",
      target: {
        ...writableScopeTarget(resolved),
        access: "write",
      },
    },
  };
}

async function revalidateMutationPath(
  guard: WorkspacePathGuard,
  requested: string,
  preflight: ToolPreflightResult,
): Promise<void> {
  const current = await guard.resolveWritable(requested);
  const expected = preflight.approvalScope.target;
  const actual = { ...writableScopeTarget(current), access: "write" };
  if (
    current.absolutePath !== expectedCanonicalPath(preflight) ||
    JSON.stringify(actual) !== JSON.stringify(expected)
  ) {
    throw new PermissionDeniedError("승인 또는 검사 뒤 변경 대상이 바뀌었습니다.");
  }
}

function patchScopeFiles(preflight: ToolPreflightResult): readonly JsonValue[] {
  const files = preflight.approvalScope.target.files;
  if (!Array.isArray(files)) throw new Error("패치 사전 검사 대상이 유실되었습니다.");
  return files;
}

async function patchPreflight(
  guard: WorkspacePathGuard,
  patch: string,
): Promise<ToolPreflightResult> {
  const sections = parseWorkspacePatch(patch);
  const files: JsonValue[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    const resolved = await guard.resolveWritable(section.path);
    if (section.action === "add" ? resolved.exists : !resolved.exists) {
      throw new Error(
        section.action === "add"
          ? `추가할 파일이 이미 존재합니다: ${section.path}`
          : `변경할 파일이 존재하지 않습니다: ${section.path}`,
      );
    }
    if (seen.has(resolved.absolutePath)) {
      throw new Error(`한 패치에서 같은 파일을 두 번 변경할 수 없습니다: ${section.path}`);
    }
    seen.add(resolved.absolutePath);
    files.push({ action: section.action, ...writableScopeTarget(resolved) });
  }
  const visible = sections.map((section) => section.path).slice(0, 5);
  return {
    summary: `패치 적용: ${visible.join(", ")}${files.length > visible.length ? " 외" : ""}`,
    approvalScope: { kind: "paths", target: { files } },
  };
}

async function revalidatePatch(
  guard: WorkspacePathGuard,
  patch: string,
  preflight: ToolPreflightResult,
): Promise<void> {
  const expected = patchScopeFiles(preflight);
  const current: JsonValue[] = [];
  for (const section of parseWorkspacePatch(patch)) {
    const resolved = await guard.resolveWritable(section.path);
    current.push({ action: section.action, ...writableScopeTarget(resolved) });
  }
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new PermissionDeniedError("승인 또는 검사 뒤 패치 대상이 변경되었습니다.");
  }
}

async function stageExisting(
  action: "update" | "delete",
  displayPath: string,
  guard: WorkspacePathGuard,
  observations: FileObservationStore,
  context: ToolExecutionContext,
  transform: (before: string) => string | undefined,
): Promise<StagedMutation> {
  const resolution = await guard.resolveWritable(displayPath);
  if (!resolution.exists) throw new Error(`변경할 파일이 존재하지 않습니다: ${displayPath}`);
  const content = await readWorkspaceUtf8File(resolution);
  observations.assertUnchanged(context.sessionId, resolution.absolutePath, content.digest);
  observations.observe(context.sessionId, resolution.absolutePath, content.digest);
  const afterText = transform(content.text);
  const after = afterText === undefined ? undefined : textBytes(afterText, displayPath);
  return {
    action,
    displayPath,
    resolution,
    before: content.bytes,
    beforeText: content.text,
    after,
    afterText: afterText ?? "",
  };
}

async function executeStaged(
  staged: readonly StagedMutation[],
  toolName: string,
  guard: WorkspacePathGuard,
  checkpoints: CheckpointManager,
  observations: FileObservationStore,
  context: ToolExecutionContext,
): Promise<{ checkpointId: string; preparedDirectories: readonly string[] } | ToolExecutionResult> {
  let checkpointId: string;
  try {
    checkpointId = await checkpoints.begin(
      { sessionId: context.sessionId, runId: context.runId, toolName },
      staged.map((item) => ({ resolution: item.resolution, before: item.before })),
    );
  } catch (error) {
    return validationFailure(`${toolName}_checkpoint_failed`, error);
  }
  try {
    for (const item of staged) {
      checkpoints.setExpected(checkpointId, item.resolution.absolutePath, item.after);
    }
  } catch (error) {
    checkpoints.discardUnchanged(checkpointId);
    return validationFailure(`${toolName}_checkpoint_failed`, error);
  }

  let operationError: unknown;
  const preparedDirectories = new Set<string>();
  for (const item of staged) {
    try {
      if (context.signal.aborted) guardAbort();
      if (item.after === undefined) {
        await deleteWorkspaceFile(guard, item.resolution);
      } else {
        const write = await writeWorkspaceFileAtomic(
          guard,
          item.resolution,
          item.after,
        );
        checkpoints.recordPreparedDirectories(checkpointId, write.preparedDirectories);
        for (const directory of write.preparedDirectories) preparedDirectories.add(directory);
      }
    } catch (error) {
      if (error instanceof WorkspaceFileOperationError) {
        checkpoints.recordPreparedDirectories(checkpointId, error.preparedDirectories);
        checkpoints.recordResidualFiles(checkpointId, error.residualFiles);
      }
      operationError = error;
      break;
    }
    if (context.signal.aborted) {
      operationError = new PermissionDeniedError("파일 변경 사이에 작업이 취소되었습니다.");
      break;
    }
  }
  if (operationError === undefined) {
    try {
      await checkpoints.verifyExpected(checkpointId);
    } catch (error) {
      operationError = error;
    }
  }
  if (operationError !== undefined) {
    let rollback: CheckpointRestoreResult;
    try {
      rollback = await checkpoints.rollback(checkpointId);
    } catch (error) {
      const first = operationError instanceof Error ? operationError.message : "알 수 없는 변경 오류";
      const second = error instanceof Error ? error.message : "알 수 없는 rollback 오류";
      return mutationFailure(
        `${toolName}_rollback_unknown`,
        `${first} Rollback 상태도 확인하지 못했습니다: ${second}`,
        "unknown",
      );
    }
    if (rollback.complete) {
      for (const item of staged) {
        observations.observe(
          context.sessionId,
          item.resolution.absolutePath,
          item.before ? digestBytes(item.before) : undefined,
        );
      }
      return context.signal.aborted
        ? {
            status: "cancelled",
            reason: "파일 변경 사이에 취소 요청을 받아 적용된 파일 변경을 복구했습니다.",
          }
        : mutationFailure(
            `${toolName}_failed_rolled_back`,
            `${operationError instanceof Error ? operationError.message : "변경에 실패했습니다."} 적용된 파일 변경은 복구했습니다.`,
            "failed",
          );
    }
    return mutationFailure(
      `${toolName}_rollback_incomplete`,
      `${operationError instanceof Error ? operationError.message : "변경에 실패했습니다."} Rollback이 일부 실패해 checkpoint ${checkpointId}을 보존했습니다: ${rollback.failures.join("; ")}`,
      "unknown",
    );
  }

  try {
    checkpoints.commit(checkpointId);
  } catch (error) {
    const rollback = await checkpoints.rollback(checkpointId).catch(() => undefined);
    return mutationFailure(
      `${toolName}_checkpoint_commit_failed`,
      rollback?.complete
        ? "변경 후 checkpoint 완료 처리에 실패해 파일 변경을 복구했습니다."
        : "파일은 변경됐지만 checkpoint 완료와 rollback 상태를 확정하지 못했습니다.",
      rollback?.complete ? "failed" : "unknown",
    );
  }
  for (const item of staged) {
    observations.observe(
      context.sessionId,
      item.resolution.absolutePath,
      item.after ? digestBytes(item.after) : undefined,
    );
  }
  return {
    checkpointId,
    preparedDirectories: [...preparedDirectories].map((directory) =>
      relative(guard.workspace, directory).replaceAll("\\", "/")
    ),
  };
}

function guardAbort(): never {
  throw new PermissionDeniedError("파일 변경 직전에 작업이 취소되었습니다.");
}

function isExecutionResult(
  value: { checkpointId: string; preparedDirectories: readonly string[] } | ToolExecutionResult,
): value is ToolExecutionResult {
  return "status" in value;
}

export function registerWorkspaceMutationTools(
  registry: ToolRegistry,
  options: WorkspaceMutationToolOptions,
): WorkspaceMutationServices {
  const checkpoints = options.checkpoints ?? new CheckpointManager(options.guard);
  const observations = options.observations;
  const guard = options.guard;
  if (checkpoints.guard.workspace !== guard.workspace) {
    throw new Error("Checkpoint manager와 mutation path guard의 workspace가 다릅니다.");
  }

  registry.register({
    definition: {
      name: "edit_file",
      description: "Replace one exact UTF-8 text fragment, requiring explicit replace_all for ambiguous matches.",
      inputSchema: objectSchema(
        {
          path: stringSchema("Workspace-relative existing file path", 4_096),
          old_text: { ...stringSchema("Exact existing text", MAX_TEXT_ARGUMENT_CODE_POINTS), minLength: 1 },
          new_text: stringSchema("Replacement text", MAX_TEXT_ARGUMENT_CODE_POINTS),
          replace_all: { type: "boolean", description: "Replace every exact match when true" },
        },
        ["path", "old_text", "new_text", "replace_all"],
      ),
      category: "edit",
      permission: { kind: "workspace", access: "write" },
      outputLimitBytes: DEFAULT_TOOL_OUTPUT_BYTES,
      handler: async (input, context) => {
        let staged: StagedMutation;
        let replacements = 0;
        try {
          const path = stringArgument(input, "path");
          const oldText = stringArgument(input, "old_text");
          const newText = stringArgument(input, "new_text");
          const replaceAll = input.replace_all === true;
          staged = await stageExisting(
            "update",
            path,
            guard,
            observations,
            context,
            (before) => {
              const occurrences = countOccurrences(before, oldText);
              if (occurrences === 0) throw new Error("old_text와 정확히 일치하는 내용이 없습니다.");
              if (occurrences > 1 && !replaceAll) {
                throw new Error(`old_text가 ${occurrences}번 발견되었습니다. 더 긴 문맥 또는 replace_all=true가 필요합니다.`);
              }
              replacements = replaceAll ? occurrences : 1;
              return replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, newText);
            },
          );
        } catch (error) {
          return validationFailure("edit_file_invalid", error);
        }
        if (staged.beforeText === staged.afterText) {
          return toolSuccess({
            path: staged.displayPath,
            replacements: 0,
            changed: false,
            checkpoint_id: null,
            diff: "",
            diff_truncated: false,
          });
        }
        const execution = await executeStaged(
          [staged],
          "edit_file",
          guard,
          checkpoints,
          observations,
          context,
        );
        if (isExecutionResult(execution)) return execution;
        const difference = unifiedDiff(staged.displayPath, staged.beforeText, staged.afterText);
        return toolSuccess({
          path: staged.displayPath,
          replacements: replacements ?? 1,
          changed: true,
          checkpoint_id: execution.checkpointId,
          diff: difference.text,
          diff_truncated: difference.truncated,
          diff_omitted_bytes: difference.omittedBytes,
          ...(execution.preparedDirectories.length > 0
            ? { prepared_directories: [...execution.preparedDirectories] }
            : {}),
        }, difference.truncated, difference.omittedBytes || undefined);
      },
    },
    preflight: async (input) => await mutationPathPreflight(
      guard,
      stringArgument(input, "path"),
      `파일 수정: ${stringArgument(input, "path")}`,
    ),
    revalidate: async (input, _context, preflight) => await revalidateMutationPath(
      guard,
      stringArgument(input, "path"),
      preflight,
    ),
  });

  registry.register({
    definition: {
      name: "write_file",
      description: "Create a UTF-8 file; replacing an existing file requires overwrite=true.",
      inputSchema: objectSchema(
        {
          path: stringSchema("Workspace-relative file path", 4_096),
          content: stringSchema("Complete UTF-8 file content", MAX_TEXT_ARGUMENT_CODE_POINTS),
          overwrite: { type: "boolean", description: "Explicitly allow replacing an existing file" },
        },
        ["path", "content", "overwrite"],
      ),
      category: "edit",
      permission: { kind: "workspace", access: "write" },
      outputLimitBytes: DEFAULT_TOOL_OUTPUT_BYTES,
      handler: async (input, context) => {
        let staged: StagedMutation;
        try {
          const path = stringArgument(input, "path");
          const resolution = await guard.resolveWritable(path);
          if (resolution.exists && input.overwrite !== true) {
            throw new Error("파일이 이미 존재합니다. overwrite=true를 명시하거나 edit_file을 사용하세요.");
          }
          const afterText = stringArgument(input, "content");
          const after = textBytes(afterText, "파일 내용");
          let before: Buffer | undefined;
          let beforeText = "";
          if (resolution.exists) {
            const current = await readWorkspaceUtf8File(resolution);
            observations.assertUnchanged(context.sessionId, resolution.absolutePath, current.digest);
            observations.observe(context.sessionId, resolution.absolutePath, current.digest);
            before = current.bytes;
            beforeText = current.text;
          } else {
            observations.assertUnchanged(context.sessionId, resolution.absolutePath, undefined);
            observations.observe(context.sessionId, resolution.absolutePath, undefined);
          }
          staged = {
            action: resolution.exists ? "update" : "add",
            displayPath: path,
            resolution,
            before,
            beforeText,
            after,
            afterText,
          };
        } catch (error) {
          return validationFailure("write_file_invalid", error);
        }
        if (staged.before && staged.before.equals(staged.after ?? Buffer.alloc(0))) {
          return toolSuccess({
            path: staged.displayPath,
            created: false,
            changed: false,
            bytes: staged.after?.byteLength ?? 0,
            checkpoint_id: null,
            diff: "",
            diff_truncated: false,
          });
        }
        const execution = await executeStaged(
          [staged],
          "write_file",
          guard,
          checkpoints,
          observations,
          context,
        );
        if (isExecutionResult(execution)) return execution;
        const difference = unifiedDiff(
          staged.displayPath,
          staged.beforeText,
          staged.afterText,
          staged.action === "add",
        );
        return toolSuccess({
          path: staged.displayPath,
          created: staged.action === "add",
          changed: true,
          bytes: staged.after?.byteLength ?? 0,
          checkpoint_id: execution.checkpointId,
          diff: difference.text,
          diff_truncated: difference.truncated,
          diff_omitted_bytes: difference.omittedBytes,
          ...(execution.preparedDirectories.length > 0
            ? { prepared_directories: [...execution.preparedDirectories] }
            : {}),
        }, difference.truncated, difference.omittedBytes || undefined);
      },
    },
    preflight: async (input) => await mutationPathPreflight(
      guard,
      stringArgument(input, "path"),
      `파일 ${input.overwrite === true ? "덮어쓰기" : "생성"}: ${stringArgument(input, "path")}`,
    ),
    revalidate: async (input, _context, preflight) => await revalidateMutationPath(
      guard,
      stringArgument(input, "path"),
      preflight,
    ),
  });

  registry.register({
    definition: {
      name: "apply_patch",
      description: "Prevalidate and apply a bounded multi-file custom or standard unified patch with rollback.",
      inputSchema: objectSchema(
        { patch: { ...stringSchema("Patch enclosed by *** Begin Patch and *** End Patch", MAX_PATCH_CODE_POINTS), minLength: 1 } },
        ["patch"],
      ),
      category: "edit",
      permission: { kind: "workspace", access: "write" },
      outputLimitBytes: DEFAULT_TOOL_OUTPUT_BYTES,
      handler: async (input, context) => {
        let staged: StagedMutation[];
        try {
          staged = [];
          const seen = new Set<string>();
          for (const section of parseWorkspacePatch(stringArgument(input, "patch"))) {
            const resolution = await guard.resolveWritable(section.path);
            if (seen.has(resolution.absolutePath)) {
              throw new Error(`한 패치에서 같은 파일을 두 번 변경할 수 없습니다: ${section.path}`);
            }
            seen.add(resolution.absolutePath);
            if (section.action === "add") {
              if (resolution.exists) throw new Error(`추가할 파일이 이미 존재합니다: ${section.path}`);
              observations.assertUnchanged(context.sessionId, resolution.absolutePath, undefined);
              const afterText = addedFileContent(section);
              staged.push({
                action: "add",
                displayPath: section.path,
                resolution,
                before: undefined,
                beforeText: "",
                after: textBytes(afterText, section.path),
                afterText,
              });
              continue;
            }
            const item = await stageExisting(
              section.action,
              section.path,
              guard,
              observations,
              context,
              (before) => section.action === "delete"
                ? validateDelete(section, before)
                : applyPatchToText(section, before),
            );
            staged.push(item);
          }
          staged = staged.filter((item) => item.beforeText !== item.afterText || item.action === "delete");
          if (staged.length === 0) throw new Error("패치가 파일 내용을 변경하지 않습니다.");
        } catch (error) {
          return validationFailure("apply_patch_invalid", error);
        }
        const execution = await executeStaged(
          staged,
          "apply_patch",
          guard,
          checkpoints,
          observations,
          context,
        );
        if (isExecutionResult(execution)) return execution;
        const differences = staged.map((item) => unifiedDiff(
          item.displayPath,
          item.beforeText,
          item.afterText,
          item.action === "add",
          item.action === "delete",
        ));
        const combined = differences.map((item) => item.text).join("");
        const omitted = differences.reduce((total, item) => total + item.omittedBytes, 0);
        const truncated = differences.some((item) => item.truncated) || Buffer.byteLength(combined, "utf8") > 48_000;
        const visibleDiff = truncated
          ? Buffer.from(combined, "utf8").subarray(0, 48_000).toString("utf8").replace(/�+$/u, "")
          : combined;
        const files = staged.map((item) => item.displayPath);
        const totalOmitted = omitted + Math.max(
          0,
          Buffer.byteLength(combined, "utf8") - 48_000,
        );
        return toolSuccess({
          checkpoint_id: execution.checkpointId,
          files,
          count: files.length,
          diff: visibleDiff,
          diff_truncated: truncated,
          diff_omitted_bytes: totalOmitted,
          ...(execution.preparedDirectories.length > 0
            ? { prepared_directories: [...execution.preparedDirectories] }
            : {}),
        }, truncated, totalOmitted || undefined);
      },
    },
    preflight: async (input) => await patchPreflight(guard, stringArgument(input, "patch")),
    revalidate: async (input, _context, preflight) => await revalidatePatch(
      guard,
      stringArgument(input, "patch"),
      preflight,
    ),
  });

  return { checkpoints, observations };
}

function validateDelete(section: WorkspacePatchSection, before: string): undefined {
  if (section.format === "unified") {
    const patched = applyPatchToText(section, before);
    if (patched !== "") {
      throw new Error(`삭제 unified diff가 파일 전체를 제거하지 않습니다: ${section.path}`);
    }
  }
  return undefined;
}

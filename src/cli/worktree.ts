import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ConfigurationError } from "../core/errors.js";
import {
  GitWorktreeManager,
  normalizeWorktreeName,
  type ManagedWorktreeSnapshot,
} from "../git/index.js";
import { resolveStoragePaths } from "../storage/paths.js";
import { CliUsageError } from "./args.js";
import type { CliOutput } from "./output.js";

const WORKTREE_COMMANDS = ["add", "list", "remove"] as const;
type WorktreeCommand = (typeof WORKTREE_COMMANDS)[number];
const MAX_WORKTREE_ARGUMENT_BYTES = 64 * 1024;

export interface WorktreeManagementControllerOptions {
  readonly initialCwd: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export function worktreeHelp(): string {
  return "usage: cat-tui worktree <add|list|remove> ...\n\n" +
    "현재 Git 저장소의 cat-managed worktree를 관리합니다.\n\n" +
    "commands:\n" +
    "  add [--base REF] [-C CWD] [NAME]  새 worktree와 cat/worktree/NAME branch 생성\n" +
    "  list [-C CWD]                     이 저장소의 managed worktree 목록\n" +
    "  remove [-C CWD] NAME              clean managed worktree만 제거\n\n" +
    "remove는 tracked, untracked, ignored 변경이 있으면 거부하며 branch를 삭제하지 않습니다.\n";
}

function isWorktreeCommand(value: string): value is WorktreeCommand {
  return (WORKTREE_COMMANDS as readonly string[]).includes(value);
}

function assertArguments(args: readonly string[]): void {
  let bytes = 0;
  for (const value of args) {
    bytes += Buffer.byteLength(value, "utf8") + 1;
    if (value.includes("\0") || bytes > MAX_WORKTREE_ARGUMENT_BYTES) {
      throw new CliUsageError("worktree 인자의 형식 또는 전체 크기가 올바르지 않습니다.");
    }
  }
}

function optionValue(
  args: readonly string[],
  index: number,
  option: string,
  inline: string | undefined,
): { readonly value: string; readonly nextIndex: number } {
  const value = inline ?? args[index + 1];
  if (
    value === undefined ||
    (inline === undefined && value.startsWith("-")) ||
    !value ||
    /[\p{Cc}\p{Cf}]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > 4_096
  ) {
    throw new CliUsageError(`${option} 옵션에 올바른 값이 필요합니다.`);
  }
  return Object.freeze({ value, nextIndex: inline === undefined ? index + 1 : index });
}

interface ParsedWorktreeArguments {
  readonly cwd: string;
  readonly name?: string;
  readonly baseRef?: string;
}

function parseArguments(
  command: WorktreeCommand,
  args: readonly string[],
  initialCwd: string,
): ParsedWorktreeArguments {
  let cwd = initialCwd;
  let baseRef: string | undefined;
  const positional: string[] = [];
  const seen = new Set<string>();
  let positionalOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    let argument = args[index] ?? "";
    if (!positionalOnly && argument === "--") {
      positionalOnly = true;
      continue;
    }
    if (positionalOnly || !argument.startsWith("-")) {
      positional.push(argument);
      continue;
    }
    const shortCwd = argument.match(/^-C(.+)$/su);
    const assignment = argument.match(/^(--(?:cwd|base))=(.*)$/su);
    let option = assignment?.[1] ?? argument;
    let inline = assignment?.[2];
    if (shortCwd) {
      option = "--cwd";
      inline = shortCwd[1];
    } else if (option === "-C") {
      option = "--cwd";
    }
    if (option !== "--cwd" && option !== "--base") {
      throw new CliUsageError(`worktree ${command}의 알 수 없는 옵션입니다: ${option}`);
    }
    if (option === "--base" && command !== "add") {
      throw new CliUsageError(`--base는 worktree add에서만 사용할 수 있습니다.`);
    }
    if (seen.has(option)) throw new CliUsageError(`${option} 옵션을 중복 지정할 수 없습니다.`);
    seen.add(option);
    const selected = optionValue(args, index, option, inline);
    index = selected.nextIndex;
    if (option === "--cwd") cwd = selected.value;
    else baseRef = selected.value;
  }
  if (command === "list" && positional.length !== 0) {
    throw new CliUsageError("worktree list에는 이름을 지정할 수 없습니다.");
  }
  if (command === "add" && positional.length > 1) {
    throw new CliUsageError("worktree add에는 이름을 하나만 지정할 수 있습니다.");
  }
  if (command === "remove" && positional.length !== 1) {
    throw new CliUsageError("사용법: cat-tui worktree remove [-C CWD] NAME");
  }
  let name: string | undefined;
  if (positional[0] !== undefined) {
    try {
      name = normalizeWorktreeName(positional[0]);
    } catch (error) {
      if (error instanceof ConfigurationError) {
        throw new CliUsageError(error.message, { cause: error });
      }
      throw error;
    }
  }
  const expandedCwd = cwd === "~"
    ? homedir()
    : cwd.startsWith("~/")
      ? join(homedir(), cwd.slice(2))
      : cwd;
  return Object.freeze({
    cwd: isAbsolute(expandedCwd) ? resolve(expandedCwd) : resolve(initialCwd, expandedCwd),
    ...(name === undefined ? {} : { name }),
    ...(baseRef === undefined ? {} : { baseRef }),
  });
}

function worktreeLine(entry: ManagedWorktreeSnapshot): string {
  const flags = [
    entry.current ? "current" : "",
    entry.state !== "active" ? entry.state : "",
    entry.presence !== "ready" ? entry.presence : "",
    !entry.identityMatches ? "identity-unconfirmed" : "",
    entry.locked ? "locked" : "",
  ].filter(Boolean);
  return `${entry.name}\t${entry.currentBranch ?? "(detached)"}\t${entry.path}` +
    `${flags.length > 0 ? `\t[${flags.join(", ")}]` : ""}`;
}

export class WorktreeManagementController {
  readonly #initialCwd: string;
  readonly #environment: NodeJS.ProcessEnv | undefined;

  constructor(options: WorktreeManagementControllerOptions) {
    this.#initialCwd = options.initialCwd;
    this.#environment = options.environment;
  }

  async run(args: readonly string[], output: CliOutput): Promise<number> {
    assertArguments(args);
    const command = args[0];
    if (command === undefined || command === "-h" || command === "--help") {
      output.writeTrustedText(worktreeHelp());
      return 0;
    }
    if (!isWorktreeCommand(command)) {
      throw new CliUsageError(`worktree 명령을 찾을 수 없습니다: ${command}`);
    }
    const commandArgs = args.slice(1);
    if (commandArgs.includes("-h") || commandArgs.includes("--help")) {
      output.writeTrustedText(worktreeHelp());
      return 0;
    }
    const selected = parseArguments(command, commandArgs, this.#initialCwd);
    const paths = await resolveStoragePaths(selected.cwd, this.#environment);
    const manager = await GitWorktreeManager.open({
      workspace: paths.workspace,
      storageRoot: join(paths.catHome, "worktrees"),
      callerCwd: this.#initialCwd,
      ...(this.#environment === undefined ? {} : { environment: this.#environment }),
    });
    if (command === "list") {
      const worktrees = await manager.list();
      if (worktrees.length === 0) {
        output.writeText("이 저장소에 cat-managed worktree가 없습니다.");
        return 0;
      }
      output.writeText(worktrees.map(worktreeLine).join("\n"));
      return 0;
    }
    if (command === "add") {
      const created = await manager.create({
        ...(selected.name === undefined ? {} : { name: selected.name }),
        ...(selected.baseRef === undefined ? {} : { baseRef: selected.baseRef }),
      });
      output.writeText(
        `worktree를 만들었습니다: ${created.path}\n` +
        `branch: ${created.createdBranch} · base: ${created.baseRef}\n` +
        "새 cwd는 별도 filesystem identity이므로 agent 시작 시 trust를 다시 확인합니다.",
      );
      return 0;
    }
    const removed = await manager.remove(selected.name ?? "");
    output.writeText(
      removed.registryOnly
        ? `남아 있던 managed registry 기록만 정리했습니다: ${removed.name}`
        : `clean worktree를 제거했습니다: ${removed.path}\nbranch는 삭제하지 않았습니다: ${removed.retainedBranch}`,
    );
    return 0;
  }
}

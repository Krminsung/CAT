import { ConfigurationError } from "../core/errors.js";
import type { PermissionMode } from "../security/permissions.js";

export type CliOutputFormat = "text" | "json" | "stream-json";
export const CLI_MANAGEMENT_COMMANDS = Object.freeze([
  "auth",
  "mcp",
  "worktree",
  "ssh",
  "migrate",
] as const);
export type CliManagementCommand = (typeof CLI_MANAGEMENT_COMMANDS)[number];
export type CliToolSelection = "default" | readonly string[];

export interface CliOptions {
  readonly cwd?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly baseUrl?: string;
  readonly maxTurns?: number;
  readonly print: boolean;
  readonly resume?: string;
  readonly continueLatest: boolean;
  readonly prompt: string;
  readonly permissionMode?: PermissionMode;
  readonly name?: string;
  readonly outputFormat: CliOutputFormat;
  readonly tools?: CliToolSelection;
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly appendSystemPrompt?: string;
  readonly noSessionPersistence: boolean;
  readonly verbose?: boolean;
  readonly worktree?: string;
  readonly trustWorkspace: boolean;
  readonly noColor: boolean;
}

export type CliInvocation =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | {
      readonly kind: "management";
      readonly command: CliManagementCommand;
      readonly args: readonly string[];
    }
  | { readonly kind: "agent"; readonly options: CliOptions };

export class CliUsageError extends ConfigurationError {
  override name = "CliUsageError";
}

const MAX_ARG_COUNT = 4_096;
const MAX_ARG_BYTES = 512 * 1024;
const MAX_PROMPT_BYTES = 512 * 1024;
const MAX_SYSTEM_PROMPT_BYTES = 64 * 1024;
const MAX_LIST_ITEMS = 256;
const MANAGEMENT_COMMANDS = new Set<string>(CLI_MANAGEMENT_COMMANDS);
const VALUE_OPTIONS = new Set<string>([
  "-C",
  "--cwd",
  "--model",
  "--provider",
  "--profile",
  "--base-url",
  "--max-turns",
  "-r",
  "--resume",
  "--permission-mode",
  "--approval-mode",
  "-n",
  "--name",
  "--output-format",
  "--tools",
  "--allowed-tools",
  "--disallowed-tools",
  "--append-system-prompt",
]);
const FLAG_OPTIONS = new Set<string>([
  "-p",
  "--print",
  "-c",
  "--continue",
  "--no-session-persistence",
  "--verbose",
  "--no-color",
  "--trust-workspace",
]);
const SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SESSION_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const TOOL_IDENTIFIER = /^[a-z][a-z0-9_]{0,127}$/u;
const WORKTREE_IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export function cliUsage(): string {
  return "usage: cat-tui [-h] [-p] [-C CWD] [--model MODEL] " +
    "[--provider PROVIDER] [--profile PROFILE]\n" +
    "               [--max-turns N] [--permission-mode MODE] " +
    "[-c | -r SESSION_ID]\n" +
    "               [-n NAME] [--output-format FORMAT] [--tools TOOLS] " +
    "[--allowed-tools TOOLS]\n" +
    "               [--disallowed-tools TOOLS] [--append-system-prompt TEXT]\n" +
    "               [--no-session-persistence] [--verbose] [--no-color]\n" +
    "               [--trust-workspace] [-w [NAME]] [--base-url URL] " +
    "[--version] [prompt ...]";
}

export function cliHelp(): string {
  return `${cliUsage()}\n\n` +
    "프로젝트를 읽고 수정하며 명령을 실행하는 bounded 터미널 코딩 에이전트\n\n" +
    "positional arguments:\n" +
    "  prompt                         에이전트에게 보낼 요청\n\n" +
    "options:\n" +
    "  -h, --help                     도움말 표시\n" +
    "  -p, --print                    한 번 응답하고 종료\n" +
    "  -C, --cwd DIRECTORY            작업 디렉터리\n" +
    "  --provider ID                  provider 선택\n" +
    "  --profile NAME                 저장된 API key profile 선택\n" +
    "  --model ID                     model 선택\n" +
    "  --base-url URL                 저장된 profile endpoint와 일치하는 주소 확인\n" +
    "  --max-turns N                  요청당 agent turn 상한(1–100)\n" +
    "  --permission-mode MODE         ask|auto-edit|full-auto|plan\n" +
    "  --approval-mode MODE           --permission-mode 별칭\n" +
    "  -c, --continue                 현재 폴더의 최근 세션 재개\n" +
    "  -r, --resume SESSION_ID        지정 세션 재개\n" +
    "  -n, --name NAME                세션 표시 이름\n" +
    "  --output-format FORMAT         text|json|stream-json (--print 전용)\n" +
    "  --tools TOOLS                  default 또는 쉼표로 구분한 도구\n" +
    "  --allowed-tools TOOLS          승인 없이 허용할 도구\n" +
    "  --disallowed-tools TOOLS       차단할 도구(항상 우선)\n" +
    "  --append-system-prompt TEXT    명시적 system prompt 추가\n" +
    "  --no-session-persistence       세션을 디스크에 저장하지 않음\n" +
    "  --verbose                      상세 상태 표시\n" +
    "  --no-color                     색상·장식 최소화\n" +
    "  --trust-workspace              현재 workspace trust를 명시적으로 저장\n" +
    "  -w, --worktree [NAME]          새 managed Git worktree에서 실행\n" +
    "  --version                      버전 표시\n\n" +
    "management commands:\n" +
    "  cat-tui auth <setup|status|use|remove> ...\n" +
    "  cat-tui mcp <list|get|add|remove> ...\n" +
    "  cat-tui worktree <add|list|remove> ...\n" +
    "  cat-tui ssh [OpenSSH options] user@host [remote command]\n" +
    "  cat-tui migrate [--source DIRECTORY] [--include-credentials]\n";
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function assertArgv(argv: readonly string[]): void {
  if (argv.length > MAX_ARG_COUNT) {
    throw new CliUsageError(`인자는 최대 ${MAX_ARG_COUNT}개까지 사용할 수 있습니다.`);
  }
  let total = 0;
  for (const value of argv) {
    if (typeof value !== "string" || value.includes("\0")) {
      throw new CliUsageError("인자에는 NUL 문자를 사용할 수 없습니다.");
    }
    total += byteLength(value) + 1;
    if (total > MAX_ARG_BYTES) {
      throw new CliUsageError(`전체 인자 크기는 ${MAX_ARG_BYTES} bytes 이하여야 합니다.`);
    }
  }
}

function boundedText(
  value: string,
  label: string,
  maximumBytes: number,
  allowLineBreaks = false,
): string {
  const selected = value.trim();
  const controls = allowLineBreaks
    ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u
    : /[\u0000-\u001F\u007F]/u;
  if (!selected || byteLength(selected) > maximumBytes || controls.test(selected)) {
    throw new CliUsageError(`${label} 값의 형식 또는 크기가 올바르지 않습니다.`);
  }
  return selected;
}

function identifier(value: string, label: string): string {
  const selected = boundedText(value, label, 256).toLowerCase();
  if (!SAFE_IDENTIFIER.test(selected)) {
    throw new CliUsageError(`${label}에는 안전한 식별자만 사용할 수 있습니다.`);
  }
  return selected;
}

function sessionIdentifier(value: string): string {
  const selected = boundedText(value, "--resume", 128);
  if (!SESSION_IDENTIFIER.test(selected)) {
    throw new CliUsageError("--resume session ID 형식이 올바르지 않습니다.");
  }
  return selected;
}

function toolList(value: string, label: string): readonly string[] {
  const parts = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (
    parts.length < 1 ||
    parts.length > MAX_LIST_ITEMS ||
    parts.some((item) => !TOOL_IDENTIFIER.test(item))
  ) {
    throw new CliUsageError(`${label}에는 쉼표로 구분한 도구 이름을 1–${MAX_LIST_ITEMS}개 지정하세요.`);
  }
  return Object.freeze([...new Set(parts)]);
}

function integer(value: string, label: string, minimum: number, maximum: number): number {
  if (!/^[0-9]+$/u.test(value)) {
    throw new CliUsageError(`${label} 값은 정수여야 합니다: ${value}`);
  }
  const selected = Number(value);
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new CliUsageError(`${label} 값은 ${minimum}–${maximum} 범위여야 합니다.`);
  }
  return selected;
}

function separateValueCandidate(value: string | undefined): value is string {
  return value !== undefined && (
    !value.startsWith("-") || value === "-" || /^-[0-9]+$/u.test(value)
  );
}

function managementCommand(value: string): CliManagementCommand {
  if (!MANAGEMENT_COMMANDS.has(value)) {
    throw new CliUsageError(`알 수 없는 관리 명령입니다: ${value}`);
  }
  return value as CliManagementCommand;
}

export function parseCliInvocation(argv: readonly string[]): CliInvocation {
  assertArgv(argv);
  const first = argv[0];
  if (first !== undefined && MANAGEMENT_COMMANDS.has(first)) {
    return Object.freeze({
      kind: "management",
      command: managementCommand(first),
      args: Object.freeze(argv.slice(1)),
    });
  }

  let cwd: string | undefined;
  let model: string | undefined;
  let provider: string | undefined;
  let profile: string | undefined;
  let baseUrl: string | undefined;
  let maxTurns: number | undefined;
  let print = false;
  let resume: string | undefined;
  let continueLatest = false;
  let permissionMode: PermissionMode | undefined;
  let name: string | undefined;
  let outputFormat: CliOutputFormat = "text";
  let tools: CliToolSelection | undefined;
  let allowedTools: readonly string[] = Object.freeze([]);
  let disallowedTools: readonly string[] = Object.freeze([]);
  let appendSystemPrompt: string | undefined;
  let noSessionPersistence = false;
  let verbose: boolean | undefined;
  let worktree: string | undefined;
  let trustWorkspace = false;
  let noColor = false;
  const promptParts: string[] = [];
  const seen = new Set<string>();

  const mark = (canonical: string): void => {
    if (seen.has(canonical)) throw new CliUsageError(`${canonical} 옵션을 중복 지정할 수 없습니다.`);
    seen.add(canonical);
  };

  for (let index = 0; index < argv.length; index += 1) {
    let argument = argv[index] ?? "";
    if (argument === "--") {
      promptParts.push(...argv.slice(index + 1));
      break;
    }
    if (argument === "-h" || argument === "--help") return Object.freeze({ kind: "help" });
    if (argument === "--version") return Object.freeze({ kind: "version" });

    if (/^-[pc]{2}$/u.test(argument)) {
      for (const short of argument.slice(1)) {
        if (short === "p") {
          mark("--print");
          print = true;
        } else {
          mark("--continue");
          continueLatest = true;
        }
      }
      continue;
    }

    let inlineValue: string | undefined;
    const assignment = argument.match(/^(--[^=]+)=(.*)$/su);
    if (assignment) {
      argument = assignment[1] ?? "";
      inlineValue = assignment[2] ?? "";
    } else {
      const attached = argument.match(/^(-[Crnw])(.+)$/su);
      if (attached) {
        argument = attached[1] ?? "";
        inlineValue = attached[2] ?? "";
      }
    }

    if (FLAG_OPTIONS.has(argument)) {
      if (inlineValue !== undefined) {
        throw new CliUsageError(`${argument} 옵션에는 값을 지정할 수 없습니다.`);
      }
      const canonical = argument === "-p" ? "--print" :
        argument === "-c" ? "--continue" : argument;
      mark(canonical);
      if (canonical === "--print") print = true;
      else if (canonical === "--continue") continueLatest = true;
      else if (canonical === "--no-session-persistence") noSessionPersistence = true;
      else if (canonical === "--verbose") verbose = true;
      else if (canonical === "--no-color") noColor = true;
      else if (canonical === "--trust-workspace") trustWorkspace = true;
      continue;
    }

    if (argument === "-w" || argument === "--worktree") {
      mark("--worktree");
      if (inlineValue !== undefined) {
        worktree = inlineValue;
      } else {
        const candidate = argv[index + 1];
        if (candidate !== undefined && !candidate.startsWith("-")) {
          worktree = candidate;
          index += 1;
        } else {
          worktree = "";
        }
      }
      if (
        worktree && (
          !WORKTREE_IDENTIFIER.test(worktree) ||
          worktree.endsWith(".") ||
          worktree.endsWith(".lock") ||
          worktree.includes("..")
        )
      ) {
        throw new CliUsageError("--worktree 이름은 소문자·숫자로 시작하고 . _ - 만 포함해야 합니다.");
      }
      continue;
    }

    if (VALUE_OPTIONS.has(argument)) {
      const canonical = argument === "-C" ? "--cwd" :
        argument === "-r" ? "--resume" :
        argument === "-n" ? "--name" :
        argument === "--approval-mode" ? "--permission-mode" : argument;
      mark(canonical);
      let value = inlineValue;
      if (value === undefined && separateValueCandidate(argv[index + 1])) {
        value = argv[index + 1];
        index += 1;
      }
      if (value === undefined) throw new CliUsageError(`${canonical} 옵션에 값이 필요합니다.`);

      if (canonical === "--cwd") cwd = boundedText(value, canonical, 4_096);
      else if (canonical === "--model") model = boundedText(value, canonical, 256);
      else if (canonical === "--provider") provider = identifier(value, canonical);
      else if (canonical === "--profile") profile = identifier(value, canonical);
      else if (canonical === "--base-url") baseUrl = boundedText(value, canonical, 2_048);
      else if (canonical === "--max-turns") maxTurns = integer(value, canonical, 1, 100);
      else if (canonical === "--resume") resume = sessionIdentifier(value);
      else if (canonical === "--name") {
        name = boundedText(value, canonical, 1_024);
        if ([...name].length > 256) {
          throw new CliUsageError("--name은 256자를 초과할 수 없습니다.");
        }
      }
      else if (canonical === "--append-system-prompt") {
        appendSystemPrompt = boundedText(value, canonical, MAX_SYSTEM_PROMPT_BYTES, true);
      } else if (canonical === "--tools") {
        tools = value === "default" ? "default" : toolList(value, canonical);
      } else if (canonical === "--allowed-tools") {
        allowedTools = toolList(value, canonical);
      } else if (canonical === "--disallowed-tools") {
        disallowedTools = toolList(value, canonical);
      } else if (canonical === "--output-format") {
        if (value !== "text" && value !== "json" && value !== "stream-json") {
          throw new CliUsageError("--output-format은 text, json, stream-json 중 하나여야 합니다.");
        }
        outputFormat = value;
      } else if (canonical === "--permission-mode") {
        if (value !== "ask" && value !== "auto-edit" && value !== "full-auto" && value !== "plan") {
          throw new CliUsageError("--permission-mode는 ask, auto-edit, full-auto, plan 중 하나여야 합니다.");
        }
        permissionMode = value;
      }
      continue;
    }

    if (argument.startsWith("-")) {
      throw new CliUsageError(`알 수 없는 인자입니다: ${argument}`);
    }
    if (argument) promptParts.push(argument);
  }

  if (resume !== undefined && continueLatest) {
    throw new CliUsageError("--resume과 --continue는 함께 사용할 수 없습니다.");
  }
  if (worktree !== undefined && (resume !== undefined || continueLatest)) {
    throw new CliUsageError("--worktree는 --resume 또는 --continue와 함께 사용할 수 없습니다.");
  }
  if (outputFormat !== "text" && !print) {
    throw new CliUsageError("json/stream-json 출력은 --print와 함께 사용해야 합니다.");
  }
  const prompt = promptParts.join(" ").trim();
  if (byteLength(prompt) > MAX_PROMPT_BYTES) {
    throw new CliUsageError(`prompt는 ${MAX_PROMPT_BYTES} bytes를 초과할 수 없습니다.`);
  }
  if (print && !prompt) {
    throw new CliUsageError("--print에는 비어 있지 않은 prompt가 필요합니다.");
  }

  return Object.freeze({
    kind: "agent",
    options: Object.freeze({
      ...(cwd === undefined ? {} : { cwd }),
      ...(model === undefined ? {} : { model }),
      ...(provider === undefined ? {} : { provider }),
      ...(profile === undefined ? {} : { profile }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(maxTurns === undefined ? {} : { maxTurns }),
      print,
      ...(resume === undefined ? {} : { resume }),
      continueLatest,
      prompt,
      ...(permissionMode === undefined ? {} : { permissionMode }),
      ...(name === undefined ? {} : { name }),
      outputFormat,
      ...(tools === undefined ? {} : { tools }),
      allowedTools,
      disallowedTools,
      ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt }),
      noSessionPersistence,
      ...(verbose === undefined ? {} : { verbose }),
      ...(worktree === undefined ? {} : { worktree }),
      trustWorkspace,
      noColor,
    }),
  });
}

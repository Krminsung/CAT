import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";
import { ConfigurationError, PermissionDeniedError } from "../core/errors.js";

const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_PROTECTED_PATHS = 64;

export interface ShellCommandPolicyOptions {
  protectedPaths?: readonly string[];
  protectedRoots?: readonly string[];
}

function commandViews(command: string): readonly string[] {
  const joined = command.replace(/\\\r?\n/gu, "");
  const unquoted = joined.replace(/["']/gu, "");
  const deescaped = unquoted.replace(/\\(.)/gsu, "$1");
  return [...new Set([
    joined,
    unquoted,
    deescaped,
    unquoted.replaceAll("\\", "/"),
  ].map((value) => value.toLowerCase()))];
}

function normalizedPolicyPaths(paths: readonly string[] | undefined, label: string): string[] {
  if ((paths?.length ?? 0) > MAX_PROTECTED_PATHS) {
    throw new ConfigurationError(`${label} 항목 수가 너무 많습니다.`);
  }
  return [...new Set((paths ?? []).map((path) => {
    if (!isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path, "utf8") > 32 * 1024) {
      throw new ConfigurationError(`${label}에 올바르지 않은 절대 경로가 있습니다.`);
    }
    return normalize(resolve(path)).replaceAll("\\", "/").toLowerCase();
  }))];
}

function mentionsCredentialPath(views: readonly string[], protectedPaths: readonly string[]): boolean {
  const generic = /(?:^|[\/\s;|&(<>=])(?:~|\$(?:home|\{home\}))?\/?\.(?:cat|smileserv)\/(?:credentials?|profiles?|secrets?|sessions?)(?:\.json|\/|(?=$|[\s;|&)>]))/u;
  return views.some((view) =>
    generic.test(view.replaceAll("\\", "/")) ||
    protectedPaths.some((path) => view.replaceAll("\\", "/").includes(path))
  );
}

function executableIs(token: string, name: string): boolean {
  const normalized = token.replaceAll("\\", "/").replace(/^.*\//u, "");
  return normalized === name;
}

function recursiveFlag(token: string): boolean {
  return token === "--recursive" || /^-[a-z]*r[a-z]*$/iu.test(token);
}

function broadTarget(token: string, protectedRoots: ReadonlySet<string>): boolean {
  const slashed = token
    .replace(/^["']|["']$/gu, "")
    .replaceAll("\\", "/")
    .toLowerCase();
  const cleaned = slashed === "/" ? slashed : slashed.replace(/\/+$/u, "");
  if (
    cleaned.includes("$") ||
    cleaned.includes("`") ||
    cleaned.split("/").includes("..")
  ) return true;
  if (
    /^(?:\/\**|~(?:\/\**)?|\$(?:home|pwd|\{home\}|\{pwd\})(?:\/\**)?|\.?\/\**|\.\.?|\*+)$/u
      .test(cleaned)
  ) {
    return true;
  }
  const withoutWildcard = cleaned.replace(/\/\*+$/u, "");
  if (protectedRoots.has(withoutWildcard)) return true;
  if (!withoutWildcard.startsWith("/") && !/^[a-z]:\//u.test(withoutWildcard)) {
    return false;
  }
  return [...protectedRoots].some((root) =>
    root.startsWith(`${withoutWildcard}${withoutWildcard.endsWith("/") ? "" : "/"}`)
  );
}

function destructiveSegment(segment: string, protectedRoots: ReadonlySet<string>): boolean {
  const tokens = segment.trim().split(/\s+/u).filter(Boolean);
  let analyzedExecutables = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (executableIs(token, "rm")) {
      analyzedExecutables += 1;
      if (analyzedExecutables > 32) return true;
      const remainder = tokens.slice(index + 1);
      const recursive = remainder.some(recursiveFlag);
      if (
        recursive &&
        remainder.some((item) => !item.startsWith("-") && broadTarget(item, protectedRoots))
      ) {
        return true;
      }
    }
    if (executableIs(token, "git")) {
      analyzedExecutables += 1;
      if (analyzedExecutables > 32) return true;
      const remainder = tokens.slice(index + 1);
      const rest = remainder.join(" ");
      const pushIndex = remainder.indexOf("push");
      if (
        /(?:^|\s)reset\s+--hard(?:\s|$)/u.test(rest) ||
        /(?:^|\s)clean\s+(?:-[a-z]*f[a-z]*|--force)(?:\s|$)/iu.test(rest) ||
        /(?:^|\s)push(?:\s|$)[\s\S]*(?:--force(?:-with-lease|-if-includes)?|-f)(?:\s|$)/iu.test(rest) ||
        (pushIndex >= 0 && remainder.slice(pushIndex + 1).some((item) => /^\+\S+/u.test(item)))
      ) {
        return true;
      }
    }
    if (executableIs(token, "find")) {
      analyzedExecutables += 1;
      if (analyzedExecutables > 32) return true;
      const remainder = tokens.slice(index + 1);
      if (
        remainder.includes("-delete") &&
        remainder.some((item) => broadTarget(item, protectedRoots))
      ) {
        return true;
      }
    }
    if (executableIs(token, "chmod") || executableIs(token, "chown")) {
      analyzedExecutables += 1;
      if (analyzedExecutables > 32) return true;
      const remainder = tokens.slice(index + 1);
      if (
        remainder.some(recursiveFlag) &&
        remainder.some((item) => broadTarget(item, protectedRoots))
      ) {
        return true;
      }
    }
  }
  return false;
}

export function validateShellCommand(command: string): string {
  if (
    !command.trim() ||
    command.includes("\0") ||
    Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES
  ) {
    throw new ConfigurationError("셸 명령이 비어 있거나 크기 제한을 초과했습니다.");
  }
  return command;
}

export function blockedShellCommandReason(
  command: string,
  options: ShellCommandPolicyOptions = {},
): string | undefined {
  validateShellCommand(command);
  const views = commandViews(command);
  const protectedPaths = normalizedPolicyPaths(options.protectedPaths, "보호할 command 경로");
  if (mentionsCredentialPath(views, protectedPaths)) {
    return "자격 증명·profile·secret·session 등 보호된 cat 저장소에는 셸 명령으로 직접 접근할 수 없습니다.";
  }

  const roots = normalizedPolicyPaths(
    [...(options.protectedRoots ?? []), homedir()],
    "보호할 command root",
  );
  const protectedRoots = new Set(roots);
  const scan = views.at(-1) ?? command.toLowerCase();
  if (
    /\b(?:mkfs(?:\.[a-z0-9]+)?|mkswap|wipefs|shutdown|reboot|poweroff|halt)\b/u.test(scan) ||
    /\bdd\b[^\n;&|]*\bof\s*=\s*\/dev\//u.test(scan) ||
    /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/u.test(scan) ||
    scan.split(/[\n;&|]+/u).some((segment) => destructiveSegment(segment, protectedRoots))
  ) {
    return "복구하기 어려운 파괴적 명령은 실행할 수 없습니다.";
  }
  return undefined;
}

export function assertShellCommandAllowed(
  command: string,
  options: ShellCommandPolicyOptions = {},
): void {
  const reason = blockedShellCommandReason(command, options);
  if (reason) throw new PermissionDeniedError(reason);
}

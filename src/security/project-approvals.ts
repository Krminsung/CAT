import { isAbsolute, resolve } from "node:path";
import { ConfigurationError, PermissionDeniedError } from "../core/errors.js";
import type { JsonObject, JsonValue } from "../core/json.js";
import { readJsonObject, writeJsonObjectAtomic } from "../storage/json-file.js";
import type { ProjectApprovalPort } from "./permissions.js";
import {
  workspaceIdentity,
  type WorkspaceIdentity,
} from "./trust.js";

const APPROVAL_SCHEMA_VERSION = 1;
const MAX_APPROVAL_BYTES = 2 * 1024 * 1024;
const MAX_WORKSPACES = 1_024;
const MAX_RULES_PER_WORKSPACE = 2_048;
const RULE_PATTERN = /^tool:[a-z][a-z0-9_]{0,127}:(?:workspace|path|paths|command|network|external|invocation):[0-9a-f]{64}$/u;
const DOCUMENT_KEYS = new Set(["schemaVersion", "entries"]);
const ENTRY_KEYS = new Set([
  "canonicalPath",
  "device",
  "inode",
  "rules",
  "updatedAt",
]);

interface ApprovalEntry extends WorkspaceIdentity {
  readonly rules: readonly string[];
  readonly updatedAt: string;
}

function object(value: JsonValue | undefined, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError(`${label}은 객체여야 합니다.`);
  }
  return value;
}

function onlyKeys(value: JsonObject, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ConfigurationError(`${label}에 알 수 없는 ${key} field가 있습니다.`);
    }
  }
}

function integer(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ConfigurationError(`${label} 형식이 올바르지 않습니다.`);
  }
  return value;
}

function text(value: JsonValue | undefined, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value, "utf8") > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ConfigurationError(`${label} 형식이 올바르지 않습니다.`);
  }
  return value;
}

function sameIdentity(left: WorkspaceIdentity, right: WorkspaceIdentity): boolean {
  if (left.canonicalPath !== right.canonicalPath || left.device !== right.device) return false;
  return process.platform === "win32" && (left.inode === 0 || right.inode === 0)
    ? true
    : left.inode === right.inode;
}

function approvalRule(value: JsonValue | undefined, label: string): string {
  const rule = text(value, label, 512);
  if (!RULE_PATTERN.test(rule)) {
    throw new ConfigurationError(`${label} 형식이 올바르지 않습니다.`);
  }
  return rule;
}

export class ProjectApprovalStore implements ProjectApprovalPort {
  private constructor(
    readonly path: string,
    readonly identity: WorkspaceIdentity,
  ) {}

  static async create(path: string, workspace: string): Promise<ProjectApprovalStore> {
    return new ProjectApprovalStore(path, await workspaceIdentity(workspace));
  }

  async list(): Promise<readonly string[]> {
    const current = await workspaceIdentity(this.identity.canonicalPath);
    if (!sameIdentity(current, this.identity)) return Object.freeze([]);
    const entry = (await this.#read()).find((item) => sameIdentity(item, current));
    return Object.freeze([...(entry?.rules ?? [])]);
  }

  async saveProjectApproval(rule: string): Promise<void> {
    const selectedRule = approvalRule(rule, "프로젝트 승인 규칙");
    const current = await workspaceIdentity(this.identity.canonicalPath);
    if (!sameIdentity(current, this.identity)) {
      throw new PermissionDeniedError("승인 이후 workspace identity가 변경됐습니다.");
    }
    const entries = await this.#read();
    const previous = entries.find((entry) => sameIdentity(entry, current));
    const rules = new Set(previous?.rules ?? []);
    rules.add(selectedRule);
    if (rules.size > MAX_RULES_PER_WORKSPACE) {
      throw new ConfigurationError("한 workspace에 저장할 수 있는 승인 규칙 수를 초과했습니다.");
    }
    const next = entries.filter((entry) => entry.canonicalPath !== current.canonicalPath);
    if (next.length >= MAX_WORKSPACES) {
      throw new ConfigurationError("승인을 저장할 수 있는 workspace 수를 초과했습니다.");
    }
    next.push({
      ...current,
      rules: [...rules].sort(),
      updatedAt: new Date().toISOString(),
    });
    next.sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath));
    await this.#write(next);
  }

  async #read(): Promise<ApprovalEntry[]> {
    const document = await readJsonObject(this.path, {
      label: "프로젝트 승인 저장소",
      maxBytes: MAX_APPROVAL_BYTES,
      maxDepth: 8,
      maxNodes: 100_000,
      requireOwner: true,
      requirePrivateMode: true,
    });
    if (!document) return [];
    onlyKeys(document, DOCUMENT_KEYS, "프로젝트 승인 저장소");
    if (document.schemaVersion !== APPROVAL_SCHEMA_VERSION || !Array.isArray(document.entries)) {
      throw new ConfigurationError("프로젝트 승인 저장소 형식이 올바르지 않습니다.");
    }
    if (document.entries.length > MAX_WORKSPACES) {
      throw new ConfigurationError("프로젝트 승인 workspace 수가 너무 많습니다.");
    }
    const paths = new Set<string>();
    return document.entries.map((value, index) => {
      const raw = object(value, `프로젝트 승인 항목 ${index}`);
      onlyKeys(raw, ENTRY_KEYS, `프로젝트 승인 항목 ${index}`);
      const canonicalPath = text(raw.canonicalPath, `프로젝트 승인 항목 ${index} path`, 4_096);
      if (!isAbsolute(canonicalPath) || resolve(canonicalPath) !== canonicalPath) {
        throw new ConfigurationError(`프로젝트 승인 항목 ${index} path가 올바르지 않습니다.`);
      }
      if (paths.has(canonicalPath)) {
        throw new ConfigurationError("프로젝트 승인 저장소에 중복 workspace가 있습니다.");
      }
      paths.add(canonicalPath);
      if (!Array.isArray(raw.rules) || raw.rules.length > MAX_RULES_PER_WORKSPACE) {
        throw new ConfigurationError(`프로젝트 승인 항목 ${index} 규칙 수가 올바르지 않습니다.`);
      }
      const rules = raw.rules.map((rule, ruleIndex) =>
        approvalRule(rule, `프로젝트 승인 항목 ${index} 규칙 ${ruleIndex}`)
      );
      if (new Set(rules).size !== rules.length) {
        throw new ConfigurationError(`프로젝트 승인 항목 ${index}에 중복 규칙이 있습니다.`);
      }
      const updatedAt = text(raw.updatedAt, `프로젝트 승인 항목 ${index} 시간`, 64);
      const updatedMilliseconds = Date.parse(updatedAt);
      if (
        !Number.isFinite(updatedMilliseconds) ||
        new Date(updatedMilliseconds).toISOString() !== updatedAt
      ) {
        throw new ConfigurationError(`프로젝트 승인 항목 ${index} 시간이 올바르지 않습니다.`);
      }
      return Object.freeze({
        canonicalPath,
        device: integer(raw.device, `프로젝트 승인 항목 ${index} device`),
        inode: integer(raw.inode, `프로젝트 승인 항목 ${index} inode`),
        rules: Object.freeze(rules),
        updatedAt,
      });
    });
  }

  async #write(entries: readonly ApprovalEntry[]): Promise<void> {
    await writeJsonObjectAtomic(this.path, {
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      entries: entries.map((entry) => ({
        canonicalPath: entry.canonicalPath,
        device: entry.device,
        inode: entry.inode,
        rules: [...entry.rules],
        updatedAt: entry.updatedAt,
      })),
    }, {
      label: "프로젝트 승인 저장소",
      maxBytes: MAX_APPROVAL_BYTES,
      directoryMode: 0o700,
      fileMode: 0o600,
      requireOwner: true,
    });
  }
}

import { lstat, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { ConfigurationError, PermissionDeniedError } from "../core/errors.js";
import type { JsonObject, JsonValue } from "../core/json.js";
import { readJsonObject, writeJsonObjectAtomic } from "../storage/json-file.js";
import { canonicalWorkspace, type StoragePaths } from "../storage/paths.js";

const TRUST_SCHEMA_VERSION = 1;
const MAX_TRUST_BYTES = 256 * 1024;
const MAX_TRUST_ENTRIES = 1_024;

export interface WorkspaceIdentity {
  canonicalPath: string;
  device: number;
  inode: number;
}

export interface TrustRecord extends WorkspaceIdentity {
  trustedAt: string;
  source: "interactive" | "cli";
}

export interface ProjectCustomization {
  present: boolean;
  reasons: readonly string[];
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

function object(value: JsonValue | undefined, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError(`${label}은 객체여야 합니다.`);
  }
  return value;
}

function text(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || !value || value.length > 4_096) {
    throw new ConfigurationError(`${label} 형식이 올바르지 않습니다.`);
  }
  return value;
}

function integer(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ConfigurationError(`${label}은 음수가 아닌 안전한 정수여야 합니다.`);
  }
  return value;
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

export async function workspaceIdentity(path: string): Promise<WorkspaceIdentity> {
  const canonicalPath = await canonicalWorkspace(path);
  const info = await stat(canonicalPath);
  return {
    canonicalPath,
    device: info.dev,
    inode: info.ino,
  };
}

function sameIdentity(left: WorkspaceIdentity, right: WorkspaceIdentity): boolean {
  if (left.canonicalPath !== right.canonicalPath) return false;
  if (process.platform === "win32" && (left.inode === 0 || right.inode === 0)) return true;
  return left.device === right.device && left.inode === right.inode;
}

function trustRecordToJson(record: TrustRecord): JsonObject {
  return {
    canonicalPath: record.canonicalPath,
    device: record.device,
    inode: record.inode,
    trustedAt: record.trustedAt,
    source: record.source,
  };
}

export class ExplicitTrustGrant {
  readonly #explicit = true;

  private constructor(
    readonly identity: WorkspaceIdentity,
    readonly source: "interactive" | "cli",
    readonly confirmedAt: string,
  ) {}

  static async fromUser(
    path: string,
    source: "interactive" | "cli",
  ): Promise<ExplicitTrustGrant> {
    return new ExplicitTrustGrant(
      await workspaceIdentity(path),
      source,
      new Date().toISOString(),
    );
  }

  isExplicit(): boolean {
    return this.#explicit;
  }
}

export class TrustStore {
  constructor(readonly path: string) {}

  async #read(): Promise<TrustRecord[]> {
    const document = await readJsonObject(this.path, {
      label: "Workspace trust 저장소",
      maxBytes: MAX_TRUST_BYTES,
      maxDepth: 8,
      maxNodes: 8_192,
      requireOwner: true,
      requirePrivateMode: true,
    });
    if (!document) return [];
    if (document.schemaVersion !== TRUST_SCHEMA_VERSION) {
      throw new ConfigurationError(
        `Workspace trust schemaVersion은 ${TRUST_SCHEMA_VERSION}이어야 합니다.`,
      );
    }
    if (!Array.isArray(document.entries)) {
      throw new ConfigurationError("Workspace trust entries는 배열이어야 합니다.");
    }
    if (document.entries.length > MAX_TRUST_ENTRIES) {
      throw new ConfigurationError("Workspace trust 항목 수가 너무 많습니다.");
    }
    return document.entries.map((value, index) => {
      const raw = object(value, `Workspace trust entry ${index}`);
      const source = text(raw.source, `Workspace trust entry ${index} source`);
      const canonicalPath = text(raw.canonicalPath, `Workspace trust entry ${index} path`);
      if (!isAbsolute(canonicalPath)) {
        throw new ConfigurationError(`Workspace trust entry ${index} path는 절대 경로여야 합니다.`);
      }
      if (source !== "interactive" && source !== "cli") {
        throw new ConfigurationError(`Workspace trust entry ${index} source가 올바르지 않습니다.`);
      }
      return {
        canonicalPath,
        device: integer(raw.device, `Workspace trust entry ${index} device`),
        inode: integer(raw.inode, `Workspace trust entry ${index} inode`),
        trustedAt: text(raw.trustedAt, `Workspace trust entry ${index} trustedAt`),
        source,
      };
    });
  }

  async #write(entries: readonly TrustRecord[]): Promise<void> {
    await writeJsonObjectAtomic(
      this.path,
      {
        schemaVersion: TRUST_SCHEMA_VERSION,
        entries: entries.map(trustRecordToJson),
      },
      {
        label: "Workspace trust 저장소",
        maxBytes: MAX_TRUST_BYTES,
        directoryMode: 0o700,
        fileMode: 0o600,
        requireOwner: true,
      },
    );
  }

  async list(): Promise<readonly TrustRecord[]> {
    return (await this.#read()).map((entry) => ({ ...entry }));
  }

  async isTrusted(path: string): Promise<boolean> {
    const identity = await workspaceIdentity(path);
    return (await this.#read()).some((entry) => sameIdentity(entry, identity));
  }

  async trust(grant: ExplicitTrustGrant): Promise<TrustRecord> {
    if (!(grant instanceof ExplicitTrustGrant) || !grant.isExplicit()) {
      throw new PermissionDeniedError("명시적인 사용자 workspace trust 확인이 필요합니다.");
    }
    const currentIdentity = await workspaceIdentity(grant.identity.canonicalPath);
    if (!sameIdentity(grant.identity, currentIdentity)) {
      throw new PermissionDeniedError("확인 이후 workspace identity가 변경됐습니다.");
    }
    const entries = await this.#read();
    const record: TrustRecord = {
      ...currentIdentity,
      trustedAt: grant.confirmedAt,
      source: grant.source,
    };
    const next = entries.filter(
      (entry) => entry.canonicalPath !== record.canonicalPath,
    );
    if (next.length >= MAX_TRUST_ENTRIES) {
      throw new ConfigurationError("저장 가능한 workspace trust 수를 초과했습니다.");
    }
    next.push(record);
    next.sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath));
    await this.#write(next);
    return { ...record };
  }

  async revoke(path: string): Promise<boolean> {
    const canonicalPath = (await workspaceIdentity(path)).canonicalPath;
    const entries = await this.#read();
    const next = entries.filter((entry) => entry.canonicalPath !== canonicalPath);
    if (next.length === entries.length) return false;
    await this.#write(next);
    return true;
  }
}

export async function inspectProjectCustomization(
  paths: StoragePaths,
): Promise<ProjectCustomization> {
  if (!isInside(paths.projectRoot, paths.workspace)) {
    throw new ConfigurationError("Workspace가 project root 밖에 있습니다.");
  }
  const reasons: string[] = [];
  const knownProjectPaths = [
    paths.projectSettings,
    paths.projectLocalSettings,
    paths.projectCommands,
    paths.projectSkills,
  ];
  for (const path of knownProjectPaths) {
    if (await exists(path)) reasons.push(relative(paths.projectRoot, path));
  }

  const instructionNames = [
    "AGENTS.override.md",
    "AGENTS.md",
    "SMILESERV.md",
    "CAGENT.md",
  ];
  for (let current = paths.workspace; isInside(paths.projectRoot, current); current = dirname(current)) {
    for (const name of instructionNames) {
      const path = join(current, name);
      if (await exists(path)) reasons.push(relative(paths.projectRoot, path) || name);
    }
    if (current === paths.projectRoot) break;
  }
  return {
    present: reasons.length > 0,
    reasons: [...new Set(reasons)].sort(),
  };
}

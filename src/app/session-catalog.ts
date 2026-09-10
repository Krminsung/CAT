import { ConfigurationError } from "../core/errors.js";
import { canonicalWorkspace } from "../storage/paths.js";
import type {
  SessionJsonlStore,
  StoredSessionRecord,
} from "../storage/sessions.js";
import { assertSessionId } from "../storage/sessions.js";

const PAGE_RECORDS = 250;
const MAX_RECORDS = 50_000;
const MAX_PAGES = 512;
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const MAX_RESULTS = 1_000;

export interface SessionCatalogEntry {
  readonly record: StoredSessionRecord;
  readonly warnings: number;
}

function newer(
  current: StoredSessionRecord | undefined,
  candidate: StoredSessionRecord,
): StoredSessionRecord {
  if (!current) return candidate;
  if (candidate.metadata.revision !== current.metadata.revision) {
    return candidate.metadata.revision > current.metadata.revision ? candidate : current;
  }
  return candidate.writtenAt >= current.writtenAt ? candidate : current;
}

function latestFirst(
  left: StoredSessionRecord,
  right: StoredSessionRecord,
): number {
  const updated = Date.parse(right.metadata.updatedAt) - Date.parse(left.metadata.updatedAt);
  if (updated !== 0) return updated;
  const written = Date.parse(right.writtenAt) - Date.parse(left.writtenAt);
  if (written !== 0) return written;
  return right.metadata.sessionId.localeCompare(left.metadata.sessionId);
}

export class SessionCatalog {
  constructor(readonly store: SessionJsonlStore) {}

  async get(sessionId: string): Promise<SessionCatalogEntry | undefined> {
    assertSessionId(sessionId);
    const scanned = await this.#scan();
    const record = scanned.records.get(sessionId);
    return record ? Object.freeze({ record, warnings: scanned.warnings }) : undefined;
  }

  async list(options: {
    readonly cwd?: string;
    readonly limit?: number;
  } = {}): Promise<readonly SessionCatalogEntry[]> {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
      throw new ConfigurationError(`세션 목록 크기는 1–${MAX_RESULTS} 범위여야 합니다.`);
    }
    const cwd = options.cwd === undefined
      ? undefined
      : await canonicalWorkspace(options.cwd);
    const scanned = await this.#scan();
    return Object.freeze(
      [...scanned.records.values()]
        .filter((record) => cwd === undefined || record.metadata.cwd === cwd)
        .sort(latestFirst)
        .slice(0, limit)
        .map((record) => Object.freeze({ record, warnings: scanned.warnings })),
    );
  }

  async #scan(): Promise<{
    readonly records: ReadonlyMap<string, StoredSessionRecord>;
    readonly warnings: number;
  }> {
    const records = new Map<string, StoredSessionRecord>();
    let cursor: string | undefined;
    let pages = 0;
    let count = 0;
    let warnings = 0;
    let snapshotBytes: number | undefined;
    const seenCursors = new Set<string>();
    do {
      if (pages >= MAX_PAGES || count >= MAX_RECORDS) {
        throw new ConfigurationError("세션 index가 탐색 상한을 초과했습니다.");
      }
      const page = await this.store.readSessionPage({
        ...(cursor === undefined ? {} : { cursor }),
        limit: Math.min(PAGE_RECORDS, MAX_RECORDS - count),
      });
      pages += 1;
      count += page.records.length;
      warnings += page.warnings.length + page.omittedWarnings;
      if (snapshotBytes === undefined) {
        snapshotBytes = page.snapshotBytes;
        if (snapshotBytes > MAX_SNAPSHOT_BYTES) {
          throw new ConfigurationError("세션 index snapshot이 허용 크기를 초과했습니다.");
        }
      } else if (snapshotBytes !== page.snapshotBytes) {
        throw new ConfigurationError("세션 index가 목록 탐색 중 변경되었습니다.");
      }
      for (const positioned of page.records) {
        const record = positioned.value;
        records.set(
          record.metadata.sessionId,
          newer(records.get(record.metadata.sessionId), record),
        );
      }
      const next = page.nextCursor;
      if (next !== undefined) {
        if (seenCursors.has(next)) {
          throw new ConfigurationError("세션 index cursor가 반복되었습니다.");
        }
        seenCursors.add(next);
      }
      cursor = next;
    } while (cursor !== undefined);
    return Object.freeze({ records, warnings });
  }
}

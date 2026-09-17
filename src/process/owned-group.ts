import type { ChildProcess } from "node:child_process";
import { opendirSync, readFileSync } from "node:fs";

interface Member {
  readonly pid: number;
  readonly group: number;
  readonly session: number;
  readonly start: string;
  readonly zombie: boolean;
}

function member(pid: number): Member | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
    const group = Number(fields[2]);
    const session = Number(fields[3]);
    const start = fields[19];
    if (!Number.isSafeInteger(group) || !Number.isSafeInteger(session) || !start || !/^\d+$/u.test(start)) {
      return undefined;
    }
    return { pid, group, session, start, zombie: fields[0] === "Z" || fields[0] === "X" };
  } catch {
    return undefined;
  }
}

function same(left: Member, right: Member | undefined): boolean {
  return right !== undefined && left.pid === right.pid && left.start === right.start &&
    left.group === right.group && left.session === right.session;
}

const delay = async (ms: number): Promise<void> => await new Promise((resolve) => setTimeout(resolve, ms));
const groups = new WeakMap<ChildProcess, OwnedProcessGroup>();

/** Never signal a recycled PGID after its leader exits. Linux descendants are
 * identified while a known live group member still anchors ownership. */
export class OwnedProcessGroup {
  readonly #child: ChildProcess;
  readonly #known = new Map<number, Member>();
  #gone = false;
  #cleanup: Promise<boolean> | undefined;

  constructor(child: ChildProcess) {
    this.#child = child;
    const first = child.pid === undefined ? undefined : member(child.pid);
    if (first && first.group === child.pid && first.session === child.pid) this.#known.set(first.pid, first);
  }

  #members(): Member[] | undefined {
    const pid = this.#child.pid;
    if (!pid || this.#gone) return [];
    if (process.platform !== "linux") return undefined;
    const found: Member[] = [];
    try {
      const directory = opendirSync("/proc");
      const deadline = Date.now() + 100;
      try {
        let count = 0;
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (++count > 65_536 || Date.now() > deadline) return undefined;
          if (!/^\d+$/u.test(entry.name)) continue;
          const value = member(Number(entry.name));
          if (value?.group === pid && value.session === pid && !value.zombie) {
            if (found.length >= 4_096) return undefined;
            found.push(value);
          }
        }
      } finally {
        directory.closeSync();
      }
      return found;
    } catch {
      return undefined;
    }
  }

  empty(): boolean {
    if (this.#gone || !this.#child.pid) return true;
    // ESRCH is authoritative even on platforms without /proc. Other errors
    // must not turn an unobservable group into confirmed cleanup.
    if (process.platform !== "win32") {
      try {
        process.kill(-this.#child.pid, 0);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
          this.#gone = true;
          return true;
        }
        return false;
      }
    }
    // An empty /proc scan alone is not proof: entries can be inaccessible.
    return false;
  }

  signal(signal: NodeJS.Signals): boolean {
    if (this.empty()) return false;
    const members = this.#members();
    if (members) {
      const anchored = members.some((value) =>
        same(value, this.#known.get(value.pid)) && same(value, member(value.pid))
      );
      if (!anchored) return false;
      this.#known.clear();
      for (const value of members) this.#known.set(value.pid, value);
      let sent = false;
      for (const value of members) {
        if (!same(value, member(value.pid))) continue;
        try { process.kill(value.pid, signal); sent = true; } catch { /* Already exited. */ }
      }
      return sent;
    }
    // Without a reliable group snapshot, only the still-owned direct child is
    // signalable. Cleanup remains unconfirmed if a process group survives it.
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return false;
    try { return this.#child.kill(signal); } catch { return false; }
  }

  observe(): void {
    const members = this.#members();
    if (!members?.some((value) =>
      same(value, this.#known.get(value.pid)) && same(value, member(value.pid))
    )) return;
    this.#known.clear();
    for (const value of members) this.#known.set(value.pid, value);
  }

  async cleanup(): Promise<boolean> {
    this.#cleanup ??= this.#terminate();
    return await this.#cleanup;
  }

  async #terminate(): Promise<boolean> {
    if (this.empty()) return true;
    this.signal("SIGTERM");
    await delay(250);
    if (this.empty()) return true;
    this.signal("SIGKILL");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await delay(50);
      if (this.empty()) return true;
    }
    return false;
  }
}

export function ownedProcessGroup(child: ChildProcess): OwnedProcessGroup {
  let group = groups.get(child);
  if (!group) { group = new OwnedProcessGroup(child); groups.set(child, group); }
  return group;
}

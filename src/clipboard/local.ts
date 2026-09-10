import { spawn, type ChildProcessByStdio } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import type { Writable } from "node:stream";

import { buildChildEnvironment } from "../security/environment.js";
import {
  MAX_CLIPBOARD_TEXT_BYTES,
  type ClipboardWriteRequest,
  type ClipboardWriteResult,
  type ClipboardWriter,
} from "./types.js";

const CLIPBOARD_TIMEOUT_MS = 1_000;
const CLIPBOARD_FORCE_CLOSE_MS = 250;

interface ClipboardAdapterCandidate {
  readonly id: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: readonly string[];
}

interface ResolvedClipboardAdapter extends ClipboardAdapterCandidate {
  readonly executablePath: string;
}

export interface LocalClipboardWriterOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

function localClipboardAllowed(environment: NodeJS.ProcessEnv): boolean {
  return !environment.SSH_CONNECTION && !environment.SSH_CLIENT && !environment.SSH_TTY;
}

function adapterCandidates(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): readonly ClipboardAdapterCandidate[] {
  if (!localClipboardAllowed(environment)) return [];
  const candidates: ClipboardAdapterCandidate[] = [];
  if (platform === "darwin") {
    candidates.push({ id: "pbcopy", executable: "pbcopy", args: [], environment: [] });
  }
  if (environment.WAYLAND_DISPLAY) {
    candidates.push({
      id: "wl-copy",
      executable: "wl-copy",
      args: ["--type", "text/plain;charset=utf-8"],
      environment: ["WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"],
    });
  }
  if (environment.DISPLAY) {
    candidates.push({
      id: "xclip",
      executable: "xclip",
      args: ["-selection", "clipboard"],
      environment: ["DISPLAY", "XAUTHORITY"],
    });
    candidates.push({
      id: "xsel",
      executable: "xsel",
      args: ["--clipboard", "--input"],
      environment: ["DISPLAY", "XAUTHORITY"],
    });
  }
  if (platform === "win32" || environment.WSL_DISTRO_NAME) {
    candidates.push({
      id: "powershell",
      executable: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
      ],
      environment: ["SYSTEMROOT", "WINDIR", "PATHEXT", "WSL_DISTRO_NAME", "WSL_INTEROP"],
    });
  }
  return candidates;
}

async function resolveExecutable(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (!executable || executable.includes("\0")) return undefined;
  if (isAbsolute(executable)) {
    try {
      await access(executable, fsConstants.X_OK);
      return executable;
    } catch {
      return undefined;
    }
  }
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    if (!directory || !isAbsolute(directory) || directory.includes("\0")) continue;
    const candidate = join(directory, executable);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // 다음 고정 adapter 후보를 확인한다.
    }
  }
  return undefined;
}

async function resolveAdapter(
  candidate: ClipboardAdapterCandidate,
  environment: NodeJS.ProcessEnv,
): Promise<ResolvedClipboardAdapter | undefined> {
  const executablePath = await resolveExecutable(candidate.executable, environment);
  return executablePath ? { ...candidate, executablePath } : undefined;
}

type AdapterWriteStatus = "written" | "failed" | "cancelled";

function terminateOwnedChild(
  child: ChildProcessByStdio<Writable, null, null>,
): void {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // 같은 호출에서 만든 child 자체 종료로 내려간다.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // 이미 끝난 owned child는 종료된 것으로 취급한다.
  }
}

async function writeWithAdapter(
  adapter: ResolvedClipboardAdapter,
  text: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
): Promise<AdapterWriteStatus> {
  if (signal?.aborted) return "cancelled";
  return await new Promise<AdapterWriteStatus>((resolve) => {
    let child: ChildProcessByStdio<Writable, null, null>;
    try {
      child = spawn(adapter.executablePath, [...adapter.args], {
        detached: process.platform !== "win32",
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "ignore", "ignore"],
      });
    } catch {
      resolve("failed");
      return;
    }

    let settled = false;
    let forcedStatus: Exclude<AdapterWriteStatus, "written"> | undefined;
    let forceCloseTimer: NodeJS.Timeout | undefined;
    const finish = (status: AdapterWriteStatus): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceCloseTimer) clearTimeout(forceCloseTimer);
      signal?.removeEventListener("abort", abort);
      resolve(status);
    };
    const stop = (status: Exclude<AdapterWriteStatus, "written">): void => {
      if (settled || forcedStatus) return;
      forcedStatus = status;
      terminateOwnedChild(child);
      forceCloseTimer = setTimeout(() => {
        child.stdin.destroy();
        finish(status);
      }, CLIPBOARD_FORCE_CLOSE_MS);
      forceCloseTimer.unref();
    };
    const abort = (): void => stop("cancelled");
    const timeoutTimer = setTimeout(() => stop("failed"), CLIPBOARD_TIMEOUT_MS);
    timeoutTimer.unref();

    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.on("error", () => stop("failed"));
    child.once("error", () => finish(forcedStatus ?? "failed"));
    child.once("close", (code) => {
      finish(forcedStatus ?? (code === 0 ? "written" : "failed"));
    });
    if (!forcedStatus) {
      try {
        child.stdin.end(Buffer.from(text, "utf8"));
      } catch {
        stop("failed");
      }
    }
  });
}

export class LocalClipboardWriter implements ClipboardWriter {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #platform: NodeJS.Platform;

  constructor(options: LocalClipboardWriterOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#platform = options.platform ?? process.platform;
  }

  async writeText(request: ClipboardWriteRequest): Promise<ClipboardWriteResult> {
    if (
      typeof request.text !== "string" ||
      (request.origin !== "user_command" && request.origin !== "user_selection")
    ) {
      return Object.freeze({ status: "failed" });
    }
    if (!request.text) return Object.freeze({ status: "empty" });
    if (Buffer.byteLength(request.text, "utf8") > MAX_CLIPBOARD_TEXT_BYTES) {
      return Object.freeze({
        status: "too_large",
        maximumBytes: MAX_CLIPBOARD_TEXT_BYTES,
      });
    }
    if (request.signal?.aborted) return Object.freeze({ status: "cancelled" });

    let found = false;
    for (const candidate of adapterCandidates(this.#platform, this.#environment)) {
      const adapter = await resolveAdapter(candidate, this.#environment);
      if (!adapter) continue;
      found = true;
      let environment: NodeJS.ProcessEnv;
      try {
        environment = buildChildEnvironment({
          source: this.#environment,
          passThrough: adapter.environment,
        });
      } catch {
        continue;
      }
      const status = await writeWithAdapter(adapter, request.text, environment, request.signal);
      if (status === "written") {
        return Object.freeze({ status: "written", adapter: adapter.id });
      }
      if (status === "cancelled") return Object.freeze({ status: "cancelled" });
    }
    return found
      ? Object.freeze({ status: "failed" })
      : Object.freeze({ status: "unavailable" });
  }
}

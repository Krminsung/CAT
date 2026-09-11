import { spawn, type ChildProcessByStdio } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import type { Readable } from "node:stream";

import { ConfigurationError } from "../core/errors.js";
import { buildChildEnvironment } from "../security/environment.js";
import { UserRequestedClipboardWriter } from "./terminal.js";
import type { ClipboardWriter } from "./types.js";

const MAX_SSH_ARGUMENTS = 256;
const MAX_SSH_ARGUMENT_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 64 * 1024;
const MAX_PATH_ENTRIES = 256;
const MAX_PATH_ENTRY_BYTES = 4 * 1024;
const MAX_SSH_AGENT_PATH_BYTES = 4 * 1024;
const MAX_STRING_SEQUENCE_BYTES = 100_016;
const MAX_CSI_SEQUENCE_BYTES = 4 * 1024;
const MAX_ESCAPE_SEQUENCE_BYTES = 64;
const MAX_REMOTE_CLIPBOARD_PAYLOAD_BYTES = 100_000;
const MAX_REMOTE_CLIPBOARD_TEXT_BYTES = 74_994;
const MAX_REMOTE_CLIPBOARD_REQUESTS = 32;
const MAX_PENDING_CLIPBOARD_REQUESTS = 4;
const PARSER_CHUNK_BYTES = 64 * 1024;
const MAX_FEED_BYTES = 1024 * 1024;
const TERMINATE_GRACE_MS = 1_500;
const FORCE_CLOSE_MS = 1_000;
const CLIPBOARD_REQUEST_DEADLINE_MS = 1_500;
const CLIPBOARD_DRAIN_MS = 7_000;
const COUNTER_LIMIT = 1_000_000;
const TERMINAL_RESTORE =
  "\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?1015l" +
  "\u001b[?2004l\u001b[?1049l\u001b[0m\u001b[?25h";
const SAFE_OSC52_SELECTIONS = new Set(["", "c", "p", "pc", "cp"]);
const ESC_DISCARDED_STRING_STARTERS = new Set(["P", "X", "^", "_", "k"]);
const C1_DISCARDED_STRING_STARTERS = new Set(["\u0090", "\u0098", "\u009e", "\u009f"]);

type StringSequence = "osc" | "discard";

export interface SshClipboardBridgeResult {
  readonly exitCode: number;
  readonly cleanupConfirmed: boolean;
  readonly filteredSequences: number;
  readonly blockedReadRequests: number;
  readonly clipboardFailures: number;
  readonly clipboardWrites: number;
}

export interface SshClipboardBridgeOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly clipboard?: ClipboardWriter;
}

function increment(value: number): number {
  return Math.min(COUNTER_LIMIT, value + 1);
}

function total(left: number, right: number): number {
  return Math.min(COUNTER_LIMIT, left + right);
}

function isC1Control(character: string): boolean {
  const code = character.codePointAt(0) ?? -1;
  return code >= 0x80 && code <= 0x9f;
}

function safeSshArguments(args: readonly string[]): readonly string[] {
  if (args.length < 1 || args.length > MAX_SSH_ARGUMENTS) {
    throw new ConfigurationError(`SSH 인자는 1–${MAX_SSH_ARGUMENTS}개여야 합니다.`);
  }
  let bytes = 0;
  const result: string[] = [];
  for (const argument of args) {
    bytes += Buffer.byteLength(argument, "utf8") + 1;
    if (
      !argument ||
      argument.includes("\0") ||
      /[\p{Cc}\p{Cf}]/u.test(argument) ||
      bytes > MAX_SSH_ARGUMENT_BYTES
    ) {
      throw new ConfigurationError("SSH 인자의 형식 또는 전체 크기가 올바르지 않습니다.");
    }
    result.push(argument);
  }
  return Object.freeze(result);
}

async function resolveExecutable(
  name: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const path = environment.PATH ?? "";
  if (!name || name.includes("\0") || Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) {
    return undefined;
  }
  const candidates = isAbsolute(name)
    ? [name]
    : path.split(delimiter).slice(0, MAX_PATH_ENTRIES).flatMap((directory) =>
        directory &&
          isAbsolute(directory) &&
          !directory.includes("\0") &&
          Buffer.byteLength(directory, "utf8") <= MAX_PATH_ENTRY_BYTES
          ? [join(directory, name)]
          : []
      );
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      const info = await stat(canonical);
      if (!info.isFile()) continue;
      await access(canonical, fsConstants.X_OK);
      return canonical;
    } catch {
      // 다음 bounded PATH 후보를 확인한다.
    }
  }
  return undefined;
}

function sshEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = buildChildEnvironment({ source });
  const agent = source.SSH_AUTH_SOCK;
  if (agent) {
    if (
      agent.includes("\0") ||
      /[\p{Cc}\p{Cf}]/u.test(agent) ||
      Buffer.byteLength(agent, "utf8") > MAX_SSH_AGENT_PATH_BYTES ||
      (!isAbsolute(agent) && !agent.startsWith("@"))
    ) {
      throw new ConfigurationError("SSH agent socket 경로가 올바르지 않습니다.");
    }
    // 이 명시적 SSH 전용 경로만 agent capability를 전달하며 값을 출력하지 않는다.
    environment.SSH_AUTH_SOCK = agent;
  }
  return environment;
}

export class SshClipboardEscapeFilter {
  readonly #copy: (text: string) => boolean;
  readonly #decoder = new TextDecoder("utf-8", { fatal: false });
  #state: "text" | "escape" | "csi" | "escape_sequence" | "string" = "text";
  #controlBuffer: string[] = [];
  #controlBytes = 0;
  #controlOversized = false;
  #sequence: StringSequence = "discard";
  #sequenceBuffer: string[] = [];
  #sequencePrefix = "";
  #sequenceBytes = 0;
  #sequenceEscape = false;
  #sequenceOversized = false;
  #filteredSequences = 0;
  #blockedReadRequests = 0;
  #failures = 0;
  #acceptedWrites = 0;

  constructor(copy: (text: string) => boolean) {
    this.#copy = copy;
  }

  get filteredSequences(): number { return this.#filteredSequences; }
  get blockedReadRequests(): number { return this.#blockedReadRequests; }
  get failures(): number { return this.#failures; }
  get acceptedWrites(): number { return this.#acceptedWrites; }

  feed(data: Uint8Array): Buffer {
    if (data.byteLength > MAX_FEED_BYTES) {
      throw new RangeError("SSH bridge 입력 chunk가 1MiB 상한을 초과했습니다.");
    }
    const output: string[] = [];
    for (let offset = 0; offset < data.byteLength; offset += PARSER_CHUNK_BYTES) {
      const part = data.subarray(offset, Math.min(data.byteLength, offset + PARSER_CHUNK_BYTES));
      output.push(this.#consume(this.#decoder.decode(part, { stream: true })));
    }
    return Buffer.from(output.join(""), "utf8");
  }

  finish(): Buffer {
    const output = this.#consume(this.#decoder.decode());
    this.#resetControl();
    this.#resetSequence();
    this.#state = "text";
    return Buffer.from(output, "utf8");
  }

  #consume(value: string): string {
    const output: string[] = [];
    for (const character of value) {
      if (this.#state === "text") {
        if (character === "\u001b") {
          this.#state = "escape";
        } else if (character === "\u009d") {
          this.#startSequence("osc");
        } else if (C1_DISCARDED_STRING_STARTERS.has(character)) {
          this.#startSequence("discard");
        } else if (!isC1Control(character)) {
          output.push(character);
        }
        continue;
      }

      if (this.#state === "escape") {
        if (character === "]") {
          this.#startSequence("osc");
        } else if (ESC_DISCARDED_STRING_STARTERS.has(character)) {
          this.#startSequence("discard");
        } else if (character === "[") {
          this.#startControl("csi", "\u001b[");
        } else if (character === "\u001b") {
          // 앞의 불완전한 ESC는 버리고 가장 최근 ESC만 보류한다.
        } else if (character === "\u009d") {
          this.#startSequence("osc");
        } else if (C1_DISCARDED_STRING_STARTERS.has(character)) {
          this.#startSequence("discard");
        } else if (isC1Control(character)) {
          this.#state = "text";
        } else {
          const code = character.codePointAt(0) ?? -1;
          if (code >= 0x20 && code <= 0x2f) {
            this.#startControl("escape_sequence", `\u001b${character}`);
          } else if (code >= 0x30 && code <= 0x7e) {
            output.push("\u001b", character);
            this.#state = "text";
          } else {
            this.#state = "text";
          }
        }
        continue;
      }

      if (this.#state === "csi" || this.#state === "escape_sequence") {
        if (character === "\u001b") {
          this.#resetControl();
          this.#state = "escape";
          continue;
        }
        if (character === "\u009d") {
          this.#resetControl();
          this.#startSequence("osc");
          continue;
        }
        if (C1_DISCARDED_STRING_STARTERS.has(character)) {
          this.#resetControl();
          this.#startSequence("discard");
          continue;
        }
        const code = character.codePointAt(0) ?? -1;
        const final = this.#state === "csi"
          ? code >= 0x40 && code <= 0x7e
          : code >= 0x30 && code <= 0x7e;
        const intermediate = this.#state === "csi"
          ? code >= 0x20 && code <= 0x3f
          : code >= 0x20 && code <= 0x2f;
        if (final) {
          this.#appendControl(character);
          if (!this.#controlOversized) output.push(this.#controlBuffer.join(""));
          this.#resetControl();
          this.#state = "text";
        } else if (intermediate) {
          this.#appendControl(character);
        } else {
          this.#resetControl();
          this.#state = "text";
        }
        continue;
      }

      if (character === "\u009c") {
        this.#completeSequence();
        continue;
      }
      if (this.#sequence === "osc" && character === "\u0007") {
        this.#completeSequence();
        continue;
      }
      if (this.#sequenceEscape) {
        if (character === "\\") {
          this.#completeSequence();
          continue;
        }
        this.#appendSequence("\u001b");
        this.#sequenceEscape = character === "\u001b";
        if (!this.#sequenceEscape) this.#appendSequence(character);
        continue;
      }
      if (character === "\u001b") {
        this.#sequenceEscape = true;
      } else {
        this.#appendSequence(character);
      }
    }
    return output.join("");
  }

  #startSequence(sequence: StringSequence): void {
    this.#resetControl();
    this.#state = "string";
    this.#sequence = sequence;
    this.#sequenceBuffer = [];
    this.#sequencePrefix = "";
    this.#sequenceBytes = 0;
    this.#sequenceEscape = false;
    this.#sequenceOversized = false;
    this.#filteredSequences = increment(this.#filteredSequences);
  }

  #startControl(state: "csi" | "escape_sequence", prefix: string): void {
    this.#resetControl();
    this.#state = state;
    this.#controlBuffer = [prefix];
    this.#controlBytes = Buffer.byteLength(prefix, "utf8");
    this.#controlOversized = false;
  }

  #appendControl(character: string): void {
    if (this.#controlOversized) return;
    this.#controlBytes += Buffer.byteLength(character, "utf8");
    const maximum = this.#state === "csi"
      ? MAX_CSI_SEQUENCE_BYTES
      : MAX_ESCAPE_SEQUENCE_BYTES;
    if (this.#controlBytes > maximum) {
      this.#controlOversized = true;
      this.#controlBuffer = [];
      return;
    }
    this.#controlBuffer.push(character);
  }

  #resetControl(): void {
    this.#controlBuffer = [];
    this.#controlBytes = 0;
    this.#controlOversized = false;
  }

  #appendSequence(character: string): void {
    if (this.#sequence !== "osc" || this.#sequenceOversized) return;
    if (this.#sequencePrefix.length < 3) this.#sequencePrefix += character;
    this.#sequenceBytes += Buffer.byteLength(character, "utf8");
    if (this.#sequenceBytes > MAX_STRING_SEQUENCE_BYTES) {
      this.#sequenceOversized = true;
      this.#sequenceBuffer = [];
      return;
    }
    this.#sequenceBuffer.push(character);
  }

  #completeSequence(): void {
    if (this.#sequence === "osc") this.#consumeOsc52();
    this.#resetSequence();
    this.#state = "text";
  }

  #resetSequence(): void {
    this.#sequence = "discard";
    this.#sequenceBuffer = [];
    this.#sequencePrefix = "";
    this.#sequenceBytes = 0;
    this.#sequenceEscape = false;
    this.#sequenceOversized = false;
  }

  #consumeOsc52(): void {
    if (this.#sequenceOversized) {
      if (this.#sequencePrefix === "52;") this.#failures = increment(this.#failures);
      return;
    }
    const value = this.#sequenceBuffer.join("");
    if (!value.startsWith("52;")) return;
    const separator = value.indexOf(";", 3);
    if (separator < 0) {
      this.#failures = increment(this.#failures);
      return;
    }
    const selection = value.slice(3, separator);
    const payload = value.slice(separator + 1);
    if (!SAFE_OSC52_SELECTIONS.has(selection)) {
      this.#failures = increment(this.#failures);
      return;
    }
    if (payload === "?") {
      this.#blockedReadRequests = increment(this.#blockedReadRequests);
      return;
    }
    if (
      !payload ||
      Buffer.byteLength(payload, "ascii") > MAX_REMOTE_CLIPBOARD_PAYLOAD_BYTES ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(payload)
    ) {
      this.#failures = increment(this.#failures);
      return;
    }
    try {
      const decoded = Buffer.from(payload, "base64");
      if (
        decoded.byteLength > MAX_REMOTE_CLIPBOARD_TEXT_BYTES ||
        decoded.toString("base64") !== payload
      ) {
        throw new Error("OSC52 payload가 canonical base64가 아닙니다.");
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
      if (!text || !this.#copy(text)) {
        this.#failures = increment(this.#failures);
        return;
      }
      this.#acceptedWrites = increment(this.#acceptedWrites);
    } catch {
      this.#failures = increment(this.#failures);
    }
  }
}

class ClipboardWriteQueue {
  readonly #writer: ClipboardWriter;
  readonly #controller = new AbortController();
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;
  #accepted = 0;
  #failures = 0;
  #writes = 0;
  #closed = false;

  constructor(writer: ClipboardWriter) {
    this.#writer = writer;
  }

  get failures(): number { return this.#failures; }
  get writes(): number { return this.#writes; }

  offer(text: string): boolean {
    if (
      this.#closed ||
      !text ||
      this.#accepted >= MAX_REMOTE_CLIPBOARD_REQUESTS ||
      this.#pending >= MAX_PENDING_CLIPBOARD_REQUESTS
    ) {
      return false;
    }
    this.#accepted += 1;
    this.#pending += 1;
    this.#tail = this.#tail.then(async () => {
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      const timer = setTimeout(abort, CLIPBOARD_REQUEST_DEADLINE_MS);
      this.#controller.signal.addEventListener("abort", abort, { once: true });
      if (this.#controller.signal.aborted) abort();
      try {
        const result = await this.#writer.writeText({
          text,
          origin: "user_command",
          signal: controller.signal,
        });
        if (result.status === "written") this.#writes = increment(this.#writes);
        else this.#failures = increment(this.#failures);
      } catch {
        this.#failures = increment(this.#failures);
      } finally {
        clearTimeout(timer);
        this.#controller.signal.removeEventListener("abort", abort);
        this.#pending -= 1;
      }
    });
    return true;
  }

  abort(): void {
    this.#closed = true;
    this.#controller.abort();
  }

  async close(): Promise<boolean> {
    this.#closed = true;
    let timer: NodeJS.Timeout | undefined;
    const completed = await Promise.race([
      this.#tail.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), CLIPBOARD_DRAIN_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!completed) this.#controller.abort();
    return completed;
  }
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === "SIGHUP") return 129;
  if (signal === "SIGINT") return 130;
  if (signal === "SIGQUIT") return 131;
  if (signal === "SIGKILL") return 137;
  if (signal === "SIGTERM") return 143;
  return 1;
}

function sendOwnedSignal(
  child: ChildProcessByStdio<null, Readable, Readable>,
  signal: NodeJS.Signals,
): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
    return;
  } catch {
    // 같은 호출에서 생성한 SSH process 자체로만 fallback한다.
  }
  try {
    child.kill(signal);
  } catch {
    // 이미 끝난 owned child는 close event에서 확정한다.
  }
}

function forwardFilteredStream(
  source: Readable,
  destination: NodeJS.WriteStream,
  filter: SshClipboardEscapeFilter,
  onFailure: () => void,
): () => void {
  let waitingForDrain = false;
  const onDrain = (): void => {
    waitingForDrain = false;
    source.resume();
  };
  const onData = (value: Buffer | string): void => {
    try {
      const safe = filter.feed(typeof value === "string" ? Buffer.from(value) : value);
      if (safe.byteLength > 0 && !destination.write(safe) && !waitingForDrain) {
        waitingForDrain = true;
        source.pause();
        destination.once("drain", onDrain);
      }
    } catch {
      onFailure();
    }
  };
  const onError = (): void => onFailure();
  source.on("data", onData);
  source.once("error", onError);
  return () => {
    source.off("data", onData);
    source.off("error", onError);
    if (waitingForDrain) destination.off("drain", onDrain);
  };
}

export async function runSshClipboardBridge(
  rawArguments: readonly string[],
  options: SshClipboardBridgeOptions = {},
): Promise<SshClipboardBridgeResult> {
  if (process.platform === "win32") {
    throw new ConfigurationError("SSH clipboard bridge는 Linux, macOS 또는 WSL 터미널에서 사용하세요.");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) {
    throw new ConfigurationError("SSH clipboard bridge는 stdin/stdout/stderr가 모두 TTY여야 합니다.");
  }
  const sourceEnvironment = options.environment ?? process.env;
  if (sourceEnvironment.SSH_CONNECTION || sourceEnvironment.SSH_CLIENT || sourceEnvironment.SSH_TTY) {
    throw new ConfigurationError("SSH clipboard bridge는 원격 서버 안이 아니라 접속하는 PC에서 실행하세요.");
  }
  const args = safeSshArguments(rawArguments);
  const executable = await resolveExecutable("ssh", sourceEnvironment);
  if (!executable) throw new ConfigurationError("OpenSSH ssh 실행 파일을 찾을 수 없습니다.");
  const environment = sshEnvironment(sourceEnvironment);
  const clipboard = options.clipboard ?? new UserRequestedClipboardWriter({
    output: process.stdout,
    enabled: true,
    environment: sourceEnvironment,
  });
  const queue = new ClipboardWriteQueue(clipboard);
  const stdoutFilter = new SshClipboardEscapeFilter((text) => queue.offer(text));
  const stderrFilter = new SshClipboardEscapeFilter((text) => queue.offer(text));

  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(executable, ["-tt", ...args], {
      detached: true,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["inherit", "pipe", "pipe"],
    });
  } catch (error) {
    throw new ConfigurationError("SSH process를 시작하지 못했습니다.", { cause: error });
  }

  return await new Promise<SshClipboardBridgeResult>((resolve) => {
    let finalized = false;
    let requestedExitCode: number | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;

    const flush = (filter: SshClipboardEscapeFilter, destination: NodeJS.WriteStream): void => {
      try {
        const pending = filter.finish();
        if (pending.byteLength > 0) destination.write(pending);
      } catch {
        // 종료 중 화면 출력 실패는 cleanupConfirmed와 exit code로 드러낸다.
      }
    };
    const removeStdout = forwardFilteredStream(
      child.stdout,
      process.stdout,
      stdoutFilter,
      () => terminate("SIGTERM", 1),
    );
    const removeStderr = forwardFilteredStream(
      child.stderr,
      process.stderr,
      stderrFilter,
      () => terminate("SIGTERM", 1),
    );
    const onResize = (): void => sendOwnedSignal(child, "SIGWINCH");
    const onInterrupt = (): void => terminate("SIGINT", 130);
    const onTerminate = (): void => terminate("SIGTERM", 143);
    const onHangup = (): void => terminate("SIGHUP", 129);

    const detachListeners = (): void => {
      removeStdout();
      removeStderr();
      process.off("SIGWINCH", onResize);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      process.off("SIGHUP", onHangup);
    };

    const finalize = async (exitCode: number, cleanupConfirmed: boolean): Promise<void> => {
      if (finalized) return;
      finalized = true;
      if (killTimer) clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
      detachListeners();
      flush(stdoutFilter, process.stdout);
      flush(stderrFilter, process.stderr);
      if (!(await queue.close())) cleanupConfirmed = false;
      try {
        process.stdout.write(TERMINAL_RESTORE);
      } catch {
        cleanupConfirmed = false;
      }
      resolve(Object.freeze({
        exitCode,
        cleanupConfirmed,
        filteredSequences: total(stdoutFilter.filteredSequences, stderrFilter.filteredSequences),
        blockedReadRequests: total(
          stdoutFilter.blockedReadRequests,
          stderrFilter.blockedReadRequests,
        ),
        clipboardFailures: total(
          total(stdoutFilter.failures, stderrFilter.failures),
          queue.failures,
        ),
        clipboardWrites: queue.writes,
      }));
    };

    function terminate(signal: NodeJS.Signals, exitCode: number): void {
      if (finalized) return;
      requestedExitCode ??= exitCode;
      queue.abort();
      sendOwnedSignal(child, signal);
      if (killTimer) return;
      killTimer = setTimeout(() => {
        sendOwnedSignal(child, "SIGKILL");
        forceTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          void finalize(requestedExitCode ?? 1, false);
        }, FORCE_CLOSE_MS);
        forceTimer.unref();
      }, TERMINATE_GRACE_MS);
      killTimer.unref();
    }

    process.on("SIGWINCH", onResize);
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    process.on("SIGHUP", onHangup);
    child.once("error", () => {
      if (child.pid === undefined) void finalize(requestedExitCode ?? 1, true);
      else terminate("SIGTERM", requestedExitCode ?? 1);
    });
    child.once("close", (code, signal) => {
      const selected = requestedExitCode ?? (
        code !== null && Number.isSafeInteger(code) && code >= 0 && code <= 255
          ? code
          : signalExitCode(signal)
      );
      void finalize(selected, true);
    });
  });
}

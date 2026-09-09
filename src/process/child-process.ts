import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

const MAX_CAPTURE_TIMEOUT_MS = 300_000;
const MAX_CAPTURE_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURE_ARGUMENTS = 4_096;
const MAX_CAPTURE_ARGUMENT_BYTES = 1024 * 1024;

export interface ChildCaptureOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
}

export interface ChildCaptureResult {
  started: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  outputLimitReached: boolean;
  spawnErrorCode?: string;
  spawnErrorMessage?: string;
}

function errorCode(error: Error): string | undefined {
  if (!("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function decode(chunks: readonly Buffer[]): string {
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

function assertCaptureRequest(
  executable: string,
  args: readonly string[],
  options: ChildCaptureOptions,
): void {
  const argumentBytes = args.reduce(
    (total, argument) => total + Buffer.byteLength(argument, "utf8") + 1,
    0,
  );
  if (
    !executable ||
    executable.includes("\0") ||
    !options.cwd ||
    options.cwd.includes("\0") ||
    args.length > MAX_CAPTURE_ARGUMENTS ||
    args.some((argument) => argument.includes("\0")) ||
    argumentBytes > MAX_CAPTURE_ARGUMENT_BYTES ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > MAX_CAPTURE_TIMEOUT_MS ||
    !Number.isSafeInteger(options.maxOutputBytes) ||
    options.maxOutputBytes < 1 ||
    options.maxOutputBytes > MAX_CAPTURE_OUTPUT_BYTES
  ) {
    throw new RangeError("자식 프로세스 실행 제한이 올바르지 않습니다.");
  }
}

export async function captureChildProcess(
  executable: string,
  args: readonly string[],
  options: ChildCaptureOptions,
): Promise<ChildCaptureResult> {
  assertCaptureRequest(executable, args, options);
  if (options.signal.aborted) {
    return {
      started: false,
      stdout: "",
      stderr: "",
      exitCode: null,
      exitSignal: null,
      timedOut: false,
      cancelled: true,
      outputLimitReached: false,
    };
  }
  return await new Promise<ChildCaptureResult>((resolve) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: options.environment,
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("자식 프로세스를 시작하지 못했습니다.");
      const code = errorCode(failure);
      resolve({
        started: false,
        stdout: "",
        stderr: "",
        exitCode: null,
        exitSignal: null,
        timedOut: false,
        cancelled: false,
        outputLimitReached: false,
        ...(code === undefined ? {} : { spawnErrorCode: code }),
        spawnErrorMessage: failure.message,
      });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let retainedBytes = 0;
    let settled = false;
    let terminating = false;
    let timedOut = false;
    let cancelled = false;
    let outputLimitReached = false;
    let spawnError: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let forceCloseTimer: NodeJS.Timeout | undefined;

    const sendSignal = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      if (process.platform !== "win32") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // 같은 호출에서 생성한 child만 fallback으로 종료한다.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // 이미 끝난 owned child는 종료된 것으로 취급한다.
      }
    };

    const terminate = (): void => {
      if (terminating || settled) return;
      terminating = true;
      sendSignal("SIGTERM");
      killTimer = setTimeout(() => {
        sendSignal("SIGKILL");
        forceCloseTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(null, null);
        }, 1_000);
      }, 250);
    };

    const collect = (stream: Readable, destination: Buffer[]): void => {
      stream.on("data", (value: Buffer | string) => {
        if (settled) return;
        const chunk = typeof value === "string" ? Buffer.from(value) : value;
        const available = Math.max(0, options.maxOutputBytes - retainedBytes);
        const accepted = chunk.subarray(0, available);
        if (accepted.byteLength > 0) destination.push(Buffer.from(accepted));
        retainedBytes += accepted.byteLength;
        if (accepted.byteLength < chunk.byteLength) {
          outputLimitReached = true;
          terminate();
        }
      });
    };

    const abort = (): void => {
      cancelled = true;
      terminate();
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);

    function finish(code: number | null, signal: NodeJS.Signals | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (forceCloseTimer) clearTimeout(forceCloseTimer);
      options.signal.removeEventListener("abort", abort);
      const codeValue = spawnError ? errorCode(spawnError) : undefined;
      resolve({
        started: child.pid !== undefined,
        stdout: decode(stdout),
        stderr: decode(stderr),
        exitCode: code,
        exitSignal: signal,
        timedOut,
        cancelled: cancelled || options.signal.aborted,
        outputLimitReached,
        ...(codeValue ? { spawnErrorCode: codeValue } : {}),
        ...(spawnError ? { spawnErrorMessage: spawnError.message } : {}),
      });
    }

    collect(child.stdout, stdout);
    collect(child.stderr, stderr);
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    child.once("error", (error) => {
      spawnError = error;
      if (!child.pid) finish(null, null);
    });
    child.once("close", finish);
  });
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { JsonObject, JsonValue } from "../core/json.js";
import { ConfigurationError } from "../core/errors.js";
import { Redactor } from "../security/redaction.js";
import { McpError } from "./errors.js";

export const MCP_MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const MCP_MAX_STDERR_BYTES = 64 * 1024;

const MAX_PENDING_REQUESTS = 256;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_TIMEOUT_MS = 5 * 60_000;
const STDIN_CLOSE_GRACE_MS = 250;
const TERM_GRACE_MS = 1_500;
const KILL_GRACE_MS = 1_000;
const MAX_ARGUMENTS = 4_096;
const MAX_ARGUMENT_BYTES = 1024 * 1024;
const MAX_METHOD_BYTES = 256;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const INITIAL_FRAME_CAPACITY = 64 * 1024;

export type McpTransportState = "idle" | "starting" | "running" | "closing" | "closed" | "failed";

export interface McpStdioTransportOptions {
  readonly serverName: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  readonly redactor?: Redactor;
}

interface PendingRequest {
  readonly method: string;
  readonly signal?: AbortSignal;
  readonly abort?: () => void;
  readonly timer: NodeJS.Timeout;
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: Error) => void;
}

function assertTransportOptions(options: McpStdioTransportOptions): void {
  const args = options.args ?? [];
  const argumentBytes = args.reduce(
    (total, argument) => total + Buffer.byteLength(argument, "utf8") + 1,
    0,
  );
  const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (
    !options.serverName ||
    Buffer.byteLength(options.serverName, "utf8") > 256 ||
    /[\u0000-\u001f\u007f]/u.test(options.serverName) ||
    !options.command ||
    options.command.includes("\0") ||
    !options.cwd ||
    options.cwd.includes("\0") ||
    args.length > MAX_ARGUMENTS ||
    args.some((argument) => argument.includes("\0")) ||
    argumentBytes > MAX_ARGUMENT_BYTES ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new ConfigurationError("MCP stdio transport 설정 또는 실행 제한이 올바르지 않습니다.");
  }
}

function validMethod(method: string): boolean {
  return Boolean(method) &&
    Buffer.byteLength(method, "utf8") <= MAX_METHOD_BYTES &&
    !/[\u0000-\u001f\u007f]/u.test(method);
}

function assertJsonTree(value: unknown): asserts value is JsonValue {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      throw new McpError("MCP JSON-RPC message의 구조 제한을 초과했습니다.");
    }
    const item = current.value;
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    ) {
      continue;
    }
    if (Array.isArray(item)) {
      for (const child of item) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (typeof item !== "object") {
      throw new McpError("MCP JSON-RPC message에 JSON이 아닌 값이 있습니다.");
    }
    for (const child of Object.values(item as Record<string, unknown>)) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRpcId(value: unknown): value is string | number {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  ) || (typeof value === "number" && Number.isSafeInteger(value));
}

function encodeFrame(message: JsonObject, label: string): Buffer {
  let serialized: string;
  try {
    const value = JSON.stringify(message);
    if (value === undefined) throw new Error("undefined JSON");
    serialized = value;
  } catch (error) {
    throw new McpError(`${label}을 JSON으로 직렬화하지 못했습니다.`, { cause: error });
  }
  const frame = Buffer.from(`${serialized}\n`, "utf8");
  if (frame.byteLength > MCP_MAX_FRAME_BYTES) {
    throw new McpError(`${label}이 ${MCP_MAX_FRAME_BYTES} bytes 제한을 초과했습니다.`);
  }
  return frame;
}

function ownedSignal(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // 같은 호출에서 생성한 child만 직접 종료하는 fallback이다.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // 이미 종료된 소유 child는 종료된 것으로 취급한다.
  }
}

export class McpStdioTransport {
  readonly serverName: string;
  readonly #options: McpStdioTransportOptions;
  readonly #requestTimeoutMs: number;
  readonly #redactor: Redactor;
  readonly #pending = new Map<number, PendingRequest>();
  #process: ChildProcessWithoutNullStreams | undefined;
  #state: McpTransportState = "idle";
  #nextRequestId = 1;
  #frameBuffer = Buffer.allocUnsafe(INITIAL_FRAME_CAPACITY);
  #frameLength = 0;
  #stderrTail = Buffer.alloc(0);
  #startPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: McpStdioTransportOptions) {
    assertTransportOptions(options);
    this.#options = options;
    this.serverName = options.serverName;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#redactor = options.redactor ?? new Redactor();
  }

  get state(): McpTransportState {
    return this.#state;
  }

  connected(): boolean {
    return this.#state === "running" &&
      this.#process !== undefined &&
      this.#process.exitCode === null &&
      this.#process.signalCode === null;
  }

  stderrTail(): string {
    return this.#redactor.redact(
      new TextDecoder("utf-8", { fatal: false }).decode(this.#stderrTail),
    );
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.connected()) return;
    if (this.#startPromise) return await this.#startPromise;
    if (this.#closePromise || this.#state === "closing") {
      throw new McpError(`MCP 서버가 종료 중입니다: ${this.serverName}`);
    }
    if (this.#process) {
      throw new McpError(
        `이전 MCP 소유 process 종료를 확인하기 전에는 다시 시작할 수 없습니다: ${this.serverName}`,
      );
    }
    if (signal?.aborted) throw new McpError(`MCP 서버 시작을 취소했습니다: ${this.serverName}`);

    this.#state = "starting";
    this.#frameLength = 0;
    this.#stderrTail = Buffer.alloc(0);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.#options.command, [...(this.#options.args ?? [])], {
        cwd: this.#options.cwd,
        env: this.#options.environment,
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.#state = "failed";
      throw new McpError(`MCP 서버를 시작하지 못했습니다: ${this.serverName}`, { cause: error });
    }
    this.#process = child;
    child.stdout.on("data", (value: Buffer | string) => {
      if (this.#process !== child) return;
      this.#consumeStdout(typeof value === "string" ? Buffer.from(value) : value);
    });
    child.stderr.on("data", (value: Buffer | string) => {
      if (this.#process !== child) return;
      const chunk = typeof value === "string" ? Buffer.from(value) : value;
      if (chunk.byteLength >= MCP_MAX_STDERR_BYTES) {
        this.#stderrTail = Buffer.from(chunk.subarray(-MCP_MAX_STDERR_BYTES));
      } else {
        const retained = this.#stderrTail.subarray(
          Math.max(0, this.#stderrTail.byteLength + chunk.byteLength - MCP_MAX_STDERR_BYTES),
        );
        this.#stderrTail = Buffer.concat([retained, chunk]);
      }
    });
    child.on("error", (error) => {
      if (this.#process !== child) return;
      const failure = new McpError(
        `MCP 서버 process 오류 (${this.serverName}): ${this.#redactor.redact(error.message)}`,
        { cause: error },
      );
      this.#failTransport(failure);
      void this.close("process failure").catch(() => undefined);
    });
    child.stdin.on("error", (error) => {
      if (this.#process !== child) return;
      const failure = new McpError(
        `MCP 서버 stdin 오류 (${this.serverName}): ${this.#redactor.redact(error.message)}`,
        { cause: error },
      );
      this.#failTransport(failure);
      void this.close("stdin failure").catch(() => undefined);
    });
    child.stdout.on("error", (error) => {
      if (this.#process !== child) return;
      const failure = new McpError(
        `MCP 서버 stdout 오류 (${this.serverName}): ${this.#redactor.redact(error.message)}`,
        { cause: error },
      );
      this.#failTransport(failure);
      void this.close("stdout failure").catch(() => undefined);
    });
    child.stdout.once("end", () => {
      if (this.#process !== child) return;
      if (this.#state === "closing" || this.#state === "closed") return;
      const failure = new McpError(`MCP 서버 stdout이 종료되었습니다: ${this.serverName}`);
      this.#failTransport(failure);
      void this.close("stdout ended").catch(() => undefined);
    });
    child.once("exit", (code, exitSignal) => {
      if (this.#process !== child) return;
      const detail = this.stderrTail().trim().slice(-2_000);
      const expected = this.#state === "closing" || this.#state === "closed";
      this.#process = undefined;
      this.#state = expected ? "closed" : "failed";
      this.#failAll(new McpError(
        `MCP 서버 연결이 종료되었습니다: ${this.serverName}` +
          ` (code=${String(code)}, signal=${String(exitSignal)})` +
          (detail ? ` · ${detail}` : ""),
      ));
    });

    const startPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        child.off("spawn", spawned);
        child.off("error", failed);
        signal?.removeEventListener("abort", aborted);
      };
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const spawned = (): void => {
        if (this.#state !== "starting") {
          finish(new McpError(`MCP 서버 시작 상태가 변경되었습니다: ${this.serverName}`));
          return;
        }
        this.#state = "running";
        finish();
      };
      const failed = (error: Error): void => {
        const failure = new McpError(
          `MCP 서버를 시작하지 못했습니다 (${this.serverName}): ${this.#redactor.redact(error.message)}`,
          { cause: error },
        );
        this.#failTransport(failure);
        finish(failure);
      };
      const aborted = (): void => {
        const failure = new McpError(`MCP 서버 시작을 취소했습니다: ${this.serverName}`);
        this.#failTransport(failure);
        void this.close("start cancelled").catch(() => undefined);
        finish(failure);
      };
      child.once("spawn", spawned);
      child.once("error", failed);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
    this.#startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.#startPromise === startPromise) this.#startPromise = undefined;
    }
  }

  async request(
    method: string,
    params: JsonObject = {},
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    if (!validMethod(method)) throw new McpError("MCP 요청 method가 올바르지 않습니다.");
    const child = this.#runningProcess(method);
    if (signal?.aborted) throw new McpError(`MCP 요청을 취소했습니다: ${this.serverName} · ${method}`);
    if (this.#pending.size >= MAX_PENDING_REQUESTS) {
      throw new McpError(`MCP pending 요청이 ${MAX_PENDING_REQUESTS}개 제한에 도달했습니다: ${this.serverName}`);
    }
    const id = this.#allocateRequestId();
    const frame = encodeFrame(
      { jsonrpc: "2.0", id, method, params },
      `MCP 요청 ${this.serverName}.${method}`,
    );
    return await new Promise<JsonValue>((resolve, reject) => {
      const timeout = (): void => {
        const pending = this.#takePending(id);
        if (!pending) return;
        this.#notifyCancellation(id, "request timeout");
        pending.reject(new McpError(`MCP 서버 응답 시간이 초과되었습니다: ${this.serverName} · ${method}`));
      };
      const abort = (): void => {
        const pending = this.#takePending(id);
        if (!pending) return;
        this.#notifyCancellation(id, "request cancelled");
        pending.reject(new McpError(`MCP 요청을 취소했습니다: ${this.serverName} · ${method}`));
      };
      const timer = setTimeout(timeout, this.#requestTimeoutMs);
      timer.unref();
      this.#pending.set(id, {
        method,
        ...(signal === undefined ? {} : { signal, abort }),
        timer,
        resolve,
        reject,
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      try {
        child.stdin.write(frame, (error) => {
          if (!error) return;
          const pending = this.#takePending(id);
          if (!pending) return;
          pending.reject(new McpError(
            `MCP 요청을 쓰지 못했습니다: ${this.serverName} · ${method}`,
            { cause: error },
          ));
        });
      } catch (error) {
        const pending = this.#takePending(id);
        pending?.reject(new McpError(
          `MCP 요청을 쓰지 못했습니다: ${this.serverName} · ${method}`,
          { cause: error },
        ));
      }
    });
  }

  async notify(
    method: string,
    params: JsonObject = {},
    signal?: AbortSignal,
  ): Promise<void> {
    if (!validMethod(method)) throw new McpError("MCP notification method가 올바르지 않습니다.");
    const child = this.#runningProcess(method);
    if (signal?.aborted) {
      throw new McpError(`MCP notification을 취소했습니다: ${this.serverName} · ${method}`);
    }
    const frame = encodeFrame(
      { jsonrpc: "2.0", method, params },
      `MCP notification ${this.serverName}.${method}`,
    );
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const abort = (): void => finish(new McpError(
        `MCP notification을 취소했습니다: ${this.serverName} · ${method}`,
      ));
      const timer = setTimeout(() => finish(new McpError(
        `MCP notification 쓰기 시간이 초과되었습니다: ${this.serverName} · ${method}`,
      )), this.#requestTimeoutMs);
      timer.unref();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      try {
        child.stdin.write(frame, (error) => {
          if (error) {
            finish(new McpError(
              `MCP notification을 쓰지 못했습니다: ${this.serverName} · ${method}`,
              { cause: error },
            ));
          } else {
            finish();
          }
        });
      } catch (error) {
        finish(new McpError(
          `MCP notification을 쓰지 못했습니다: ${this.serverName} · ${method}`,
          { cause: error },
        ));
      }
    });
  }

  async close(reason = "host shutdown"): Promise<void> {
    if (this.#closePromise) return await this.#closePromise;
    const child = this.#process;
    this.#state = "closing";
    this.#failAll(new McpError(`MCP transport를 종료했습니다: ${this.serverName} · ${reason}`));
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.#process = undefined;
      this.#state = "closed";
      return;
    }
    const closing = new Promise<void>((resolve, reject) => {
      let settled = false;
      let termTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      let forceTimer: NodeJS.Timeout | undefined;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (termTimer) clearTimeout(termTimer);
        if (killTimer) clearTimeout(killTimer);
        if (forceTimer) clearTimeout(forceTimer);
        child.off("close", closed);
        if (error) {
          if (this.#process === child) this.#state = "failed";
          reject(error);
          return;
        }
        if (this.#process === child) this.#process = undefined;
        this.#state = "closed";
        resolve();
      };
      const closed = (): void => finish();
      child.once("close", closed);
      try {
        child.stdin.end();
      } catch {
        // 닫힌 stdin은 다음 TERM 단계로 이어간다.
      }
      termTimer = setTimeout(() => {
        ownedSignal(child, "SIGTERM");
        killTimer = setTimeout(() => {
          ownedSignal(child, "SIGKILL");
          forceTimer = setTimeout(() => {
            if (child.exitCode !== null || child.signalCode !== null) {
              finish();
              return;
            }
            finish(new McpError(
              `MCP 소유 process 종료를 확인하지 못했습니다: ${this.serverName}`,
            ));
          }, KILL_GRACE_MS);
          forceTimer.unref();
        }, TERM_GRACE_MS);
        killTimer.unref();
      }, STDIN_CLOSE_GRACE_MS);
      termTimer.unref();
    });
    this.#closePromise = closing;
    try {
      await closing;
    } finally {
      if (this.#closePromise === closing) this.#closePromise = undefined;
    }
  }

  #runningProcess(method: string): ChildProcessWithoutNullStreams {
    const child = this.#process;
    if (!this.connected() || !child || child.stdin.destroyed || !child.stdin.writable) {
      throw new McpError(`MCP 서버가 실행 중이 아닙니다: ${this.serverName} · ${method}`);
    }
    return child;
  }

  #allocateRequestId(): number {
    for (let attempts = 0; attempts <= MAX_PENDING_REQUESTS; attempts += 1) {
      const candidate = this.#nextRequestId;
      this.#nextRequestId = candidate >= Number.MAX_SAFE_INTEGER ? 1 : candidate + 1;
      if (!this.#pending.has(candidate)) return candidate;
    }
    throw new McpError(`MCP 요청 ID를 할당할 수 없습니다: ${this.serverName}`);
  }

  #takePending(id: number): PendingRequest | undefined {
    const pending = this.#pending.get(id);
    if (!pending) return undefined;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.abort) {
      pending.signal.removeEventListener("abort", pending.abort);
    }
    return pending;
  }

  #failAll(error: Error): void {
    for (const id of [...this.#pending.keys()]) {
      this.#takePending(id)?.reject(error);
    }
  }

  #failTransport(error: Error): void {
    if (this.#state !== "closing" && this.#state !== "closed") this.#state = "failed";
    this.#failAll(error);
  }

  #notifyCancellation(requestId: number, reason: string): void {
    if (!this.connected()) return;
    let frame: Buffer;
    try {
      frame = encodeFrame(
        {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId, reason },
        },
        `MCP 취소 notification ${this.serverName}`,
      );
    } catch {
      return;
    }
    try {
      this.#process?.stdin.write(frame, () => undefined);
    } catch {
      // 취소 통지는 best-effort이며 이미 정리한 요청을 되살리지 않는다.
    }
  }

  #ensureFrameCapacity(required: number): boolean {
    if (required > MCP_MAX_FRAME_BYTES) return false;
    if (required <= this.#frameBuffer.byteLength) return true;
    let capacity = this.#frameBuffer.byteLength;
    while (capacity < required) capacity = Math.min(MCP_MAX_FRAME_BYTES, capacity * 2);
    const next = Buffer.allocUnsafe(capacity);
    this.#frameBuffer.copy(next, 0, 0, this.#frameLength);
    this.#frameBuffer = next;
    return true;
  }

  #consumeStdout(chunk: Buffer): void {
    if (this.#state === "closed" || this.#state === "closing") return;
    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.byteLength : newline;
      const length = end - offset;
      const required = this.#frameLength + length;
      if (!this.#ensureFrameCapacity(required)) {
        this.#protocolFailure(`MCP 서버 응답 frame이 ${MCP_MAX_FRAME_BYTES} bytes 제한을 초과했습니다: ${this.serverName}`);
        return;
      }
      if (length > 0) {
        chunk.copy(this.#frameBuffer, this.#frameLength, offset, end);
        this.#frameLength = required;
      }
      if (newline < 0) return;
      let frameLength = this.#frameLength;
      if (frameLength > 0 && this.#frameBuffer[frameLength - 1] === 0x0d) frameLength -= 1;
      if (frameLength > 0) {
        const frame = Buffer.from(this.#frameBuffer.subarray(0, frameLength));
        this.#frameLength = 0;
        if (!this.#handleFrame(frame)) return;
      } else {
        this.#frameLength = 0;
      }
      offset = newline + 1;
    }
  }

  #handleFrame(frame: Buffer): boolean {
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(frame);
    } catch (error) {
      this.#protocolFailure(`MCP 서버가 잘못된 UTF-8을 보냈습니다: ${this.serverName}`, error);
      return false;
    }
    let value: unknown;
    try {
      value = JSON.parse(decoded) as unknown;
      assertJsonTree(value);
    } catch (error) {
      this.#protocolFailure(`MCP 서버가 잘못된 JSON을 보냈습니다: ${this.serverName}`, error);
      return false;
    }
    if (!isRecord(value) || value.jsonrpc !== "2.0") {
      this.#protocolFailure(`MCP 서버가 잘못된 JSON-RPC message를 보냈습니다: ${this.serverName}`);
      return false;
    }
    if (typeof value.method === "string") {
      if (value.id !== undefined && validRpcId(value.id)) this.#rejectServerRequest(value.id);
      return true;
    }
    if (typeof value.id !== "number" || !Number.isSafeInteger(value.id)) {
      this.#protocolFailure(`MCP 서버 응답 ID가 올바르지 않습니다: ${this.serverName}`);
      return false;
    }
    const pending = this.#takePending(value.id);
    if (!pending) return true;
    const hasResult = Object.hasOwn(value, "result");
    const hasError = Object.hasOwn(value, "error");
    if (hasResult === hasError) {
      pending.reject(new McpError(`MCP ${pending.method} 응답 구조가 올바르지 않습니다: ${this.serverName}`));
      return true;
    }
    if (hasError) {
      const rpcError = value.error;
      if (
        !isRecord(rpcError) ||
        !Number.isSafeInteger(rpcError.code) ||
        typeof rpcError.message !== "string"
      ) {
        pending.reject(new McpError(`MCP ${pending.method} 오류 응답이 올바르지 않습니다: ${this.serverName}`));
      } else {
        pending.reject(new McpError(
          `MCP ${pending.method} 오류 (${this.serverName}, ${String(rpcError.code)}): ` +
            this.#redactor.redact(rpcError.message).slice(0, 8_192),
        ));
      }
      return true;
    }
    pending.resolve(value.result as JsonValue);
    return true;
  }

  #rejectServerRequest(id: string | number): void {
    if (!this.connected()) return;
    let frame: Buffer;
    try {
      frame = encodeFrame(
        {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Client method not supported" },
        },
        `MCP client 오류 응답 ${this.serverName}`,
      );
    } catch {
      return;
    }
    try {
      this.#process?.stdin.write(frame, () => undefined);
    } catch {
      // 지원하지 않는 server request 응답 실패는 기존 pending 요청을 반복하지 않는다.
    }
  }

  #protocolFailure(message: string, cause?: unknown): void {
    const error = new McpError(message, cause === undefined ? undefined : { cause });
    this.#failTransport(error);
    void this.close("protocol failure").catch(() => undefined);
  }
}

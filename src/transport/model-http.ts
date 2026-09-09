import type { ReadableStream } from "node:stream/web";
import {
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  type Dispatcher,
  type Headers,
  type RequestInit,
  type Response,
} from "undici";
import {
  CancelledError,
  ConfigurationError,
  ProviderError,
  ProtocolError,
} from "../core/errors.js";
import type {
  RetryBudgetPort,
  TransportRetryReason,
} from "../core/execution.js";

const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_CONFIGURED_BODY_BYTES = 64 * 1024 * 1024;
const MAX_RETRIES = 2;
const MAX_REDIRECTS = 3;
const MAX_TIMEOUT_MS = 300_000;
const MAX_BODY_CHUNKS = 65_536;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

export interface TransportRetryNotice {
  attempt: number;
  delayMs: number;
  reason: TransportRetryReason;
  statusCode?: number;
}

export interface ModelHttpRequest {
  url: URL;
  expectedOrigin: string;
  method: "GET" | "POST";
  headers: Readonly<Record<string, string>>;
  body?: string;
  signal: AbortSignal;
  timeoutMs: number;
  retryBudget: RetryBudgetPort;
  maxRetries?: number;
  maxRequestBytes?: number;
  onRetry?: (notice: TransportRetryNotice) => void;
}

export interface ModelHttpTransportOptions {
  environment?: NodeJS.ProcessEnv;
  dispatcher?: Dispatcher;
  fetchImplementation?: typeof undiciFetch;
  now?: () => number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function errorText(value: unknown, key: "code" | "message"): string {
  const selected = record(value)?.[key];
  return typeof selected === "string" ? selected : "";
}

function isTlsFailure(error: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  const detail = `${errorText(error, "code")} ${errorText(error, "message")}`;
  if (/(?:CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS)/iu.test(detail)) {
    return true;
  }
  const cause = record(error)?.cause;
  return cause !== undefined && cause !== error && isTlsFailure(cause, depth + 1);
}

function positiveInteger(
  value: number,
  label: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ConfigurationError(`${label}은 1–${maximum} 범위의 정수여야 합니다.`);
  }
  return value;
}

function retryCount(value: number | undefined): number {
  const selected = value ?? MAX_RETRIES;
  if (!Number.isSafeInteger(selected) || selected < 0 || selected > MAX_RETRIES) {
    throw new ConfigurationError(`모델 transport 재시도 횟수는 0–${MAX_RETRIES}여야 합니다.`);
  }
  return selected;
}

function environmentChoice(
  environment: NodeJS.ProcessEnv,
  upper: string,
  lower: string,
): string | undefined {
  const upperValue = environment[upper]?.trim();
  const lowerValue = environment[lower]?.trim();
  if (upperValue && lowerValue && upperValue !== lowerValue) {
    throw new ConfigurationError(`${upper}와 ${lower} proxy 설정이 충돌합니다.`);
  }
  return upperValue || lowerValue || undefined;
}

function proxyUrl(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    value.length > 2_048 ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.includes("\\")
  ) {
    throw new ConfigurationError(`${label} proxy URL이 올바르지 않습니다.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError(`${label} proxy URL이 올바르지 않습니다.`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new ConfigurationError(`${label} proxy URL이 올바르지 않습니다.`);
  }
  return value;
}

function createEnvironmentDispatcher(
  environment: NodeJS.ProcessEnv,
): Dispatcher | undefined {
  const httpProxy = proxyUrl(
    environmentChoice(environment, "HTTP_PROXY", "http_proxy"),
    "HTTP_PROXY",
  );
  const httpsProxy = proxyUrl(
    environmentChoice(environment, "HTTPS_PROXY", "https_proxy"),
    "HTTPS_PROXY",
  );
  if (!httpProxy && !httpsProxy) return undefined;
  const noProxy = environmentChoice(environment, "NO_PROXY", "no_proxy");
  if (noProxy && (noProxy.length > 8_192 || /[\u0000-\u001f\u007f]/u.test(noProxy))) {
    throw new ConfigurationError("NO_PROXY 설정이 올바르지 않습니다.");
  }
  try {
    return new EnvHttpProxyAgent({
      httpProxy: httpProxy ?? "",
      httpsProxy: httpsProxy ?? "",
      noProxy: noProxy ?? "",
    });
  } catch {
    throw new ConfigurationError("모델 transport proxy를 초기화하지 못했습니다.");
  }
}

function assertHeaders(headers: Readonly<Record<string, string>>): void {
  const entries = Object.entries(headers);
  if (entries.length > 64) {
    throw new ConfigurationError("모델 요청 header 수가 너무 많습니다.");
  }
  let totalBytes = 0;
  for (const [name, value] of entries) {
    if (
      typeof value !== "string" ||
      !HEADER_NAME.test(name) ||
      /[\r\n\0]/u.test(value)
    ) {
      throw new ConfigurationError("모델 요청 header 형식이 올바르지 않습니다.");
    }
    totalBytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8");
    if (totalBytes > 64 * 1024) {
      throw new ConfigurationError("모델 요청 header 크기가 너무 큽니다.");
    }
  }
}

function assertEndpoint(url: URL, expectedOrigin: string): void {
  let origin: URL;
  try {
    origin = new URL(expectedOrigin);
  } catch {
    throw new ConfigurationError("모델 endpoint origin이 올바르지 않습니다.");
  }
  if (
    origin.origin !== expectedOrigin ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new ConfigurationError("모델 endpoint origin은 origin만 포함해야 합니다.");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.origin !== expectedOrigin
  ) {
    throw new ConfigurationError("모델 요청 URL이 인증된 endpoint origin과 일치하지 않습니다.");
  }
}

function retryDelay(response: Response, attempt: number, now: () => number): number | undefined {
  if (!RETRYABLE_STATUS.has(response.status)) return undefined;
  if (response.headers.get("x-should-retry")?.trim().toLowerCase() === "false") {
    return undefined;
  }
  const header = response.headers.get("retry-after")?.trim();
  if (header) {
    if (/^\d+(?:\.\d+)?$/u.test(header)) {
      const milliseconds = Number(header) * 1_000;
      return Number.isFinite(milliseconds) && milliseconds <= 5_000
        ? milliseconds
        : undefined;
    }
    const timestamp = Date.parse(header);
    if (!Number.isFinite(timestamp)) return undefined;
    const milliseconds = Math.max(0, timestamp - now());
    return milliseconds <= 5_000 ? milliseconds : undefined;
  }
  return Math.min(2_000, 500 * (2 ** attempt));
}

function consumeRetry(
  budget: RetryBudgetPort,
  attempt: number,
  reason: TransportRetryReason,
  statusCode?: number,
): boolean {
  return budget.tryConsumeRetry({
    owner: "model_transport",
    attempt,
    reason,
    ...(statusCode !== undefined ? { statusCode } : {}),
  });
}

function throwForAbort(
  callerSignal: AbortSignal,
  deadlineSignal: AbortSignal,
): void {
  if (callerSignal.aborted) {
    throw new CancelledError("모델 요청이 취소됐습니다.");
  }
  if (deadlineSignal.aborted) {
    throw new ProviderError("모델 요청 제한 시간이 초과됐습니다.");
  }
}

interface RequestDeadline {
  signal: AbortSignal;
  clear(): void;
}

function createRequestDeadline(timeoutMs: number): RequestDeadline {
  const controller = new AbortController();
  let active = true;
  const timer = setTimeout(() => {
    active = false;
    controller.abort();
  }, timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    clear: () => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
    },
  };
}

async function waitForRetry(
  milliseconds: number,
  signal: AbortSignal,
  callerSignal: AbortSignal,
  deadlineSignal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throwForAbort(callerSignal, deadlineSignal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, milliseconds);
    const aborted = (): void => {
      clearTimeout(timer);
      reject(new Error("retry_wait_aborted"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  }).catch(() => throwForAbort(callerSignal, deadlineSignal));
}

export class ModelHttpResponse {
  readonly #releaseDeadline: () => void;
  #completed = false;

  constructor(
    readonly response: Response,
    readonly signal: AbortSignal,
    readonly callerSignal: AbortSignal,
    readonly deadlineSignal: AbortSignal,
    releaseDeadline: () => void,
  ) {
    this.#releaseDeadline = releaseDeadline;
  }

  get status(): number {
    return this.response.status;
  }

  get ok(): boolean {
    return this.response.ok;
  }

  get headers(): Headers {
    return this.response.headers;
  }

  get body(): ReadableStream | null {
    return this.response.body;
  }

  assertActive(): void {
    try {
      throwForAbort(this.callerSignal, this.deadlineSignal);
    } catch (error) {
      this.complete();
      throw error;
    }
  }

  complete(): void {
    if (this.#completed) return;
    this.#completed = true;
    this.#releaseDeadline();
  }

  async cancel(): Promise<void> {
    try {
      await this.response.body?.cancel().catch(() => undefined);
    } finally {
      this.complete();
    }
  }
}

export class ModelHttpTransport {
  readonly #fetch: typeof undiciFetch;
  readonly #dispatcher: Dispatcher | undefined;
  readonly #ownedDispatcher: Dispatcher | undefined;
  readonly #now: () => number;
  #closed = false;

  constructor(options: ModelHttpTransportOptions = {}) {
    this.#fetch = options.fetchImplementation ?? undiciFetch;
    this.#now = options.now ?? Date.now;
    if (options.dispatcher) {
      this.#dispatcher = options.dispatcher;
      this.#ownedDispatcher = undefined;
    } else {
      const dispatcher = createEnvironmentDispatcher(options.environment ?? process.env);
      this.#dispatcher = dispatcher;
      this.#ownedDispatcher = dispatcher;
    }
  }

  async #fetchWithRedirects(
    request: ModelHttpRequest,
    signal: AbortSignal,
  ): Promise<Response> {
    let url = new URL(request.url.href);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      assertEndpoint(url, request.expectedOrigin);
      const init: RequestInit = {
        method: request.method,
        headers: { ...request.headers },
        redirect: "manual",
        signal,
        ...(request.body !== undefined ? { body: request.body } : {}),
        ...(this.#dispatcher ? { dispatcher: this.#dispatcher } : {}),
      };
      const response = await this.#fetch(url, init);
      if (!REDIRECT_STATUS.has(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      if (
        redirects === MAX_REDIRECTS ||
        (request.method === "POST" && response.status !== 307 && response.status !== 308)
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new ProtocolError("모델 endpoint가 지원하지 않는 redirect를 반환했습니다.");
      }
      let redirected: URL;
      try {
        redirected = new URL(location, url);
      } catch {
        await response.body?.cancel().catch(() => undefined);
        throw new ProtocolError("모델 endpoint redirect가 올바르지 않습니다.");
      }
      if (
        redirected.username !== "" ||
        redirected.password !== "" ||
        redirected.origin !== request.expectedOrigin
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new ProtocolError("인증된 모델 요청을 다른 origin으로 redirect할 수 없습니다.");
      }
      await response.body?.cancel().catch(() => undefined);
      url = redirected;
    }
    throw new ProtocolError("모델 endpoint redirect 한도를 초과했습니다.");
  }

  async request(request: ModelHttpRequest): Promise<ModelHttpResponse> {
    if (this.#closed) throw new ProviderError("종료된 모델 transport를 사용할 수 없습니다.");
    assertEndpoint(request.url, request.expectedOrigin);
    assertHeaders(request.headers);
    const timeoutMs = positiveInteger(request.timeoutMs, "모델 요청 제한 시간", MAX_TIMEOUT_MS);
    const maxRequestBytes = positiveInteger(
      request.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
      "모델 요청 본문 제한",
      MAX_CONFIGURED_BODY_BYTES,
    );
    if (request.method === "GET" && request.body !== undefined) {
      throw new ConfigurationError("GET 모델 요청에는 본문을 사용할 수 없습니다.");
    }
    if (
      request.body !== undefined &&
      Buffer.byteLength(request.body, "utf8") > maxRequestBytes
    ) {
      throw new ConfigurationError("모델 요청 본문이 허용 크기를 초과했습니다.");
    }
    const maximumRetries = retryCount(request.maxRetries);
    if (request.signal.aborted) throw new CancelledError("모델 요청이 취소됐습니다.");
    const deadline = createRequestDeadline(timeoutMs);
    const deadlineSignal = deadline.signal;
    const signal = AbortSignal.any([request.signal, deadlineSignal]);
    let responseOwnsDeadline = false;
    try {
      for (let attempt = 0; ; attempt += 1) {
        let response: Response;
        try {
          response = await this.#fetchWithRedirects(request, signal);
        } catch (error) {
          throwForAbort(request.signal, deadlineSignal);
          if (error instanceof ConfigurationError || error instanceof ProtocolError) throw error;
          const retryAttempt = attempt + 1;
          if (
            attempt >= maximumRetries ||
            isTlsFailure(error) ||
            !consumeRetry(request.retryBudget, retryAttempt, "network_error")
          ) {
            throw new ProviderError("모델 API에 연결하지 못했습니다.");
          }
          const delayMs = Math.min(2_000, 500 * (2 ** attempt));
          request.onRetry?.({
            attempt: retryAttempt,
            delayMs,
            reason: "network_error",
          });
          await waitForRetry(delayMs, signal, request.signal, deadlineSignal);
          continue;
        }

        const delayMs = retryDelay(response, attempt, this.#now);
        if (delayMs === undefined || attempt >= maximumRetries) {
          responseOwnsDeadline = true;
          return new ModelHttpResponse(
            response,
            signal,
            request.signal,
            deadlineSignal,
            deadline.clear,
          );
        }
        const retryAttempt = attempt + 1;
        let retryApproved: boolean;
        try {
          retryApproved = consumeRetry(
            request.retryBudget,
            retryAttempt,
            "http_status",
            response.status,
          );
        } catch (error) {
          await response.body?.cancel().catch(() => undefined);
          throw error;
        }
        if (!retryApproved) {
          responseOwnsDeadline = true;
          return new ModelHttpResponse(
            response,
            signal,
            request.signal,
            deadlineSignal,
            deadline.clear,
          );
        }
        await response.body?.cancel().catch(() => undefined);
        request.onRetry?.({
          attempt: retryAttempt,
          delayMs,
          reason: "http_status",
          statusCode: response.status,
        });
        await waitForRetry(delayMs, signal, request.signal, deadlineSignal);
      }
    } finally {
      if (!responseOwnsDeadline) deadline.clear();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#ownedDispatcher?.close();
  }
}

function assertBodyLimit(maximumBytes: number): number {
  return positiveInteger(maximumBytes, "모델 응답 본문 제한", MAX_CONFIGURED_BODY_BYTES);
}

function contentLength(response: ModelHttpResponse): number | undefined {
  const raw = response.headers.get("content-length")?.trim();
  if (!raw || !/^\d+$/u.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

export async function readResponseBytes(
  source: ModelHttpResponse,
  maximumBytes: number,
): Promise<Uint8Array> {
  const maximum = assertBodyLimit(maximumBytes);
  source.assertActive();
  const declared = contentLength(source);
  if (declared !== undefined && declared > maximum) {
    await source.cancel();
    throw new ProtocolError("모델 응답이 허용 크기를 초과했습니다.");
  }
  const body = source.body;
  if (!body) {
    source.complete();
    return new Uint8Array();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    while (true) {
      source.assertActive();
      const { done, value } = await reader.read();
      source.assertActive();
      if (done) {
        completed = true;
        break;
      }
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maximum) {
        throw new ProtocolError("모델 응답이 허용 크기를 초과했습니다.");
      }
      chunks.push(chunk);
      if (chunks.length > MAX_BODY_CHUNKS) {
        throw new ProtocolError("모델 응답 chunk 수가 허용 한도를 초과했습니다.");
      }
    }
  } catch (error) {
    source.assertActive();
    if (error instanceof ProtocolError || error instanceof ProviderError) throw error;
    throw new ProviderError("모델 응답 본문을 읽지 못했습니다.");
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    source.complete();
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

export async function readResponsePrefix(
  source: ModelHttpResponse,
  maximumBytes: number,
): Promise<Uint8Array> {
  const maximum = assertBodyLimit(maximumBytes);
  source.assertActive();
  const body = source.body;
  if (!body) {
    source.complete();
    return new Uint8Array();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maximum) {
      source.assertActive();
      const { done, value } = await reader.read();
      source.assertActive();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      const retained = chunk.subarray(0, maximum - total);
      chunks.push(retained);
      if (chunks.length > MAX_BODY_CHUNKS) {
        throw new ProtocolError("모델 오류 응답 chunk 수가 허용 한도를 초과했습니다.");
      }
      total += retained.byteLength;
      if (retained.byteLength < chunk.byteLength) break;
    }
  } catch (error) {
    source.assertActive();
    if (error instanceof ProtocolError || error instanceof ProviderError) throw error;
    throw new ProviderError("모델 오류 응답을 읽지 못했습니다.");
  } finally {
    await reader.cancel().catch(() => undefined);
    source.complete();
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

export async function readResponseText(
  source: ModelHttpResponse,
  maximumBytes: number,
): Promise<string> {
  const bytes = await readResponseBytes(source, maximumBytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProtocolError("모델 응답이 UTF-8 형식이 아닙니다.");
  }
}

export async function readResponseJson(
  source: ModelHttpResponse,
  maximumBytes: number,
): Promise<unknown> {
  const text = await readResponseText(source, maximumBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProtocolError("모델 API가 올바른 JSON을 반환하지 않았습니다.");
  }
}

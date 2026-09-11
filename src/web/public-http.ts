import { lookup as lookupHost } from "node:dns/promises";
import type {
  LookupAddress,
  LookupOptions,
} from "node:dns";
import { BlockList, isIP } from "node:net";
import {
  checkServerIdentity as verifyServerIdentity,
  type TLSSocket,
} from "node:tls";
import {
  Agent,
  buildConnector,
  errors as undiciErrors,
  fetch as undiciFetch,
  type Response,
} from "undici";
import {
  CancelledError,
  CatError,
} from "../core/errors.js";

export const PUBLIC_WEB_MAX_BODY_BYTES = 1024 * 1024;
export const PUBLIC_WEB_TIMEOUT_MS = 20_000;

const MAX_URL_BYTES = 4_096;
const MAX_HOST_BYTES = 253;
const MAX_DNS_ADDRESSES = 32;
const MAX_REDIRECTS = 5;
const MAX_BODY_CHUNKS = 16_384;
const MAX_HEADER_BYTES = 32 * 1024;
const CONNECT_TIMEOUT_MS = 10_000;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const DIRECT_PROXY_ENVIRONMENT = [
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "GLOBAL_AGENT_HTTPS_PROXY",
  "GLOBAL_AGENT_HTTP_PROXY",
  "npm_config_https_proxy",
  "npm_config_proxy",
] as const;
const RESERVED_HOST_SUFFIXES = [
  ".home.arpa",
  ".internal",
  ".invalid",
  ".local",
  ".localhost",
  ".onion",
  ".test",
] as const;

const NON_PUBLIC_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

export type PublicWebFailureReason =
  | "invalid_url"
  | "blocked_destination"
  | "dns_failure"
  | "proxy_unsupported"
  | "network_failure"
  | "timeout"
  | "response_too_large"
  | "redirect_failure"
  | "cleanup_failure"
  | "closed";

export class PublicWebError extends CatError {
  override name = "PublicWebError";

  constructor(
    readonly reason: PublicWebFailureReason,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super("tool_failure", message, options);
  }
}

export interface PublicDnsAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type PublicDnsResolver = (
  hostname: string,
) => Promise<readonly PublicDnsAddress[]>;

export interface PublicWebResponse {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly contentEncoding: string;
  readonly body: Uint8Array;
  readonly truncated: boolean;
  readonly redirectCount: number;
}

export interface PublicWebTransportOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly resolver?: PublicDnsResolver;
}

interface Deadline {
  readonly signal: AbortSignal;
  readonly expiresAt: number;
  clear(): void;
}

interface ResolvedDestination {
  readonly hostname: string;
  readonly addresses: readonly PublicDnsAddress[];
}

interface BodyPrefix {
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
}

type HopResult =
  | { readonly kind: "redirect"; readonly url: URL }
  | {
      readonly kind: "response";
      readonly status: number;
      readonly contentType: string;
      readonly contentEncoding: string;
      readonly body: Uint8Array;
      readonly truncated: boolean;
    };

function proxyConfigured(environment: NodeJS.ProcessEnv): boolean {
  return DIRECT_PROXY_ENVIRONMENT.some((name) => Boolean(environment[name]?.trim()));
}

function canonicalHostname(value: string): string {
  return value.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
}

function reservedHostname(hostname: string): boolean {
  return hostname === "localhost" ||
    hostname === "metadata.google.internal" ||
    hostname === "instance-data.ec2.internal" ||
    RESERVED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !NON_PUBLIC_ADDRESSES.check(address, "ipv4");
  if (family === 6) return !NON_PUBLIC_ADDRESSES.check(address, "ipv6");
  return false;
}

function urlFailure(message: string, cause?: unknown): PublicWebError {
  return new PublicWebError(
    "invalid_url",
    message,
    false,
    cause === undefined ? undefined : { cause },
  );
}

export function normalizePublicWebUrl(value: string | URL): URL {
  const raw = value instanceof URL ? value.href : value.trim();
  if (
    !raw ||
    Buffer.byteLength(raw, "utf8") > MAX_URL_BYTES ||
    /[\\\p{Cc}\p{Cf}]/u.test(raw)
  ) {
    throw urlFailure("공개 웹 URL의 형식 또는 크기가 올바르지 않습니다.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw urlFailure("올바른 HTTP(S) 공개 URL이 아닙니다.", error);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw urlFailure("사용자 정보가 없는 HTTP(S) 공개 URL만 열 수 있습니다.");
  }
  const hostname = canonicalHostname(url.hostname);
  if (
    !hostname ||
    Buffer.byteLength(hostname, "utf8") > MAX_HOST_BYTES ||
    reservedHostname(hostname)
  ) {
    throw new PublicWebError(
      "blocked_destination",
      "로컬·예약·내부 hostname은 공개 웹 도구로 열 수 없습니다.",
    );
  }
  if (isIP(hostname) !== 0 && !isPublicIpAddress(hostname)) {
    throw new PublicWebError(
      "blocked_destination",
      "비공개 또는 특수 목적 IP 주소는 공개 웹 도구로 열 수 없습니다.",
    );
  }
  url.hash = "";
  return url;
}

async function defaultResolver(hostname: string): Promise<readonly PublicDnsAddress[]> {
  const family = isIP(hostname);
  if (family === 4 || family === 6) {
    return [{ address: hostname, family }];
  }
  const addresses = await lookupHost(hostname, { all: true, verbatim: true });
  return addresses.flatMap((item) =>
    item.family === 4 || item.family === 6
      ? [{ address: item.address, family: item.family }]
      : []
  );
}

function createDeadline(milliseconds: number): Deadline {
  const controller = new AbortController();
  const expiresAt = Date.now() + milliseconds;
  const timer = setTimeout(() => controller.abort(), milliseconds);
  timer.unref();
  let active = true;
  return {
    signal: controller.signal,
    expiresAt,
    clear: () => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
    },
  };
}

function abortFailure(
  callerSignal: AbortSignal,
  deadlineSignal: AbortSignal,
  closeSignal: AbortSignal,
): Error {
  if (callerSignal.aborted) return new CancelledError("공개 웹 요청이 취소됐습니다.");
  if (deadlineSignal.aborted) {
    return new PublicWebError("timeout", "공개 웹 요청 제한 시간이 초과됐습니다.", true);
  }
  if (closeSignal.aborted) return new CancelledError("공개 웹 transport가 종료됐습니다.");
  return new PublicWebError("network_failure", "공개 웹 요청이 중단됐습니다.", true);
}

async function awaitWithSignal<T>(
  source: Promise<T>,
  signal: AbortSignal,
  aborted: () => Error,
): Promise<T> {
  if (signal.aborted) throw aborted();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (value: { readonly result: T } | { readonly error: unknown }): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if ("error" in value) reject(value.error);
      else resolve(value.result);
    };
    const onAbort = (): void => finish({ error: aborted() });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void source.then(
      (result) => finish({ result }),
      (error: unknown) => finish({ error }),
    );
  });
}

async function resolveDestination(
  url: URL,
  resolver: PublicDnsResolver,
  signal: AbortSignal,
  aborted: () => Error,
): Promise<ResolvedDestination> {
  const hostname = canonicalHostname(url.hostname);
  let resolved: readonly PublicDnsAddress[];
  try {
    resolved = await awaitWithSignal(resolver(hostname), signal, aborted);
  } catch (error) {
    if (error instanceof CancelledError || error instanceof PublicWebError) throw error;
    throw new PublicWebError(
      "dns_failure",
      "공개 웹 hostname의 주소를 확인하지 못했습니다.",
      true,
      { cause: error },
    );
  }
  if (resolved.length === 0 || resolved.length > MAX_DNS_ADDRESSES) {
    throw new PublicWebError(
      "dns_failure",
      "공개 웹 hostname의 DNS 결과 수가 허용 범위를 벗어났습니다.",
      true,
    );
  }
  const unique = new Map<string, PublicDnsAddress>();
  for (const item of resolved) {
    const actualFamily = isIP(item.address);
    if (
      (item.family !== 4 && item.family !== 6) ||
      actualFamily !== item.family ||
      !isPublicIpAddress(item.address)
    ) {
      throw new PublicWebError(
        "blocked_destination",
        "DNS 결과에 비공개 또는 특수 목적 주소가 포함되어 요청을 차단했습니다.",
      );
    }
    unique.set(`${item.family}:${item.address}`, {
      address: item.address,
      family: item.family,
    });
  }
  return {
    hostname,
    addresses: Object.freeze([...unique.values()].map((item) => Object.freeze(item))),
  };
}

function lookupError(): NodeJS.ErrnoException {
  const error = new Error("고정한 공개 DNS 주소를 사용할 수 없습니다.") as NodeJS.ErrnoException;
  error.code = "ENOTFOUND";
  return error;
}

type PinnedLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => void;

function createPinnedLookup(destination: ResolvedDestination): PinnedLookup {
  return (hostname, options, callback) => {
    if (canonicalHostname(hostname) !== destination.hostname) {
      callback(lookupError(), options.all ? [] : "", 0);
      return;
    }
    const requestedFamily = options.family === "IPv4"
      ? 4
      : options.family === "IPv6"
        ? 6
        : options.family;
    const matches = destination.addresses.filter((item) =>
      requestedFamily !== 4 && requestedFamily !== 6 || item.family === requestedFamily
    );
    if (matches.length === 0) {
      callback(lookupError(), options.all ? [] : "", 0);
      return;
    }
    if (options.all) {
      callback(null, matches.map((item) => ({ ...item })));
      return;
    }
    const selected = matches[0];
    if (!selected) {
      callback(lookupError(), "", 0);
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

function mappedIpv4(address: string): string | undefined {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address);
  if (!match?.[1] || isIP(match[1]) !== 4) return undefined;
  return match[1];
}

function createPinnedDispatcher(
  destination: ResolvedDestination,
  timeoutMs: number,
): Agent {
  const allowedIpv4 = new BlockList();
  const allowedIpv6 = new BlockList();
  for (const item of destination.addresses) {
    if (item.family === 4) allowedIpv4.addAddress(item.address, "ipv4");
    else allowedIpv6.addAddress(item.address, "ipv6");
  }
  const baseConnector = buildConnector({
    lookup: createPinnedLookup(destination),
    timeout: Math.min(timeoutMs, CONNECT_TIMEOUT_MS),
    maxCachedSessions: 0,
    allowH2: false,
    rejectUnauthorized: true,
  });
  const connect: ReturnType<typeof buildConnector> = (options, callback) => {
    baseConnector(options, (error, socket) => {
      if (error || !socket) {
        callback(error ?? new Error("공개 웹 socket을 만들지 못했습니다."), null);
        return;
      }
      const remoteAddress = socket.remoteAddress;
      const mapped = remoteAddress ? mappedIpv4(remoteAddress) : undefined;
      const family = remoteAddress ? isIP(remoteAddress) : 0;
      const allowed = mapped
        ? isPublicIpAddress(mapped) && allowedIpv4.check(mapped, "ipv4")
        : family === 4
          ? isPublicIpAddress(remoteAddress ?? "") && allowedIpv4.check(remoteAddress ?? "", "ipv4")
          : family === 6
            ? isPublicIpAddress(remoteAddress ?? "") && allowedIpv6.check(remoteAddress ?? "", "ipv6")
            : false;
      if (!allowed) {
        socket.destroy();
        callback(new Error("실제 연결 주소가 검증한 공개 DNS 주소와 일치하지 않습니다."), null);
        return;
      }
      if (options.protocol === "https:") {
        let identityError: Error | undefined;
        try {
          const certificate = (socket as TLSSocket).getPeerCertificate(true);
          identityError = verifyServerIdentity(destination.hostname, certificate);
        } catch (error) {
          identityError = error instanceof Error
            ? error
            : new Error("공개 HTTPS 인증서 이름을 검증하지 못했습니다.");
        }
        if (identityError !== undefined) {
          socket.destroy();
          callback(identityError, null);
          return;
        }
      }
      callback(null, socket);
    });
  };
  return new Agent({
    connect,
    connections: 1,
    pipelining: 1,
    maxOrigins: 1,
    maxHeaderSize: MAX_HEADER_BYTES,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connectTimeout: Math.min(timeoutMs, CONNECT_TIMEOUT_MS),
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
    maxCachedSessions: 0,
    maxResponseSize: PUBLIC_WEB_MAX_BODY_BYTES,
    allowH2: false,
    autoSelectFamily: false,
  });
}

function declaredLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length")?.trim();
  if (!raw || !/^\d+$/u.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

function boundedHeader(value: string | null): string {
  if (!value) return "";
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, "�");
  const bytes = Buffer.from(cleaned, "utf8");
  if (bytes.byteLength <= 1_024) return cleaned;
  let end = 1_024;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

async function readBodyPrefix(
  response: Response,
  signal: AbortSignal,
  aborted: () => Error,
): Promise<BodyPrefix> {
  const declared = declaredLength(response);
  if (declared !== undefined && declared > PUBLIC_WEB_MAX_BODY_BYTES) {
    throw new PublicWebError(
      "response_too_large",
      `공개 웹 응답이 ${PUBLIC_WEB_MAX_BODY_BYTES} bytes 제한을 초과했습니다.`,
    );
  }
  const body = response.body;
  if (!body) return { bytes: new Uint8Array(), truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  let completed = false;
  try {
    while (true) {
      if (signal.aborted) throw aborted();
      const { done, value } = await awaitWithSignal(
        reader.read(),
        signal,
        aborted,
      );
      if (signal.aborted) throw aborted();
      if (done) {
        completed = true;
        break;
      }
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      const remaining = PUBLIC_WEB_MAX_BODY_BYTES - total;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        total += remaining;
        truncated = true;
        break;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
      if (chunks.length > MAX_BODY_CHUNKS) {
        throw new PublicWebError(
          "response_too_large",
          "공개 웹 응답 chunk 수가 허용 범위를 초과했습니다.",
        );
      }
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: joined, truncated };
}

function responseTooLarge(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  if (error instanceof undiciErrors.ResponseExceededMaxSizeError) return true;
  const record = error as { readonly cause?: unknown; readonly code?: unknown };
  return record.code === "UND_ERR_RES_EXCEEDED_MAX_SIZE" ||
    (record.cause !== undefined && record.cause !== error && responseTooLarge(record.cause, depth + 1));
}

function remainingTime(expiresAt: number): number {
  const remaining = expiresAt - Date.now();
  if (remaining < 1) {
    throw new PublicWebError("timeout", "공개 웹 요청 제한 시간이 초과됐습니다.", true);
  }
  return Math.min(PUBLIC_WEB_TIMEOUT_MS, remaining);
}

async function fetchHop(
  url: URL,
  resolver: PublicDnsResolver,
  signal: AbortSignal,
  expiresAt: number,
  aborted: () => Error,
): Promise<HopResult> {
  const destination = await resolveDestination(url, resolver, signal, aborted);
  const dispatcher = createPinnedDispatcher(destination, remainingTime(expiresAt));
  let response: Response | undefined;
  try {
    response = await undiciFetch(url, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/json,text/plain,application/xml;q=0.9,*/*;q=0.1",
        "Accept-Language": "en-US,en;q=0.8,ko;q=0.7",
        "User-Agent": "cat/0.1 public-web",
      },
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      referrerPolicy: "no-referrer",
      signal,
      dispatcher,
    });
    if (REDIRECT_STATUS.has(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw new PublicWebError(
          "redirect_failure",
          "공개 웹 redirect에 Location header가 없습니다.",
        );
      }
      let redirected: URL;
      try {
        redirected = normalizePublicWebUrl(new URL(location, url));
      } catch (error) {
        if (error instanceof PublicWebError) throw error;
        throw new PublicWebError(
          "redirect_failure",
          "공개 웹 redirect URL이 올바르지 않습니다.",
          false,
          { cause: error },
        );
      }
      return { kind: "redirect", url: redirected };
    }
    const body = await readBodyPrefix(response, signal, aborted);
    return {
      kind: "response",
      status: response.status,
      contentType: boundedHeader(response.headers.get("content-type")),
      contentEncoding: boundedHeader(response.headers.get("content-encoding")),
      body: body.bytes,
      truncated: body.truncated,
    };
  } catch (error) {
    if (signal.aborted) throw aborted();
    if (error instanceof CancelledError || error instanceof PublicWebError) throw error;
    if (responseTooLarge(error)) {
      throw new PublicWebError(
        "response_too_large",
        `공개 웹 응답이 ${PUBLIC_WEB_MAX_BODY_BYTES} bytes 제한을 초과했습니다.`,
        false,
        { cause: error },
      );
    }
    throw new PublicWebError(
      "network_failure",
      "공개 웹 서버에 연결하거나 응답을 읽지 못했습니다.",
      true,
      { cause: error },
    );
  } finally {
    await response?.body?.cancel().catch(() => undefined);
    await dispatcher.destroy().catch(() => undefined);
  }
}

export class PublicWebTransport {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #resolver: PublicDnsResolver;
  readonly #controllers = new Set<AbortController>();
  readonly #active = new Set<Promise<PublicWebResponse>>();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: PublicWebTransportOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#resolver = options.resolver ?? defaultResolver;
  }

  async get(value: string | URL, callerSignal: AbortSignal): Promise<PublicWebResponse> {
    if (this.#closed) {
      throw new PublicWebError("closed", "종료된 공개 웹 transport를 사용할 수 없습니다.");
    }
    if (callerSignal.aborted) throw new CancelledError("공개 웹 요청이 취소됐습니다.");
    if (this.#active.size >= 4) {
      throw new PublicWebError("network_failure", "동시에 실행할 수 있는 공개 웹 요청 수를 초과했습니다.");
    }
    const operationController = new AbortController();
    this.#controllers.add(operationController);
    const operation = this.#perform(value, callerSignal, operationController.signal);
    this.#active.add(operation);
    try {
      return await operation;
    } finally {
      this.#active.delete(operation);
      this.#controllers.delete(operationController);
    }
  }

  async #perform(
    value: string | URL,
    callerSignal: AbortSignal,
    closeSignal: AbortSignal,
  ): Promise<PublicWebResponse> {
    if (proxyConfigured(this.#environment)) {
      throw new PublicWebError(
        "proxy_unsupported",
        "공개 destination 검증을 보장할 수 없는 proxy 환경에서는 웹 요청을 실행하지 않습니다.",
      );
    }
    const requested = normalizePublicWebUrl(value);
    const deadline = createDeadline(PUBLIC_WEB_TIMEOUT_MS);
    const signal = AbortSignal.any([callerSignal, closeSignal, deadline.signal]);
    const aborted = (): Error => abortFailure(callerSignal, deadline.signal, closeSignal);
    let current = requested;
    try {
      for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
        if (signal.aborted) throw aborted();
        const hop = await fetchHop(
          current,
          this.#resolver,
          signal,
          deadline.expiresAt,
          aborted,
        );
        if (hop.kind === "redirect") {
          if (redirectCount === MAX_REDIRECTS) {
            throw new PublicWebError(
              "redirect_failure",
              `공개 웹 redirect가 ${MAX_REDIRECTS}회 제한을 초과했습니다.`,
            );
          }
          current = hop.url;
          continue;
        }
        return {
          requestedUrl: requested.href,
          finalUrl: current.href,
          status: hop.status,
          contentType: hop.contentType,
          contentEncoding: hop.contentEncoding,
          body: hop.body,
          truncated: hop.truncated,
          redirectCount,
        };
      }
      throw new PublicWebError("redirect_failure", "공개 웹 redirect 제한을 초과했습니다.");
    } finally {
      deadline.clear();
    }
  }

  async close(): Promise<void> {
    if (this.#closePromise) return await this.#closePromise;
    if (this.#closed && this.#active.size === 0) return;
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    const closing = Promise.allSettled([...this.#active]).then(() => undefined);
    this.#closePromise = closing;
    try {
      await closing;
    } finally {
      if (this.#closePromise === closing) this.#closePromise = undefined;
    }
  }
}

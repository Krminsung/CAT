import {
  CancelledError,
  ConfigurationError,
  ProviderError,
  ProtocolError,
} from "../core/errors.js";
import type { ModelHttpResponse } from "./model-http.js";

const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_EVENTS = 100_000;
const DEFAULT_MAX_LINES = 200_000;
const MAX_STREAM_LIMIT = 64 * 1024 * 1024;

export interface ServerSentEvent {
  data: string;
  event?: string;
  id?: string;
  retry?: number;
}

export interface ServerSentEventLimits {
  maxTotalBytes?: number;
  maxEventBytes?: number;
  maxLineBytes?: number;
  maxEvents?: number;
  maxLines?: number;
}

interface ParsedLine {
  line: string;
  rest: string;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  label: string,
  maximum: number,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new ConfigurationError(`${label} 제한이 올바르지 않습니다.`);
  }
  return selected;
}

function takeLine(
  input: string,
  endOfStream: boolean,
  startIndex = 0,
): ParsedLine | undefined {
  for (let index = startIndex; index < input.length; index += 1) {
    const character = input[index];
    if (character === "\n") {
      return { line: input.slice(0, index), rest: input.slice(index + 1) };
    }
    if (character !== "\r") continue;
    if (index + 1 === input.length && !endOfStream) return undefined;
    const delimiterLength = input[index + 1] === "\n" ? 2 : 1;
    return {
      line: input.slice(0, index),
      rest: input.slice(index + delimiterLength),
    };
  }
  if (endOfStream && input.length > 0) return { line: input, rest: "" };
  return undefined;
}

export async function* readServerSentEvents(
  source: ModelHttpResponse,
  limits: ServerSentEventLimits = {},
): AsyncGenerator<ServerSentEvent> {
  const maxTotalBytes = boundedInteger(
    limits.maxTotalBytes,
    DEFAULT_MAX_TOTAL_BYTES,
    "SSE 전체 byte",
    MAX_STREAM_LIMIT,
  );
  const maxEventBytes = boundedInteger(
    limits.maxEventBytes,
    Math.min(DEFAULT_MAX_EVENT_BYTES, maxTotalBytes),
    "SSE event byte",
    maxTotalBytes,
  );
  const maxLineBytes = boundedInteger(
    limits.maxLineBytes,
    Math.min(DEFAULT_MAX_LINE_BYTES, maxEventBytes),
    "SSE line byte",
    maxEventBytes,
  );
  const maxEvents = boundedInteger(
    limits.maxEvents,
    DEFAULT_MAX_EVENTS,
    "SSE event 수",
    DEFAULT_MAX_EVENTS,
  );
  const maxLines = boundedInteger(
    limits.maxLines,
    DEFAULT_MAX_LINES,
    "SSE line 수",
    DEFAULT_MAX_LINES,
  );
  const contentType = source.headers.get("content-type")?.toLowerCase();
  source.assertActive();
  if (contentType && !contentType.startsWith("text/event-stream")) {
    await source.cancel();
    throw new ProtocolError("모델 streaming 응답의 content-type이 SSE가 아닙니다.");
  }
  const body = source.body;
  if (!body) throw new ProtocolError("모델 streaming 응답 본문이 없습니다.");

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let totalBytes = 0;
  let eventBytes = 0;
  let lineCount = 0;
  let eventCount = 0;
  let eventType = "";
  let eventId: string | undefined;
  let retry: number | undefined;
  let dataLines: string[] = [];
  let atStreamStart = true;

  const dispatchEvent = (): ServerSentEvent | undefined => {
    const hasData = dataLines.length > 0;
    const event: ServerSentEvent | undefined = hasData
      ? {
          data: dataLines.join("\n"),
          ...(eventType ? { event: eventType } : {}),
          ...(eventId !== undefined ? { id: eventId } : {}),
          ...(retry !== undefined ? { retry } : {}),
        }
      : undefined;
    dataLines = [];
    eventType = "";
    retry = undefined;
    eventBytes = 0;
    return event;
  };

  const consumeLine = (line: string): ServerSentEvent | undefined => {
    lineCount += 1;
    if (lineCount > maxLines) {
      throw new ProtocolError("모델 SSE line 수가 허용 한도를 초과했습니다.");
    }
    if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
      throw new ProtocolError("모델 SSE line이 허용 크기를 초과했습니다.");
    }
    eventBytes += Buffer.byteLength(line, "utf8") + 1;
    if (eventBytes > maxEventBytes) {
      throw new ProtocolError("모델 SSE event가 허용 크기를 초과했습니다.");
    }
    if (line === "") return dispatchEvent();
    if (line.startsWith(":")) return undefined;

    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      dataLines.push(value);
    } else if (field === "event") {
      eventType = value;
    } else if (field === "id" && !value.includes("\0")) {
      eventId = value;
    } else if (field === "retry" && /^\d+$/u.test(value)) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed) && parsed <= 300_000) retry = parsed;
    }
    return undefined;
  };

  const publish = (event: ServerSentEvent | undefined): ServerSentEvent | undefined => {
    if (!event) return undefined;
    eventCount += 1;
    if (eventCount > maxEvents) {
      throw new ProtocolError("모델 SSE event 수가 허용 한도를 초과했습니다.");
    }
    return event;
  };

  let completed = false;
  try {
    while (true) {
      source.assertActive();
      const { done, value } = await reader.read();
      source.assertActive();
      if (done) {
        completed = true;
        pending += decoder.decode();
        break;
      }
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += chunk.byteLength;
      if (totalBytes > maxTotalBytes) {
        throw new ProtocolError("모델 SSE 응답이 전체 크기 한도를 초과했습니다.");
      }
      let decoded = decoder.decode(chunk, { stream: true });
      if (atStreamStart && decoded.length > 0) {
        if (decoded.startsWith("\uFEFF")) decoded = decoded.slice(1);
        atStreamStart = false;
      }
      const previousLength = pending.length;
      pending += decoded;
      let searchIndex = Math.max(0, previousLength - 1);
      while (true) {
        const parsed = takeLine(pending, false, searchIndex);
        if (!parsed) break;
        pending = parsed.rest;
        searchIndex = 0;
        const event = publish(consumeLine(parsed.line));
        if (event) yield event;
      }
      if (pending.length > maxLineBytes) {
        throw new ProtocolError("모델 SSE line이 허용 크기를 초과했습니다.");
      }
    }

    while (true) {
      const parsed = takeLine(pending, true);
      if (!parsed) break;
      pending = parsed.rest;
      const event = publish(consumeLine(parsed.line));
      if (event) yield event;
    }
    const finalEvent = publish(dispatchEvent());
    if (finalEvent) yield finalEvent;
  } catch (error) {
    source.assertActive();
    if (
      error instanceof CancelledError ||
      error instanceof ProviderError ||
      error instanceof ProtocolError
    ) {
      throw error;
    }
    throw new ProtocolError("모델 SSE 응답을 해석하지 못했습니다.");
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

import { ConfigurationError } from "../core/errors.js";
import type { AgentEvent } from "../core/events.js";
import type { RunIdentity, RunTermination } from "../core/execution.js";

type EventEnvelopeKey = "runId" | "sequence" | "occurredAt";

type WithoutEventEnvelope<Event> = Event extends AgentEvent
  ? Omit<Event, EventEnvelopeKey>
  : never;

export type AgentEventPayload = WithoutEventEnvelope<AgentEvent>;

export type AgentEventSink = (event: AgentEvent) => void;

export interface AgentEventWriter {
  emit(payload: Exclude<AgentEventPayload, { type: "run_start" | "run_end" }>): AgentEvent;
}

export class AgentEventJournal implements AgentEventWriter {
  readonly identity: RunIdentity;
  readonly #sink: AgentEventSink | undefined;
  readonly #now: () => number;
  readonly #events: AgentEvent[] = [];
  #sequence = 0;
  #started = false;
  #ended = false;
  #deliveryFailed = false;

  constructor(
    identity: RunIdentity,
    sink?: AgentEventSink,
    now: () => number = Date.now,
  ) {
    this.identity = Object.freeze({ ...identity });
    this.#sink = sink;
    this.#now = now;
  }

  get ended(): boolean {
    return this.#ended;
  }

  get deliveryFailed(): boolean {
    return this.#deliveryFailed;
  }

  start(): AgentEvent {
    if (this.#started) throw new Error("run_start 이벤트를 중복 생성할 수 없습니다.");
    this.#started = true;
    return this.#append({
      type: "run_start",
      sessionId: this.identity.sessionId,
    });
  }

  emit(
    payload: Exclude<AgentEventPayload, { type: "run_start" | "run_end" }>,
  ): AgentEvent {
    if (!this.#started) throw new Error("run_start 전에 agent 이벤트를 생성할 수 없습니다.");
    if (this.#ended) throw new Error("run_end 뒤에 agent 이벤트를 생성할 수 없습니다.");
    return this.#append(payload);
  }

  end(termination: RunTermination, message?: string): boolean {
    if (this.#ended) return false;
    if (!this.#started) this.start();
    this.#ended = true;
    this.#append({
      type: "run_end",
      termination,
      ...(message === undefined ? {} : { message }),
    });
    return true;
  }

  events(): readonly AgentEvent[] {
    return Object.freeze([...this.#events]);
  }

  #append(payload: AgentEventPayload): AgentEvent {
    const occurredAt = this.#now();
    if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) {
      throw new ConfigurationError("agent 이벤트 시간이 올바르지 않습니다.");
    }
    this.#sequence += 1;
    const event = Object.freeze({
      ...payload,
      runId: this.identity.runId,
      sequence: this.#sequence,
      occurredAt,
    }) as AgentEvent;
    this.#events.push(event);
    try {
      this.#sink?.(event);
    } catch {
      this.#deliveryFailed = true;
    }
    return event;
  }
}

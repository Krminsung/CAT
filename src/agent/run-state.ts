import { ConfigurationError } from "../core/errors.js";
import type {
  RunIdentity,
  RunTermination,
} from "../core/execution.js";

export type AgentRunState =
  | "PREPARE"
  | "MODEL"
  | "NORMALIZE"
  | "AUTHORIZE_TOOLS"
  | "FINISH";

type ActiveRunState = Exclude<AgentRunState, "FINISH">;
type TransitionState = Exclude<AgentRunState, "PREPARE" | "FINISH">;

const ALLOWED_TRANSITIONS: Readonly<
  Record<ActiveRunState, readonly TransitionState[]>
> = Object.freeze({
  PREPARE: Object.freeze(["MODEL"] as const),
  MODEL: Object.freeze(["NORMALIZE"] as const),
  NORMALIZE: Object.freeze(["AUTHORIZE_TOOLS"] as const),
  AUTHORIZE_TOOLS: Object.freeze(["MODEL"] as const),
});

function assertIdentity(identity: RunIdentity): void {
  for (const [name, value] of Object.entries(identity)) {
    if (
      !value ||
      value.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new ConfigurationError(`${name} 값이 올바르지 않습니다.`);
    }
  }
}

export class RunStateMachine {
  #state: AgentRunState = "PREPARE";
  #termination: RunTermination | undefined;

  get state(): AgentRunState {
    return this.#state;
  }

  get termination(): RunTermination | undefined {
    return this.#termination;
  }

  transition(next: TransitionState): void {
    if (this.#state === "FINISH") {
      throw new Error("종료된 실행의 상태를 변경할 수 없습니다.");
    }
    if (!ALLOWED_TRANSITIONS[this.#state].includes(next)) {
      throw new Error(
        `허용되지 않은 실행 상태 전이입니다: ${this.#state} → ${next}`,
      );
    }
    this.#state = next;
  }

  finish(termination: RunTermination): boolean {
    if (this.#state === "FINISH") return false;
    this.#state = "FINISH";
    this.#termination = termination;
    return true;
  }
}

interface ActiveRun {
  readonly runId: string;
  readonly token: symbol;
}

export class RunOwnershipLease {
  readonly identity: RunIdentity;
  readonly #releaseOwned: () => boolean;
  #released = false;

  constructor(identity: RunIdentity, releaseOwned: () => boolean) {
    this.identity = Object.freeze({ ...identity });
    this.#releaseOwned = releaseOwned;
  }

  get released(): boolean {
    return this.#released;
  }

  release(): boolean {
    if (this.#released) return false;
    this.#released = true;
    return this.#releaseOwned();
  }
}

export type RunOwnershipResult =
  | { readonly acquired: true; readonly lease: RunOwnershipLease }
  | {
      readonly acquired: false;
      readonly activeRunId: string;
      readonly termination: "concurrent_run";
    };

export class SessionRunCoordinator {
  readonly #active = new Map<string, ActiveRun>();
  readonly #activeRunIds = new Set<string>();

  acquire(identity: RunIdentity): RunOwnershipResult {
    assertIdentity(identity);
    const existing = this.#active.get(identity.sessionId);
    if (existing || this.#activeRunIds.has(identity.runId)) {
      return Object.freeze({
        acquired: false,
        activeRunId: existing?.runId ?? identity.runId,
        termination: "concurrent_run",
      });
    }

    const token = Symbol(identity.runId);
    this.#active.set(identity.sessionId, { runId: identity.runId, token });
    this.#activeRunIds.add(identity.runId);
    const lease = new RunOwnershipLease(identity, () => {
      const current = this.#active.get(identity.sessionId);
      if (!current || current.token !== token) return false;
      this.#active.delete(identity.sessionId);
      this.#activeRunIds.delete(identity.runId);
      return true;
    });
    return Object.freeze({ acquired: true, lease });
  }

  activeRunId(sessionId: string): string | undefined {
    return this.#active.get(sessionId)?.runId;
  }
}

export const sharedSessionRunCoordinator = new SessionRunCoordinator();

import { ConfigurationError } from "../core/errors.js";
import type {
  RetryBudgetPort,
  TransportRetryRequest,
} from "../core/execution.js";

export class FixedRetryBudget implements RetryBudgetPort {
  #remaining: number;

  constructor(maximumRetries: number) {
    if (
      !Number.isSafeInteger(maximumRetries) ||
      maximumRetries < 0 ||
      maximumRetries > 100
    ) {
      throw new ConfigurationError("재시도 예산은 0–100 범위의 정수여야 합니다.");
    }
    this.#remaining = maximumRetries;
  }

  get remaining(): number {
    return this.#remaining;
  }

  tryConsumeRetry(_request: TransportRetryRequest): boolean {
    if (this.#remaining === 0) return false;
    this.#remaining -= 1;
    return true;
  }
}

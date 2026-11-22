const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 5_000;
const DEFAULT_MAX_DELAY_MS = 15 * 60_000;
const DEFAULT_MAX_RATE_LIMIT_DELAY_MS = 60 * 60_000;

export type ReportingFailureKind =
  | "busy"
  | "transient"
  | "rate_limited"
  | "abuse_signal"
  | "authentication"
  | "validation"
  | "unknown";

export interface ReportingRetryPolicyOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly maxRateLimitDelayMs?: number;
  readonly random?: () => number;
}

export interface ReportingRetryInput {
  readonly failureKind: ReportingFailureKind;
  readonly attempt: number;
  readonly occurredAt: string;
  readonly retryAfterMs?: number;
}

export type ReportingRetryDecision =
  | {
      readonly action: "retry";
      readonly reason: "busy" | "transient" | "rate_limited";
      readonly delayMs: number;
      readonly scheduledAt: string;
    }
  | {
      readonly action: "dead_letter";
      readonly reason: "attempts_exhausted" | "non_retryable" | "missing_retry_after";
    };

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return resolved;
}

function instant(value: string): number {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error("occurredAt must be an ISO instant");
  }
  return milliseconds;
}

function boundedRetryAfter(value: number | undefined, maximum: number): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("retryAfterMs must be a positive safe integer");
  }
  return Math.min(value, maximum);
}

export class ReportingRetryPolicy {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxRateLimitDelayMs: number;
  private readonly random: () => number;

  constructor(options: ReportingRetryPolicyOptions = {}) {
    this.maxAttempts = positiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, "maxAttempts");
    this.baseDelayMs = positiveInteger(options.baseDelayMs, DEFAULT_BASE_DELAY_MS, "baseDelayMs");
    this.maxDelayMs = positiveInteger(options.maxDelayMs, DEFAULT_MAX_DELAY_MS, "maxDelayMs");
    this.maxRateLimitDelayMs = positiveInteger(
      options.maxRateLimitDelayMs,
      DEFAULT_MAX_RATE_LIMIT_DELAY_MS,
      "maxRateLimitDelayMs",
    );
    if (this.baseDelayMs > this.maxDelayMs) {
      throw new Error("baseDelayMs cannot exceed maxDelayMs");
    }
    this.random = options.random ?? Math.random;
  }

  decide(input: ReportingRetryInput): ReportingRetryDecision {
    if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
      throw new Error("attempt must be a positive safe integer");
    }
    const occurredAt = instant(input.occurredAt);
    if (input.attempt >= this.maxAttempts) {
      return { action: "dead_letter", reason: "attempts_exhausted" };
    }
    if (
      input.failureKind === "abuse_signal" ||
      input.failureKind === "authentication" ||
      input.failureKind === "validation" ||
      input.failureKind === "unknown"
    ) {
      return { action: "dead_letter", reason: "non_retryable" };
    }

    let delayMs: number;
    if (input.failureKind === "rate_limited") {
      const retryAfter = boundedRetryAfter(input.retryAfterMs, this.maxRateLimitDelayMs);
      if (retryAfter === null) {
        return { action: "dead_letter", reason: "missing_retry_after" };
      }
      delayMs = retryAfter;
    } else {
      const hinted = boundedRetryAfter(input.retryAfterMs, this.maxDelayMs);
      const exponential = Math.min(
        this.maxDelayMs,
        this.baseDelayMs * (2 ** Math.min(input.attempt - 1, 20)),
      );
      const base = hinted ?? exponential;
      const random = this.random();
      if (!Number.isFinite(random) || random < 0 || random > 1) {
        throw new Error("Retry policy random source must return a number between zero and one");
      }
      delayMs = Math.max(1, Math.round(base * (0.8 + random * 0.4)));
    }

    return {
      action: "retry",
      reason: input.failureKind,
      delayMs,
      scheduledAt: new Date(occurredAt + delayMs).toISOString(),
    };
  }
}

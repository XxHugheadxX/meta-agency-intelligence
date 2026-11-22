import { assertReportingScope, type ReportingScope } from "../historical-data/index.js";

export interface ReportingConcurrencyLimits {
  readonly global: number;
  readonly perWorkspace: number;
  readonly retryAfterMs?: number;
}

export interface ReportingConcurrencySnapshot {
  readonly activeGlobal: number;
  readonly activeByWorkspace: Readonly<Record<string, number>>;
}

export class ReportingBackpressureError extends Error {
  readonly code = "REPORTING_BACKPRESSURE";
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("Reporting capacity is temporarily exhausted");
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 1 || retryAfterMs > 15 * 60_000) {
      throw new Error("Backpressure retryAfterMs must be between 1 and 900000");
    }
    this.retryAfterMs = retryAfterMs;
    this.name = "ReportingBackpressureError";
  }
}

function positiveLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${field} must be an integer between 1 and ${maximum}`);
  }
  return resolved;
}

function workspaceKey(scope: ReportingScope): string {
  return `${scope.tenantId}\u001f${scope.workspaceId}`;
}

export class ReportingConcurrencyGate {
  private readonly globalLimit: number;
  private readonly workspaceLimit: number;
  private readonly retryAfterMs: number;
  private activeGlobal = 0;
  private readonly activeByWorkspace = new Map<string, number>();

  constructor(limits: Partial<ReportingConcurrencyLimits> = {}) {
    this.globalLimit = positiveLimit(limits.global, 4, 1_000, "global concurrency");
    this.workspaceLimit = positiveLimit(limits.perWorkspace, 1, 1_000, "workspace concurrency");
    this.retryAfterMs = positiveLimit(limits.retryAfterMs, 5_000, 15 * 60_000, "retryAfterMs");
  }

  async run<T>(scope: ReportingScope, operation: () => Promise<T>): Promise<T> {
    assertReportingScope(scope);
    const key = workspaceKey(scope);
    const workspaceActive = this.activeByWorkspace.get(key) ?? 0;
    if (this.activeGlobal >= this.globalLimit || workspaceActive >= this.workspaceLimit) {
      throw new ReportingBackpressureError(this.retryAfterMs);
    }

    this.activeGlobal += 1;
    this.activeByWorkspace.set(key, workspaceActive + 1);
    try {
      return await operation();
    } finally {
      this.activeGlobal -= 1;
      const remaining = (this.activeByWorkspace.get(key) ?? 1) - 1;
      if (remaining === 0) this.activeByWorkspace.delete(key);
      else this.activeByWorkspace.set(key, remaining);
    }
  }

  snapshot(): ReportingConcurrencySnapshot {
    return {
      activeGlobal: this.activeGlobal,
      activeByWorkspace: Object.fromEntries(this.activeByWorkspace),
    };
  }
}

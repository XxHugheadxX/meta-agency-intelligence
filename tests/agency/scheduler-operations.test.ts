import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createReportingDeadLetterRecord,
  decodeReportingPubSubPush,
  encodeReportingPubSubData,
  ReportingBackpressureError,
  ReportingConcurrencyGate,
  ReportingRetryPolicy,
  type ReportingDeadLetterInput,
  type ReportingFailureKind,
} from "../../src/agency/scheduler/index.js";
import { tenantA, tenantB } from "./fixtures.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("reporting scheduler operations", () => {
  it("enforces global and workspace concurrency without mixing tenant scopes", async () => {
    const gate = new ReportingConcurrencyGate({ global: 2, perWorkspace: 1, retryAfterMs: 7_500 });
    const first = deferred<string>();
    const second = deferred<string>();
    const firstRun = gate.run(tenantA, () => first.promise);
    const secondRun = gate.run(tenantB, () => second.promise);

    expect(gate.snapshot()).toEqual({
      activeGlobal: 2,
      activeByWorkspace: {
        [`${tenantA.tenantId}\u001f${tenantA.workspaceId}`]: 1,
        [`${tenantB.tenantId}\u001f${tenantB.workspaceId}`]: 1,
      },
    });
    await expect(gate.run(
      { tenantId: "tenant-c", workspaceId: "workspace-c" },
      async () => "not-run",
    )).rejects.toMatchObject({
      name: "ReportingBackpressureError",
      code: "REPORTING_BACKPRESSURE",
      retryAfterMs: 7_500,
    });

    first.resolve("first");
    await expect(firstRun).resolves.toBe("first");
    await expect(gate.run(
      { tenantId: "tenant-c", workspaceId: "workspace-c" },
      async () => "third",
    )).resolves.toBe("third");
    second.resolve("second");
    await expect(secondRun).resolves.toBe("second");
    expect(gate.snapshot()).toEqual({ activeGlobal: 0, activeByWorkspace: {} });
  });

  it("rejects a concurrent job for the same workspace and releases capacity after failure", async () => {
    const gate = new ReportingConcurrencyGate({ global: 4, perWorkspace: 1 });
    const pending = deferred<void>();
    const running = gate.run(tenantA, () => pending.promise);
    await expect(gate.run(tenantA, async () => undefined)).rejects.toBeInstanceOf(
      ReportingBackpressureError,
    );
    pending.reject(new Error("synthetic operation failure"));
    await expect(running).rejects.toThrow("synthetic operation failure");
    await expect(gate.run(tenantA, async () => "recovered")).resolves.toBe("recovered");
  });

  it("uses bounded exponential retry with deterministic jitter for transient failures", () => {
    const policy = new ReportingRetryPolicy({ random: () => 0.5 });
    expect(policy.decide({
      failureKind: "transient",
      attempt: 1,
      occurredAt: "2026-08-31T08:00:00.000Z",
    })).toEqual({
      action: "retry",
      reason: "transient",
      delayMs: 5_000,
      scheduledAt: "2026-08-31T08:00:05.000Z",
    });
    expect(policy.decide({
      failureKind: "busy",
      attempt: 2,
      retryAfterMs: 12_000,
      occurredAt: "2026-08-31T08:00:00.000Z",
    })).toMatchObject({ action: "retry", reason: "busy", delayMs: 12_000 });
  });

  it("honors explicit rate-limit delays and fails closed without one", () => {
    const policy = new ReportingRetryPolicy({ random: () => 0.5 });
    expect(policy.decide({
      failureKind: "rate_limited",
      attempt: 1,
      retryAfterMs: 120_000,
      occurredAt: "2026-08-31T08:00:00.000Z",
    })).toEqual({
      action: "retry",
      reason: "rate_limited",
      delayMs: 120_000,
      scheduledAt: "2026-08-31T08:02:00.000Z",
    });
    expect(policy.decide({
      failureKind: "rate_limited",
      attempt: 1,
      occurredAt: "2026-08-31T08:00:00.000Z",
    })).toEqual({ action: "dead_letter", reason: "missing_retry_after" });
  });

  it.each<ReportingFailureKind>([
    "abuse_signal",
    "authentication",
    "validation",
    "unknown",
  ])("never retries the fail-closed failure kind %s", (failureKind) => {
    const policy = new ReportingRetryPolicy();
    expect(policy.decide({
      failureKind,
      attempt: 1,
      occurredAt: "2026-08-31T08:00:00.000Z",
    })).toEqual({ action: "dead_letter", reason: "non_retryable" });
  });

  it("dead-letters retryable work after the configured attempt limit", () => {
    const policy = new ReportingRetryPolicy({ maxAttempts: 3 });
    expect(policy.decide({
      failureKind: "transient",
      attempt: 3,
      occurredAt: "2026-08-31T08:00:00.000Z",
    })).toEqual({ action: "dead_letter", reason: "attempts_exhausted" });
  });

  it("builds minimized dead-letter records without payloads, signatures, or authorization", () => {
    const secret = "synthetic-bearer-must-not-persist";
    const input = {
      ...tenantA,
      jobId: "weekly-job",
      requestFingerprint: createHash("sha256").update("signed-payload").digest("hex"),
      attempts: 3,
      failureKind: "authentication",
      occurredAt: "2026-08-31T08:00:00.000Z",
      authorization: secret,
      payload: "signed-payload",
      signature: "synthetic-signature",
    } as unknown as ReportingDeadLetterInput;

    const record = createReportingDeadLetterRecord(input);
    expect(Object.keys(record).sort()).toEqual([
      "attempts",
      "failureKind",
      "jobId",
      "occurredAt",
      "requestFingerprint",
      "schemaVersion",
      "tenantId",
      "workspaceId",
    ]);
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(JSON.stringify(record)).not.toContain("signed-payload");
    expect(JSON.stringify(record)).not.toContain("synthetic-signature");
  });

  it("round-trips a bounded Pub/Sub push envelope without accepting embedded authorization", () => {
    const signed = { payload: "{\"tenantId\":\"tenant-a\"}", signature: "valid_signature" };
    const push = {
      message: {
        data: encodeReportingPubSubData(signed),
        messageId: "123456789",
        publishTime: "2026-08-31T08:00:00.000Z",
        attributes: { authorization: "Bearer attacker-controlled" },
      },
      subscription: "projects/agency-project/subscriptions/agency-reporting-push",
      deliveryAttempt: 2,
    };
    const decoded = decodeReportingPubSubPush(push);
    expect(decoded).toEqual(signed);
    expect(JSON.stringify(decoded)).not.toContain("attacker-controlled");
  });

  it("rejects malformed, oversized, or expanded Pub/Sub envelopes", () => {
    const base = {
      message: { data: "e30=", messageId: "123" },
      subscription: "projects/agency-project/subscriptions/agency-reporting-push",
    };
    expect(decodeReportingPubSubPush({ ...base, unexpected: true })).toBeNull();
    expect(decodeReportingPubSubPush({
      ...base,
      message: { ...base.message, data: "not-base64" },
    })).toBeNull();
    expect(decodeReportingPubSubPush({
      ...base,
      message: { ...base.message, data: "A".repeat(40_000) },
    })).toBeNull();
  });

  it("validates configuration and retry inputs", () => {
    expect(() => new ReportingConcurrencyGate({ global: 0 })).toThrow("global concurrency");
    expect(() => new ReportingBackpressureError(Number.POSITIVE_INFINITY)).toThrow(
      "retryAfterMs",
    );
    expect(() => new ReportingRetryPolicy({ baseDelayMs: 10, maxDelayMs: 5 })).toThrow(
      "cannot exceed",
    );
    const policy = new ReportingRetryPolicy({ random: vi.fn(() => 2) });
    expect(() => policy.decide({
      failureKind: "transient",
      attempt: 1,
      occurredAt: "2026-08-31T08:00:00.000Z",
    })).toThrow("random source");
    expect(() => createReportingDeadLetterRecord({
      ...tenantA,
      jobId: "weekly-job",
      requestFingerprint: "a".repeat(64),
      attempts: 1,
      failureKind: "unsafe" as ReportingFailureKind,
      occurredAt: "2026-08-31T08:00:00.000Z",
    })).toThrow("failureKind");
  });
});

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AgencyReportingWorker,
  InMemoryReportingJobLeaseRepository,
  PublicKeyIngestionJobVerifier,
  ReportingBackpressureError,
  ReportingConcurrencyGate,
  ReportingRetryPolicy,
  type AgencyReportingWorkerResult,
  type IngestionAuditEvent,
  type IngestionJobEnvelope,
  type ReportingJobPayload,
  type ReportingRuntime,
  type ReportingRuntimeResult,
} from "../../src/agency/index.js";
import { tenantA } from "./fixtures.js";

const NOW = "2026-08-31T08:00:00.000Z";

function job(index: number): ReportingJobPayload {
  return {
    ...tenantA,
    jobId: `load-weekly-account-${String(index).padStart(2, "0")}`,
    accountId: `act_${String(index).padStart(3, "0")}`,
    startDate: "2026-08-24",
    endDate: "2026-08-30",
    level: "ad",
    apiVersion: "v25.0",
    mode: "incremental",
    reportKind: "week",
    reportStartDate: "2026-08-24",
    reportEndDate: "2026-08-30",
    retentionDays: 30,
  };
}

function artifactId(jobId: string): string {
  return createHash("sha256").update(jobId, "utf8").digest("hex");
}

function runtimeResult(current: ReportingJobPayload): ReportingRuntimeResult {
  return {
    ingestion: {
      scope: tenantA,
      accountId: current.accountId,
      requestedStartDate: current.startDate,
      effectiveStartDate: current.startDate,
      endDate: current.endDate,
      mode: "incremental",
      rowsWritten: 3,
      pagesRead: 1,
      watermarkDate: current.endDate,
      runId: current.jobId,
    },
    artifact: {
      ...tenantA,
      artifactId: artifactId(current.jobId),
      jobId: current.jobId,
      period: {
        kind: current.reportKind,
        startDate: current.reportStartDate,
        endDate: current.reportEndDate,
      },
      filename: `${current.jobId}.xlsx`,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      byteLength: 4_096,
      sha256: "a".repeat(64),
      createdAt: NOW,
      expiresAt: "2026-09-30T08:00:00.000Z",
    },
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("reporting load for the twenty-account pilot", () => {
  it("completes twenty isolated jobs under bounded concurrency and safe retries", async () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jobs = Array.from({ length: 20 }, (_, index) => job(index + 1));
    const envelopes: IngestionJobEnvelope[] = jobs.map((current) => {
      const payload = JSON.stringify(current);
      return {
        authorization: "Bearer synthetic-scheduler-identity",
        payload,
        signature: sign("sha256", Buffer.from(payload), keys.privateKey).toString("base64url"),
      };
    });
    const runtimeAttempts = new Map<string, number>();
    let activeRuntime = 0;
    let peakRuntime = 0;
    const runtime: ReportingRuntime = {
      async run(_connection, current) {
        const attempt = (runtimeAttempts.get(current.accountId) ?? 0) + 1;
        runtimeAttempts.set(current.accountId, attempt);
        activeRuntime += 1;
        peakRuntime = Math.max(peakRuntime, activeRuntime);
        try {
          await wait(4);
          if (current.accountId === "act_007" && attempt === 1) {
            throw new Error("synthetic transient storage failure");
          }
          return runtimeResult(current);
        } finally {
          activeRuntime -= 1;
        }
      },
    };
    const events: IngestionAuditEvent[] = [];
    const resolve = vi.fn(async (scope, accountId: string) => ({
      scope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
      account: {
        accountId,
        accountName: `Cuenta ${accountId}`,
        currency: "BOB",
        timezone: "America/La_Paz",
      },
      accessToken: `synthetic-load-credential-${accountId}`,
      scopes: ["ads_read"],
      allowedAccountIds: [accountId],
      allowedAssetIds: [],
      organicAssets: [],
    }));
    const worker = new AgencyReportingWorker(
      {
        verify: vi.fn().mockResolvedValue({
          issuer: "https://accounts.google.com",
          audience: "https://service.example.test/internal/agency/reporting/jobs",
          subject: "123456789012345678901",
          roles: ["scheduler"],
        }),
      },
      new PublicKeyIngestionJobVerifier(keys.publicKey),
      { resolve },
      runtime,
      { async record(event) { events.push(structuredClone(event)); } },
      () => NOW,
      {
        repository: new InMemoryReportingJobLeaseRepository(),
        admission: new ReportingConcurrencyGate({
          global: 4,
          perWorkspace: 2,
          retryAfterMs: 10,
        }),
      },
    );
    const retry = new ReportingRetryPolicy({
      maxAttempts: 5,
      baseDelayMs: 5,
      maxDelayMs: 50,
      random: () => 0.5,
    });
    const queue = envelopes.map((envelope) => ({ envelope, attempt: 1 }));
    const completed: AgencyReportingWorkerResult[] = [];
    let backpressureCount = 0;

    const consume = async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) return;
        try {
          completed.push(await worker.run(item.envelope));
        } catch (error) {
          const busy = error instanceof ReportingBackpressureError;
          if (busy) backpressureCount += 1;
          const decision = retry.decide({
            failureKind: busy ? "busy" : "transient",
            attempt: item.attempt,
            occurredAt: NOW,
            ...(busy ? { retryAfterMs: error.retryAfterMs } : {}),
          });
          if (decision.action !== "retry") throw error;
          await wait(decision.delayMs);
          queue.push({ envelope: item.envelope, attempt: item.attempt + 1 });
        }
      }
    };

    const load = Promise.all(Array.from({ length: 2 }, () => consume()));
    await vi.waitFor(() => expect(activeRuntime).toBe(2));
    await expect(worker.run(envelopes[19])).rejects.toBeInstanceOf(
      ReportingBackpressureError,
    );
    backpressureCount += 1;
    await load;

    expect(completed).toHaveLength(20);
    expect(new Set(completed.map(({ accountId }) => accountId)).size).toBe(20);
    expect(new Set(completed.map(({ artifact }) => artifact.artifactId)).size).toBe(20);
    expect(completed.every((result) =>
      result.tenantId === tenantA.tenantId &&
      result.workspaceId === tenantA.workspaceId)).toBe(true);
    expect(peakRuntime).toBe(2);
    expect(backpressureCount).toBeGreaterThan(0);
    expect(runtimeAttempts.get("act_007")).toBe(2);
    expect([...runtimeAttempts.entries()]
      .filter(([accountId]) => accountId !== "act_007")
      .every(([, attempts]) => attempts === 1)).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(21);
    expect(events.filter(({ outcome }) => outcome === "succeeded")).toHaveLength(20);
    expect(JSON.stringify({ completed, events })).not.toContain("synthetic-load-credential");

    const firstCompleted = completed.find(({ accountId }) => accountId === "act_001");
    await expect(worker.run(envelopes[0])).resolves.toEqual(firstCompleted);
    expect(runtimeAttempts.get("act_001")).toBe(1);
    expect(resolve).toHaveBeenCalledTimes(21);
    expect(events.filter(({ outcome }) => outcome === "succeeded")).toHaveLength(21);
  });
});

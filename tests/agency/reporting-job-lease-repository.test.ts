import { describe, expect, it } from "vitest";
import {
  InMemoryReportingJobLeaseRepository,
  MIN_LEASE_TTL_MS,
  type ReportingJobLeaseHandle,
  type ReportingJobReplayResult,
} from "../../src/agency/worker/reporting-job-lease-repository.js";
import { tenantA, tenantB } from "./fixtures.js";

const fingerprint = "a".repeat(64);
const otherFingerprint = "b".repeat(64);
const result: ReportingJobReplayResult = {
  ...tenantA,
  jobId: "weekly-job",
  accountId: "act_100",
  runId: "weekly-job",
  rowsWritten: 24,
  pagesRead: 3,
  watermarkDate: "2026-08-30",
  artifact: {
    ...tenantA,
    artifactId: "c".repeat(64),
    jobId: "weekly-job",
    period: { kind: "week", startDate: "2026-08-24", endDate: "2026-08-30" },
    filename: "report.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    byteLength: 1024,
    sha256: "d".repeat(64),
    createdAt: "2026-08-31T08:00:00.000Z",
    expiresAt: "2026-09-07T08:00:00.000Z",
  },
};

function clock(initial = "2026-08-31T08:00:00.000Z") {
  let milliseconds = Date.parse(initial);
  return { now: () => new Date(milliseconds), advance: (ms: number) => { milliseconds += ms; } };
}

async function acquired(repository: InMemoryReportingJobLeaseRepository, holderId = "worker-a") {
  const claim = await repository.claim(tenantA, "weekly-job", fingerprint, holderId, 60_000);
  if (claim.status !== "acquired") throw new Error("Expected an acquired lease");
  return claim.handle;
}

describe("reporting job lease repository", () => {
  it("atomically allows one tenant-scoped claimant and isolates other scopes", async () => {
    const repository = new InMemoryReportingJobLeaseRepository(clock().now);
    const claims = await Promise.all([
      repository.claim(tenantA, "weekly-job", fingerprint, "worker-a", 60_000),
      repository.claim(tenantA, "weekly-job", fingerprint, "worker-b", 60_000),
    ]);
    expect(claims.filter((claim) => claim.status === "acquired")).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "busy")).toHaveLength(1);
    await expect(repository.claim(tenantB, "weekly-job", fingerprint, "worker-c", 60_000)).resolves.toMatchObject({ status: "acquired" });
  });

  it("rejects a different fingerprint for the same tenant-scoped job", async () => {
    const repository = new InMemoryReportingJobLeaseRepository(clock().now);
    await acquired(repository);
    await expect(repository.claim(tenantA, "weekly-job", otherFingerprint, "worker-b", 60_000)).rejects.toThrow("fingerprint");
  });

  it("renews only the current unexpired handle", async () => {
    const time = clock(); const repository = new InMemoryReportingJobLeaseRepository(time.now); const handle = await acquired(repository);
    const renewed = await repository.renew(tenantA, "weekly-job", handle, 60_000);
    expect(renewed).toMatchObject({ leaseId: handle.leaseId, fence: handle.fence });
    time.advance(60_000);
    await expect(repository.renew(tenantA, "weekly-job", renewed as ReportingJobLeaseHandle, 60_000)).resolves.toBeNull();
  });

  it("fences an old attempt even when the holder ID is reused", async () => {
    const time = clock(); const repository = new InMemoryReportingJobLeaseRepository(time.now);
    const first = await acquired(repository, "reused-holder"); time.advance(60_000);
    const secondClaim = await repository.claim(tenantA, "weekly-job", fingerprint, "reused-holder", 60_000);
    if (secondClaim.status !== "acquired") throw new Error("Expected takeover");
    expect(secondClaim.handle.fence).toBe(first.fence + 1);
    await expect(repository.release(tenantA, "weekly-job", first)).resolves.toBe(false);
    await expect(repository.complete(tenantA, "weekly-job", fingerprint, first, result)).resolves.toBe(false);
    await expect(repository.complete(tenantA, "weekly-job", fingerprint, secondClaim.handle, result)).resolves.toBe(true);
  });

  it("replays completed output only for the same fingerprint and completion is idempotent", async () => {
    const repository = new InMemoryReportingJobLeaseRepository(clock().now); const handle = await acquired(repository);
    await expect(repository.complete(tenantA, "weekly-job", fingerprint, handle, result)).resolves.toBe(true);
    await expect(repository.complete(tenantA, "weekly-job", fingerprint, handle, result)).resolves.toBe(true);
    await expect(repository.claim(tenantA, "weekly-job", fingerprint, "worker-b", 60_000)).resolves.toEqual({ status: "completed", result });
    await expect(repository.claim(tenantA, "weekly-job", otherFingerprint, "worker-b", 60_000)).rejects.toThrow("fingerprint");
  });

  it("rejects completion metadata from another tenant", async () => {
    const repository = new InMemoryReportingJobLeaseRepository(clock().now);
    const handle = await acquired(repository);
    const mismatched = {
      ...result,
      ...tenantB,
      artifact: { ...result.artifact, ...tenantB },
    };

    await expect(
      repository.complete(tenantA, "weekly-job", fingerprint, handle, mismatched),
    ).rejects.toThrow("tenant-scoped lease");
  });

  it("rejects collision-prone and control-character identifiers", async () => {
    const repository = new InMemoryReportingJobLeaseRepository(clock().now);
    await expect(repository.claim({ tenantId: "a\u001fb", workspaceId: "c" }, "job", fingerprint, "holder", 60_000)).rejects.toThrow("tenantId");
    await expect(repository.claim({ tenantId: "a", workspaceId: "b\u001fc" }, "job", fingerprint, "holder", 60_000)).rejects.toThrow("workspaceId");
    await expect(repository.claim(tenantA, "nested/job", fingerprint, "holder", 60_000)).rejects.toThrow("jobId");
    await expect(repository.claim(tenantA, "job", fingerprint, "holder\n", MIN_LEASE_TTL_MS)).rejects.toThrow("holderId");
  });
});

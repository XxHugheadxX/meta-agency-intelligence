import { randomUUID } from "node:crypto";
import { Firestore } from "@google-cloud/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FirestoreReportingJobLeaseRepository,
  type ReportingJobReplayResult,
} from "../../src/agency/worker/index.js";

function isLocalEmulator(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = host.replace(/^https?:\/\//, "").split(":")[0].toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

const describeEmulator = isLocalEmulator(process.env.FIRESTORE_EMULATOR_HOST)
  ? describe
  : describe.skip;

describeEmulator("Firestore reporting job lease integration", () => {
  const suffix = randomUUID();
  const scope = { tenantId: `lease-tenant-${suffix}`, workspaceId: "workspace-a" };
  const otherScope = { tenantId: `lease-other-${suffix}`, workspaceId: "workspace-b" };
  const fingerprint = "a".repeat(64);
  let nowMs = Date.parse("2026-08-31T08:00:00.000Z");
  let db: Firestore;

  const result: ReportingJobReplayResult = {
    ...scope,
    jobId: "weekly-job",
    accountId: "act_100",
    rowsWritten: 10,
    pagesRead: 2,
    watermarkDate: "2026-08-30",
    runId: "weekly-job",
    artifact: {
      ...scope,
      artifactId: "b".repeat(64),
      jobId: "weekly-job",
      period: { kind: "week", startDate: "2026-08-24", endDate: "2026-08-30" },
      filename: "report.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      byteLength: 1024,
      sha256: "c".repeat(64),
      createdAt: "2026-08-31T08:00:00.000Z",
      expiresAt: "2026-09-07T08:00:00.000Z",
    },
  };

  beforeAll(() => {
    db = new Firestore({ projectId: "meta-agency-emulator", ignoreUndefinedProperties: true });
  });

  afterAll(async () => {
    await Promise.all([
      db.recursiveDelete(db.collection("agency_tenants").doc(scope.tenantId)),
      db.recursiveDelete(db.collection("agency_tenants").doc(otherScope.tenantId)),
    ]);
    await db.terminate();
  });

  it("serializes claimants across repositories, fences takeover, and replays completion", async () => {
    const firstRepository = new FirestoreReportingJobLeaseRepository(db, () => new Date(nowMs));
    const secondRepository = new FirestoreReportingJobLeaseRepository(db, () => new Date(nowMs));
    const claims = await Promise.all([
      firstRepository.claim(scope, "weekly-job", fingerprint, "worker-a", 60_000),
      secondRepository.claim(scope, "weekly-job", fingerprint, "worker-b", 60_000),
    ]);
    const acquired = claims.find((claim) => claim.status === "acquired");
    expect(acquired?.status).toBe("acquired");
    expect(claims.filter((claim) => claim.status === "busy")).toHaveLength(1);
    if (!acquired || acquired.status !== "acquired") throw new Error("Expected an acquired lease");

    nowMs += 60_000;
    const takeover = await secondRepository.claim(
      scope,
      "weekly-job",
      fingerprint,
      "worker-c",
      60_000,
    );
    if (takeover.status !== "acquired") throw new Error("Expected a lease takeover");
    expect(takeover.handle.fence).toBe(acquired.handle.fence + 1);
    await expect(
      firstRepository.complete(scope, "weekly-job", fingerprint, acquired.handle, result),
    ).resolves.toBe(false);
    await expect(
      secondRepository.complete(scope, "weekly-job", fingerprint, takeover.handle, result),
    ).resolves.toBe(true);
    await expect(
      firstRepository.claim(scope, "weekly-job", fingerprint, "worker-d", 60_000),
    ).resolves.toEqual({ status: "completed", result });
    await expect(
      firstRepository.claim(otherScope, "weekly-job", fingerprint, "worker-e", 60_000),
    ).resolves.toMatchObject({ status: "acquired" });
  }, 15_000);
});

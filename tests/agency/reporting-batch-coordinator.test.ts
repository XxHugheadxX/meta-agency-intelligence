import { describe, expect, it } from "vitest";
import {
  AgencyReportingBatchCoordinator,
  InMemoryHistoricalDataRepository,
  InMemoryReportArtifactStore,
  InMemoryReportingBatchRepository,
  type ReportingJobPayload,
} from "../../src/agency/index.js";
import { metricFixture, tenantA, tenantB } from "./fixtures.js";

const batchId = `batch-${"a".repeat(40)}`;
const accountIds = ["act_100", "act_200"] as const;

function job(accountId: string, scope = tenantA): ReportingJobPayload {
  return {
    ...scope,
    jobId: `report-${accountId}`,
    accountId,
    startDate: "2026-08-01",
    endDate: "2026-08-31",
    level: "ad",
    apiVersion: "v23.0",
    reportKind: "month",
    reportStartDate: "2026-08-01",
    reportEndDate: "2026-08-31",
    retentionDays: 30,
    batchId,
    batchAccountIds: accountIds,
  };
}

describe("agency reporting batch coordinator", () => {
  it("emits one consolidated workbook only after every signed account completes", async () => {
    const historical = new InMemoryHistoricalDataRepository();
    for (const accountId of accountIds) {
      await historical.upsert(tenantA, metricFixture({
        accountId,
        accountName: accountId,
        date: "2026-08-12",
        metrics: { reach: accountId === "act_100" ? 100 : 200 },
      }));
    }
    const artifacts = new InMemoryReportArtifactStore(() => Date.parse("2026-09-01T00:00:00.000Z"));
    const coordinator = new AgencyReportingBatchCoordinator(
      new InMemoryReportingBatchRepository(() => Date.parse("2026-09-01T00:00:00.000Z")),
      historical,
      artifacts,
      undefined,
      () => "2026-09-01T00:00:00.000Z",
    );

    await expect(coordinator.record(job("act_100"))).resolves.toBeNull();
    const consolidated = await coordinator.record(job("act_200"));
    expect(consolidated?.jobId).toBe(batchId);
    const workbook = new TextDecoder().decode(
      artifacts.readBytes(tenantA, consolidated?.artifactId ?? "") ?? new Uint8Array(),
    );
    expect(workbook).toContain("act_100");
    expect(workbook).toContain("act_200");
    await expect(coordinator.record(job("act_200"))).resolves.toBeNull();
    await expect(artifacts.getMetadata(tenantB, consolidated?.artifactId ?? "")).resolves.toBeNull();
  });

  it("keeps identical batch IDs isolated by tenant and workspace", async () => {
    const batches = new InMemoryReportingBatchRepository();
    const coordinator = new AgencyReportingBatchCoordinator(
      batches,
      new InMemoryHistoricalDataRepository(),
      new InMemoryReportArtifactStore(),
    );
    await expect(coordinator.record(job("act_100", tenantA))).resolves.toBeNull();
    await expect(coordinator.record(job("act_100", tenantB))).resolves.toBeNull();
    await expect(batches.listRecent(tenantA, 20)).resolves.toHaveLength(1);
    await expect(batches.listRecent(tenantB, 20)).resolves.toHaveLength(1);
    await expect(batches.listRecent(
      { tenantId: tenantA.tenantId, workspaceId: "another-workspace" },
      20,
    )).resolves.toEqual([]);
  });

  it("rejects a changed membership for an existing tenant-scoped batch", async () => {
    const coordinator = new AgencyReportingBatchCoordinator(
      new InMemoryReportingBatchRepository(),
      new InMemoryHistoricalDataRepository(),
      new InMemoryReportArtifactStore(),
    );
    await coordinator.record(job("act_100"));
    await expect(coordinator.record({
      ...job("act_100"),
      batchAccountIds: ["act_100", "act_300"],
    })).rejects.toThrow("identity collision");
  });
});

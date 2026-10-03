import { describe, expect, it, vi } from "vitest";
import {
  AgencyReportingBatchCoordinator,
  AgencyExcelReportGenerator,
  InMemoryHistoricalDataRepository,
  InMemoryReportArtifactStore,
  InMemoryReportingBatchRepository,
  type ReportingJobPayload,
  type ResolvedIngestionConnection,
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
    attributionWindow: "7d_click",
    reportKind: "month",
    reportStartDate: "2026-08-01",
    reportEndDate: "2026-08-31",
    retentionDays: 30,
    batchId,
    batchAccountIds: accountIds,
  };
}

describe("agency reporting batch coordinator", () => {
  function connection(accountId: string, assetIds: readonly string[]): ResolvedIngestionConnection {
    return {
      scope: tenantA,
      account: { accountId, accountName: accountId, currency: "BOB", timezone: "America/La_Paz" },
      accessToken: "synthetic-secret-not-for-export",
      scopes: ["ads_read", "read_insights", "pages_read_engagement"],
      allowedAccountIds: [accountId], allowedAssetIds: assetIds,
      organicAssets: assetIds.map((assetId) => ({
        assetId, assetName: assetId, platform: "facebook_page", currency: "BOB", timezone: "America/La_Paz",
      })),
    };
  }

  it("limits organic and content rows in both periods to the batch connection assets", async () => {
    const historical = new InMemoryHistoricalDataRepository();
    for (const scope of [tenantA, tenantB]) {
      for (const assetId of ["300", "400", "500"]) {
        for (const level of ["organic_account", "content"] as const) {
          for (const date of ["2026-07-12", "2026-08-12"]) {
            await historical.upsert(scope, metricFixture({
              accountId: assetId, accountName: `${scope.tenantId}-${assetId}`,
              campaignId: null, campaignName: null, adSetId: null, adSetName: null,
              adId: null, adName: null, level, date,
              ...(level === "content" ? { contentId: `post-${assetId}`, contentName: "Post", contentType: "photo" } : {}),
              breakdowns: { source: level, platform: "facebook_page" },
              metrics: { impressions: 100, clicks: 5 },
            }));
          }
        }
      }
    }
    const resolve = vi.fn(async (_scope, accountId: string) =>
      connection(accountId, accountId === "act_100" ? ["300"] : ["300", "400"]));
    const excel = new AgencyExcelReportGenerator();
    const generate = vi.spyOn(excel, "generate");
    const artifacts = new InMemoryReportArtifactStore();
    const coordinator = new AgencyReportingBatchCoordinator(
      new InMemoryReportingBatchRepository(), historical, artifacts, excel, undefined, { resolve },
    );
    await coordinator.record(job("act_100"));
    const result = await coordinator.record(job("act_200"));
    expect(resolve.mock.calls).toEqual([[tenantA, "act_100"], [tenantA, "act_200"]]);
    const report = generate.mock.calls[0][0];
    for (const source of [report.sources?.organicAccount, report.sources?.content]) {
      expect(source?.rawRows.map((row) => row.accountId).sort()).toEqual(["300", "400"]);
      expect(source?.current.metrics.impressions).toBe(200);
      expect(source?.previous.metrics.impressions).toBe(200);
      expect(source?.rawRows.every((row) => row.tenantId === tenantA.tenantId)).toBe(true);
    }
    const workbook = new TextDecoder().decode(artifacts.readBytes(tenantA, result?.artifactId ?? "") ?? new Uint8Array());
    expect(workbook).not.toContain("synthetic-secret-not-for-export");
    expect(workbook).not.toContain("tenant-a-500");
    expect(workbook).not.toContain("tenant-b-300");
  });

  it("uses empty organic filters when no connection resolver is configured", async () => {
    const historical = new InMemoryHistoricalDataRepository();
    await historical.upsert(tenantA, metricFixture({
      level: "organic_account", accountId: "300", campaignId: null, campaignName: null,
      adSetId: null, adSetName: null, adId: null, adName: null,
    }));
    const excel = new AgencyExcelReportGenerator();
    const generate = vi.spyOn(excel, "generate");
    const coordinator = new AgencyReportingBatchCoordinator(
      new InMemoryReportingBatchRepository(), historical, new InMemoryReportArtifactStore(), excel,
    );
    await coordinator.record(job("act_100"));
    await coordinator.record(job("act_200"));
    expect(generate.mock.calls[0][0].sources?.organicAccount.rawRows).toEqual([]);
  });

  it.each(["tenant", "workspace", "account", "allowedAccount", "allowedAsset", "writeScope", "failure"])(
    "rejects invalid batch connection %s before generating and allows a safe replay",
    async (invalid) => {
      const batches = new InMemoryReportingBatchRepository();
      const excel = new AgencyExcelReportGenerator();
      const generate = vi.spyOn(excel, "generate");
      const resolve = vi.fn(async (_scope, accountId: string) => {
        const valid = connection(accountId, ["300"]);
        switch (invalid) {
          case "tenant": return { ...valid, scope: { ...tenantA, tenantId: tenantB.tenantId } };
          case "workspace": return { ...valid, scope: { ...tenantA, workspaceId: tenantB.workspaceId } };
          case "account": return { ...valid, account: { ...valid.account, accountId: "act_999" } };
          case "allowedAccount": return { ...valid, allowedAccountIds: [] };
          case "allowedAsset": return { ...valid, allowedAssetIds: [] };
          case "writeScope": return { ...valid, scopes: [...valid.scopes, "ads_management"] };
          default: throw new Error("Synthetic resolver failure");
        }
      });
      const coordinator = new AgencyReportingBatchCoordinator(
        batches, new InMemoryHistoricalDataRepository(), new InMemoryReportArtifactStore(), excel,
        undefined, { resolve },
      );
      await coordinator.record(job("act_100"));
      await expect(coordinator.record(job("act_200"))).rejects.toThrow();
      expect(generate).not.toHaveBeenCalled();
      expect((await batches.get(tenantA, batchId))?.status).toBe("collecting");
      resolve.mockImplementation(async (_scope, accountId: string) => connection(accountId, ["300"]));
      await expect(coordinator.record(job("act_200"))).resolves.not.toBeNull();
      expect(generate).toHaveBeenCalledOnce();
    },
  );

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
    await historical.upsert(tenantA, metricFixture({ accountId: "act_300", accountName: "EXCLUDED-ACCOUNT" }));
    await historical.upsert(tenantA, metricFixture({ accountId: "act_100", campaignName: "EXCLUDED-BREAKDOWN",
      breakdowns: { age: "25-34" } }));
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
    expect(workbook).not.toContain("EXCLUDED-ACCOUNT");
    expect(workbook).not.toContain("EXCLUDED-BREAKDOWN");
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

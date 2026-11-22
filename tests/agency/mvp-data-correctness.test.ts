import { describe, expect, it, vi } from "vitest";
import { AgencyReportingService, aggregateRows, monthlyPeriod, previousPeriod } from "../../src/agency/reporting/index.js";
import { InMemoryHistoricalDataRepository, normalizeHistoricalMetric } from "../../src/agency/historical-data/index.js";
import { normalizeMetaInsight } from "../../src/agency/ingestion/normalizer.js";
import { assertAdsOnlyReadPermissions, preflightAdsOnlyTestToken } from "../../src/agency/ingestion/contract-preflight.js";
import { MetaApiClient } from "../../src/meta/client.js";
import { getTenantContext, requestContext } from "../../src/auth/token-store.js";
import { analyzeSegmentation } from "../../src/agency/segmentation/index.js";
import { AgencyExcelReportGenerator } from "../../src/agency/excel/index.js";
import { metricFixture, tenantA, tenantB } from "./fixtures.js";

const period = { kind: "week" as const, startDate: "2026-08-10", endDate: "2026-08-16" };
const query = { startDate: period.startDate, endDate: period.endDate, level: "ad" as const };
const context = {
  account: { accountId: "act_100", accountName: "Prueba", currency: "BOB", timezone: "America/La_Paz" },
  level: "account" as const, attributionWindow: "7d_click", breakdowns: [], apiVersion: "v25.0",
  extractedAt: "2026-08-17T00:00:00.000Z", runId: "offline-test", pageNumber: 1,
};

describe("MVP data correctness regressions", () => {
  it.each([[2026, 9, "2026-08-01", "2026-08-31"], [2026, 1, "2025-12-01", "2025-12-31"],
    [2024, 3, "2024-02-01", "2024-02-29"]] as const)("compares %i/%i to a complete calendar month", (year, month, startDate, endDate) => {
    expect(previousPeriod(monthlyPeriod(year, month))).toEqual({ kind: "month", startDate, endDate });
  });

  it("preserves equal-length custom windows and rejects a partial monthly window", () => {
    expect(previousPeriod({ kind: "custom", startDate: "2026-09-10", endDate: "2026-09-12" }))
      .toEqual({ kind: "custom", startDate: "2026-09-07", endDate: "2026-09-09" });
    expect(() => previousPeriod({ kind: "month", startDate: "2026-09-02", endDate: "2026-09-30" })).toThrow("complete calendar month");
  });

  it("does not manufacture period reach or frequency from overlapping daily populations", () => {
    const rows = ["2026-08-10", "2026-08-11"].map((date, index) => normalizeHistoricalMetric(tenantA,
      metricFixture({ date, metrics: { reach: 100, impressions: 200 } }), `row-${index}`));
    expect(aggregateRows(rows).metrics).toMatchObject({ reach: null, frequency: null, impressions: 400 });
    expect(aggregateRows(rows).limitations?.join(" ")).toContain("no se suman personas");
    expect(aggregateRows([rows[0]]).metrics).toMatchObject({ reach: 100, frequency: 2 });
  });

  it("keeps base, segmented, versioned and foreign data isolated", async () => {
    const repository = new InMemoryHistoricalDataRepository();
    await repository.upsert(tenantA, metricFixture({ metrics: { spend: 10 } }));
    await repository.upsert(tenantA, metricFixture({ breakdowns: { age: "25-34" }, metrics: { spend: 10 } }));
    await repository.upsert(tenantB, metricFixture({ metrics: { spend: 99_999 } }));
    const service = new AgencyReportingService(repository);
    expect((await service.createReport(tenantA, { period })).current.metrics.spend).toBe(10);
    const segmented = await service.createReport(tenantA, { period, dataset: { breakdownKeys: ["age"] } });
    expect(segmented.current.metrics.spend).toBe(10);
    expect(segmented.segmentation?.performances.some((entry) => entry.dimension === "age")).toBe(true);
    expect(segmented.segmentation?.unavailableDimensions).toEqual(expect.arrayContaining(["interest", "audience", "creative"]));
    await repository.upsert(tenantA, metricFixture({ apiVersion: "v24.0", metrics: { spend: 30 } }));
    await expect(service.createReport(tenantA, { period })).rejects.toThrow("homogeneous apiVersion");
    const selected = await service.createReport(tenantA, { period, dataset: { apiVersion: "v24.0" } });
    expect(selected.current.metrics.spend).toBe(30);
    expect(selected.rawRows).toHaveLength(1);
  });

  it("filters attribution and schema without overwriting earlier source versions", async () => {
    const repository = new InMemoryHistoricalDataRepository();
    const first = await repository.upsert(tenantA, metricFixture());
    const other = await repository.upsert(tenantA, metricFixture({ schemaVersion: "v2" }));
    expect(first.id).not.toBe(other.id);
    await repository.upsert(tenantA, metricFixture({ attributionWindow: "1d_click" }));
    expect(await repository.list(tenantA, { ...query, schemaVersion: "v2", attributionWindow: "7d_click" })).toHaveLength(1);
    await expect(new AgencyReportingService(repository).createReport(tenantA, { period })).rejects.toThrow("homogeneous");
    await expect(repository.list(tenantA, { ...query, breakdownKeys: ["age", "age"] })).rejects.toThrow("breakdown selection");
  });

  it("selects a canonical action instead of adding overlapping aliases or multiple goals", () => {
    const row = normalizeMetaInsight({ date_start: "2026-08-10", actions: [
      { action_type: "lead", value: "5" }, { action_type: "onsite_conversion.lead_grouped", value: "5" },
      { action_type: "offsite_conversion.fb_pixel_lead", value: "3" },
      { action_type: "onsite_conversion.messaging_first_reply", value: "4" },
      { action_type: "onsite_conversion.total_messaging_connection", value: "6" },
    ], conversions: [{ action_type: "purchase", value: "2" }, { action_type: "custom", value: "1" }], spend: "100" }, context);
    expect(row.metrics).toMatchObject({ leads: 5, messages: 4, conversions: null, cpl: 20 });
    expect(row.rawData.metricDefinitions).toMatchObject({ actionTypes: { leads: "lead" }, ambiguousConversions: true });
    expect((row.rawData.payload as { conversions: unknown[] }).conversions).toHaveLength(2);
    const duplicate = normalizeMetaInsight({ date_start: "2026-08-10", actions: [
      { action_type: "lead", value: "5" }, { action_type: "lead", value: "5" },
    ] }, context);
    expect(duplicate.metrics.leads).toBeNull();
  });

  it("does not aggregate unlike action definitions in reporting or recommendations", () => {
    const rows = ["purchase", "custom"].map((actionType, index) => normalizeHistoricalMetric(tenantA, metricFixture({
      date: `2026-08-${10 + index}`, rawData: { metricDefinitions: { actionTypes: { conversions: actionType } } },
    }), `row-${index}`));
    expect(aggregateRows(rows).metrics.conversions).toBeNull();
    expect(analyzeSegmentation(tenantA, rows).performances.every((entry) => entry.metrics.conversions === null)).toBe(true);
  });

  it("rejects mixed breakdown datasets in standalone segmentation", () => {
    const rows = [normalizeHistoricalMetric(tenantA, metricFixture(), "base"),
      normalizeHistoricalMetric(tenantA, metricFixture({ breakdowns: { age: "25-34" } }), "age")];
    expect(() => analyzeSegmentation(tenantA, rows)).toThrow("homogeneous source dataset");
  });

  it("uses actual creative IDs, never substitutes an ad ID", () => {
    const row = normalizeHistoricalMetric(tenantA, metricFixture(), "row");
    expect(analyzeSegmentation(tenantA, [row]).unavailableDimensions).toContain("creative");
    expect(analyzeSegmentation(tenantA, [{ ...row, creativeId: "creative-200" }]).performances
      .find((entry) => entry.dimension === "creative")?.segmentId).toBe("creative-200");
  });

  it("exports recommendation evidence and quality notes without foreign rows or formulas from text", async () => {
    const repository = new InMemoryHistoricalDataRepository();
    for (let day = 10; day <= 12; day++) {
      await repository.upsert(tenantA, metricFixture({ date: `2026-08-${day}`, campaignName: "=malicious()",
        metrics: { spend: 100, reach: 100, impressions: 1_000, clicks: 1, leads: 1 } }));
      await repository.upsert(tenantA, metricFixture({ date: `2026-08-${day}`, adId: "other-ad", campaignId: "other-campaign",
        metrics: { spend: 20, reach: 100, impressions: 1_000, clicks: 50, leads: 5 } }));
    }
    await repository.upsert(tenantB, metricFixture({ campaignName: "FOREIGN-PRIVATE-CAMPAIGN" }));
    const report = await new AgencyReportingService(repository).createReport(tenantA, { period });
    expect(report.segmentation?.recommendations.length).toBeGreaterThan(0);
    const workbook = new TextDecoder().decode(new AgencyExcelReportGenerator().generate(report).bytes);
    expect(workbook.includes("Recomendaciones READ-ONLY")).toBe(true);
    expect(workbook.includes("no se suman personas")).toBe(true);
    expect(workbook.includes("FOREIGN-PRIVATE-CAMPAIGN")).toBe(false);
    expect(workbook.includes("<f>malicious()")).toBe(false);
    expect(workbook.includes("Métricas; no usuarios únicos")).toBe(true);
  });
});

describe("Ads contract permission preflight", () => {
  const granted = (permission: string) => ({ permission, status: "granted" });
  it("checks identity-level permissions without weakening tenant asset restrictions", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://graph.facebook.com/v25.0/me/permissions");
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer synthetic-contract-token");
      expect(getTenantContext()).toBeNull();
      return new Response(JSON.stringify({ data: [granted("ads_read")] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new MetaApiClient({ apiVersion: "v25.0", mode: "read_only", maxRetries: 0 });
      await requestContext.run({ ...tenantA, accessToken: "synthetic-outer-token" }, async () => {
        await preflightAdsOnlyTestToken(client, "synthetic-contract-token");
        expect(getTenantContext()).toMatchObject(tenantA);
        await expect(client.get("/me/permissions")).rejects.toThrow("cannot use /me edges");
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("accepts only granted ads_read and optional public_profile", () => {
    expect(() => assertAdsOnlyReadPermissions({ data: [granted("ads_read"), granted("public_profile")] })).not.toThrow();
  });
  it.each(["ads_management", "pages_manage_posts", "business_management", "unreviewed_permission"])("rejects %s before account reads", (permission) => {
    expect(() => assertAdsOnlyReadPermissions({ data: [granted("ads_read"), granted(permission)] })).toThrow("rejects additional scopes");
  });
  it("fails closed on missing, denied or malformed permissions", () => {
    for (const response of [null, {}, { data: [] }, { data: [null] }, { data: [{ permission: "ads_read", status: "declined" }] }]) {
      expect(() => assertAdsOnlyReadPermissions(response)).toThrow();
    }
  });
});

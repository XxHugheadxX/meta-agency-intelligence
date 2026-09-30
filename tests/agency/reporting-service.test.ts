import { describe, expect, it } from "vitest";
import { InMemoryHistoricalDataRepository } from "../../src/agency/historical-data/index.js";
import {
  AgencyReportingService,
  monthlyPeriod,
  weeklyPeriod,
} from "../../src/agency/reporting/index.js";
import { metricFixture, tenantA, tenantB } from "./fixtures.js";

describe("AgencyReportingService", () => {
  it("returns deterministic UTC weeks and calendar months", () => {
    expect(weeklyPeriod("2026-08-12")).toEqual({ kind: "week", startDate: "2026-08-10", endDate: "2026-08-16" });
    expect(monthlyPeriod(2026, 2)).toEqual({ kind: "month", startDate: "2026-02-01", endDate: "2026-02-28" });
    expect(() => weeklyPeriod("2026-02-31")).toThrow("ISO calendar date");
  });

  it("recalculates ratios, compares prior periods, and ranks accounts and agents", async () => {
    const repository = new InMemoryHistoricalDataRepository();
    await repository.upsert(tenantA, metricFixture({ date: "2026-08-10", metrics: { spend: 100, reach: 1_000, impressions: 2_000, clicks: 100, leads: 5 } }));
    await repository.upsert(tenantA, metricFixture({ adId: "ad-101", adName: "Casa", accountId: "act_200", accountName: "Inmobiliaria Sur", agentId: "agent-luis", agentName: "Luis", date: "2026-08-11", metrics: { spend: 50, reach: 500, impressions: 1_000, clicks: 25, leads: 8 } }));
    await repository.upsert(tenantA, metricFixture({ date: "2026-08-03", metrics: { spend: 80, reach: 800, impressions: 1_600, clicks: 80, leads: 4 } }));
    await repository.upsert(tenantB, metricFixture({ date: "2026-08-10", accountId: "act-foreign", metrics: { spend: 99_999, leads: 99_999 } }));

    const report = await new AgencyReportingService(repository).createWeeklyReport(tenantA, "2026-08-12");

    expect(report.current.metrics).toMatchObject({
      spend: 150,
      reach: null,
      impressions: 3_000,
      clicks: 125,
      leads: 13,
      ctr: 125 / 3_000 * 100,
      cpc: 150 / 125,
      cpm: 150 / 3_000 * 1_000,
      cpl: 150 / 13,
      frequency: null,
    });
    expect(report.comparison.spend).toMatchObject({ current: 150, previous: 80, absoluteChange: 70, percentageChange: 87.5 });
    expect(report.accountRanking.map((entry) => entry.id)).toEqual(["act_200", "act_100"]);
    expect(report.agentRanking.map((entry) => entry.name)).toEqual(["Luis", "Ana"]);
    expect(report.rawRows).toHaveLength(2);
  });

  it("does not manufacture ratios or comparison percentages from unavailable or zero denominators", async () => {
    const repository = new InMemoryHistoricalDataRepository();
    await repository.upsert(tenantA, metricFixture({ date: "2026-08-10", metrics: { spend: 0, impressions: 0, clicks: 0, leads: null } }));
    const report = await new AgencyReportingService(repository).createWeeklyReport(tenantA, "2026-08-12");

    expect(report.current.metrics.ctr).toBeNull();
    expect(report.current.metrics.cpl).toBeNull();
    expect(report.comparison.spend.percentageChange).toBeNull();
  });

  it("never adds spend from different currencies", async () => {
    const repository = new InMemoryHistoricalDataRepository();
    await repository.upsert(
      tenantA,
      metricFixture({ date: "2026-08-10", currency: "BOB", metrics: { spend: 70, leads: 7 } }),
    );
    await repository.upsert(
      tenantA,
      metricFixture({
        date: "2026-08-11",
        currency: "USD",
        adId: "ad-usd",
        metrics: { spend: 10, leads: 2 },
      }),
    );

    const report = await new AgencyReportingService(repository).createWeeklyReport(
      tenantA,
      "2026-08-12",
    );
    expect(report.current.metrics.spend).toBeNull();
    expect(report.current.metrics.cpl).toBeNull();
    expect(report.current.currencyBreakdown.BOB.spend).toBe(70);
    expect(report.current.currencyBreakdown.USD.spend).toBe(10);
  });

  it("compares a calendar month with the complete preceding calendar month", async () => {
    const repository = new InMemoryHistoricalDataRepository();
    await repository.upsert(
      tenantA,
      metricFixture({ date: "2026-02-15", metrics: { spend: 200, leads: 10 } }),
    );
    await repository.upsert(
      tenantA,
      metricFixture({ date: "2026-01-20", metrics: { spend: 100, leads: 5 } }),
    );

    const report = await new AgencyReportingService(repository).createMonthlyReport(
      tenantA,
      2026,
      2,
    );
    expect(report.period).toEqual({ kind: "month", startDate: "2026-02-01", endDate: "2026-02-28" });
    expect(report.previousPeriod).toEqual({ kind: "month", startDate: "2026-01-01", endDate: "2026-01-31" });
    expect(report.comparison.leads).toMatchObject({
      current: 10,
      previous: 5,
      percentageChange: 100,
    });
  });

  it("aggregates follower stock using the latest value per organic asset", async () => {
    const repository = new InMemoryHistoricalDataRepository();
    const organic = {
      level: "organic_account" as const,
      campaignId: null,
      campaignName: null,
      adSetId: null,
      adSetName: null,
      adId: null,
      adName: null,
      breakdowns: { source: "meta_organic_insights", platform: "instagram" },
    };
    await repository.upsert(tenantA, metricFixture({
      ...organic,
      accountId: "9001",
      accountName: "Cuenta Norte",
      date: "2026-08-10",
      metrics: { followerCount: 500, newFollowers: 5 },
    }));
    await repository.upsert(tenantA, metricFixture({
      ...organic,
      accountId: "9001",
      accountName: "Cuenta Norte",
      date: "2026-08-11",
      metrics: { followerCount: 503, newFollowers: 3 },
    }));
    await repository.upsert(tenantA, metricFixture({
      ...organic,
      accountId: "9002",
      accountName: "Cuenta Sur",
      date: "2026-08-11",
      metrics: { followerCount: 200, newFollowers: -2 },
    }));

    const report = await new AgencyReportingService(repository).createWeeklyReport(
      tenantA,
      "2026-08-12",
      "organic_account",
    );
    expect(report.current.metrics.followerCount).toBe(703);
    expect(report.current.metrics.newFollowers).toBe(6);
  });

  it("builds a unified report without summing paid, organic, and content reach", async () => {
    const repository = new InMemoryHistoricalDataRepository();
    await repository.upsert(tenantA, metricFixture({
      metrics: { spend: 100, reach: 1_000, impressions: 2_000, clicks: 100, leads: 5 },
    }));
    await repository.upsert(tenantA, metricFixture({
      level: "organic_account",
      campaignId: null,
      campaignName: null,
      adSetId: null,
      adSetName: null,
      adId: null,
      adName: null,
      metrics: { reach: 700, views: 900, profileVisits: 40, newFollowers: 8 },
      attributionWindow: null,
      breakdowns: { source: "meta_organic_insights", platform: "instagram" },
    }));
    await repository.upsert(tenantA, metricFixture({
      level: "content",
      campaignId: null,
      campaignName: null,
      adSetId: null,
      adSetName: null,
      adId: null,
      adName: null,
      contentId: "7001",
      contentName: "Reel Centro",
      contentType: "reel",
      metrics: { reach: 500, views: 800, interactions: 90, saves: 12, shares: 8 },
      attributionWindow: null,
      breakdowns: { source: "meta_organic_content_insights", platform: "instagram" },
    }));
    await repository.upsert(tenantB, metricFixture({
      metrics: { reach: 99_999, leads: 99_999 },
    }));

    const report = await new AgencyReportingService(repository).createUnifiedWeeklyReport(
      tenantA,
      "2026-08-12",
    );
    expect(report.current.metrics.reach).toBe(1_000);
    expect(report.sources?.paid.current.metrics.reach).toBe(1_000);
    expect(report.sources?.organicAccount.current.metrics.reach).toBe(700);
    expect(report.sources?.content.current.metrics.reach).toBe(500);
    expect(report.sources?.paid.rawRows).toHaveLength(1);
    expect(report.sources?.organicAccount.rawRows).toHaveLength(1);
    expect(report.sources?.content.rawRows).toHaveLength(1);
    expect(report.rawRows).toEqual(report.sources?.paid.rawRows);
  });

  it("filters each unified source independently for an account-scoped workbook", async () => {
    const repository = new InMemoryHistoricalDataRepository();
    for (const accountId of ["act_100", "act_200"]) {
      await repository.upsert(tenantA, metricFixture({
        accountId,
        accountName: accountId === "act_100" ? "Norte" : "Sur",
        date: "2026-08-10",
        metrics: { reach: accountId === "act_100" ? 100 : 9_000 },
      }));
    }
    for (const assetId of ["9001", "9002"]) {
      const common = {
        accountId: assetId,
        accountName: assetId === "9001" ? "Instagram Norte" : "Instagram Sur",
        campaignId: null,
        campaignName: null,
        adSetId: null,
        adSetName: null,
        adId: null,
        adName: null,
        date: "2026-08-10",
        attributionWindow: null,
      } as const;
      await repository.upsert(tenantA, metricFixture({
        ...common,
        level: "organic_account",
        metrics: { reach: assetId === "9001" ? 200 : 8_000 },
        breakdowns: { source: "meta_organic_insights", platform: "instagram" },
      }));
      await repository.upsert(tenantA, metricFixture({
        ...common,
        level: "content",
        contentId: `content-${assetId}`,
        contentName: `Reel ${assetId}`,
        contentType: "reel",
        metrics: { reach: assetId === "9001" ? 300 : 7_000 },
        breakdowns: { source: "meta_organic_content_insights", platform: "instagram" },
      }));
    }

    const report = await new AgencyReportingService(repository).createUnifiedReport(
      tenantA,
      {
        period: weeklyPeriod("2026-08-12"),
        sourceAccountIds: {
          paid: ["act_100"],
          organicAccount: ["9001"],
          content: ["9001"],
        },
      },
    );

    expect(report.sources?.paid.current.metrics.reach).toBe(100);
    expect(report.sources?.organicAccount.current.metrics.reach).toBe(200);
    expect(report.sources?.content.current.metrics.reach).toBe(300);
    expect(report.sources?.paid.rawRows.map(({ accountId }) => accountId)).toEqual(["act_100"]);
    expect(report.sources?.organicAccount.rawRows.map(({ accountId }) => accountId)).toEqual(["9001"]);
    expect(report.sources?.content.rawRows.map(({ accountId }) => accountId)).toEqual(["9001"]);
  });

  it("rejects malformed, duplicate, or excessive unified source filters", async () => {
    const service = new AgencyReportingService(new InMemoryHistoricalDataRepository());
    const period = weeklyPeriod("2026-08-12");
    await expect(service.createUnifiedReport(tenantA, {
      period,
      sourceAccountIds: { paid: ["act_100", "act_100"] },
    })).rejects.toThrow("duplicate");
    await expect(service.createUnifiedReport(tenantA, {
      period,
      sourceAccountIds: { organicAccount: ["../../other-workspace"] },
    })).rejects.toThrow("invalid Meta");
    await expect(service.createUnifiedReport(tenantA, {
      period,
      sourceAccountIds: {
        content: Array.from({ length: 101 }, (_, index) => String(index + 1)),
      },
    })).rejects.toThrow("100 account IDs");
  });
});

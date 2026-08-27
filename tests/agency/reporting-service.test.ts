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
      reach: 1_500,
      impressions: 3_000,
      clicks: 125,
      leads: 13,
      ctr: 125 / 3_000 * 100,
      cpc: 150 / 125,
      cpm: 150 / 3_000 * 1_000,
      cpl: 150 / 13,
      frequency: 2,
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

  it("compares a calendar month with the immediately preceding equal-length period", async () => {
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
    expect(report.previousPeriod).toEqual({ kind: "month", startDate: "2026-01-04", endDate: "2026-01-31" });
    expect(report.comparison.leads).toMatchObject({
      current: 10,
      previous: 5,
      percentageChange: 100,
    });
  });
});

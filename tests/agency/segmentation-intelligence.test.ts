import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  analyzeSegmentation,
  normalizeHistoricalMetric,
  type HistoricalMetricInput,
  type HistoricalMetricRow,
} from "../../src/agency/index.js";
import { metricFixture, tenantA, tenantB } from "./fixtures.js";

function row(id: string, overrides: Partial<HistoricalMetricInput> = {}, tenant = tenantA): HistoricalMetricRow {
  return normalizeHistoricalMetric(tenant, {
    ...metricFixture({
      breakdowns: { location: "Norte", age: "25-34", gender: "female", interest: "inmuebles", placement: "instagram_feed", device: "mobile", audience: "Prospecting" },
      metrics: { spend: 20, reach: 500, impressions: 1_000, clicks: 40, messages: 5, leads: 5, conversions: 2 },
      ...overrides,
    }),
  }, id, undefined, "2026-08-12T00:00:00.000Z");
}

describe("segmentation intelligence", () => {
  it("keeps tenant data isolated and returns read-only structured recommendations", () => {
    const rows = [
      ...[1, 2, 3].map((index) => row(`norte-${index}`)),
      ...[1, 2, 3].map((index) => row(`centro-${index}`, {
        breakdowns: { location: "Centro", age: "25-34", gender: "female", interest: "inmuebles", placement: "instagram_feed", device: "mobile", audience: "Prospecting" },
        metrics: { spend: 100, reach: 500, impressions: 1_000, clicks: 30, messages: 5, leads: 1, conversions: 1 },
      })),
      ...[1, 2, 3].map((index) => row(`sur-${index}`, {
        breakdowns: { location: "Sur", age: "45-54", gender: "male", interest: "venta", placement: "facebook_feed", device: "desktop", audience: "Retargeting" },
        metrics: { spend: 20, reach: 100, impressions: 800, clicks: 2, messages: 1, leads: 1, conversions: 0 },
      })),
      row("foreign", { accountId: "foreign", accountName: "No disponible" }, tenantB),
    ];
    const before = JSON.stringify(rows);
    const analysis = analyzeSegmentation(tenantA, rows, { minimumRows: 3, minimumImpressions: 100 });

    expect(JSON.stringify(rows)).toBe(before);
    expect(analysis.analyzedRows).toBe(9);
    expect(analysis.excludedRows).toBe(1);
    expect(analysis.performances.some((entry) => entry.segment === "No disponible")).toBe(false);
    expect(analysis.performances.some((entry) => entry.dimension === "age")).toBe(true);
    expect(analysis.performances.some((entry) => entry.dimension === "campaign")).toBe(true);
    expect(analysis.performances.some((entry) => entry.dimension === "creative")).toBe(true);
    expect(analysis.recommendations.map((entry) => entry.kind)).toEqual(expect.arrayContaining([
      "good_ctr_bad_cpl", "low_ctr", "saturated_audience", "best_location", "budget_redistribution", "ab_test",
    ]));
    const recommendation = analysis.recommendations[0];
    expect(recommendation).toMatchObject({ evidence: { currency: "BOB", metrics: expect.any(Object) }, caveats: expect.any(Array) });
    expect(recommendation.caveats).toContain(
      "Alcance y frecuencia agregados no deduplican personas entre días, anuncios o ad sets.",
    );
  });

  it("does not combine monetary data across currencies or manufacture unavailable ratios", () => {
    const rows = [
      row("bob-1", { breakdowns: { location: "Norte" }, metrics: { spend: 50, reach: 100, impressions: 0, clicks: 0, leads: null } }),
      row("usd-1", { currency: "USD", breakdowns: { location: "Norte" }, metrics: { spend: 10, reach: 100, impressions: 100, clicks: 0, leads: null } }),
    ];
    const analysis = analyzeSegmentation(tenantA, rows, { minimumRows: 1, minimumImpressions: 0, dimensions: ["location"] });
    const norte = analysis.performances.filter((entry) => entry.segment === "Norte");

    expect(norte).toHaveLength(2);
    expect(norte.find((entry) => entry.currency === "BOB")?.metrics.spend).toBe(50);
    expect(norte.find((entry) => entry.currency === "USD")?.metrics.spend).toBe(10);
    expect(norte.find((entry) => entry.currency === "BOB")?.metrics.ctr).toBeNull();
    expect(norte.find((entry) => entry.currency === "USD")?.metrics.cpl).toBeNull();
  });

  it("is pure read-only code with configurable thresholds and data-availability caveats", () => {
    const source = readFileSync(new URL("../../src/agency/segmentation/analyzer.ts", import.meta.url), "utf8");
    const analysis = analyzeSegmentation(tenantA, [row("only", { breakdowns: {} })], {
      dimensions: ["gender"], minimumRows: 2, minimumImpressions: 10_000,
      thresholds: { lowCtr: 10 },
    });

    expect(analysis.unavailableDimensions).toEqual(["gender"]);
    expect(analysis.recommendations).toHaveLength(0);
    expect(source).not.toMatch(/\b(fetch|upsert|POST|PATCH|DELETE|ads_management)\b/i);
  });

  it("keeps distinct entity IDs separate even when their display names match", () => {
    const analysis = analyzeSegmentation(
      tenantA,
      [
        row("campaign-a", { campaignId: "campaign-a", campaignName: "Duplicada" }),
        row("campaign-b", { campaignId: "campaign-b", campaignName: "Duplicada" }),
      ],
      {
        dimensions: ["campaign"],
        minimumRows: 1,
        minimumImpressions: 0,
      },
    );

    expect(analysis.performances.map((entry) => entry.segmentId)).toEqual([
      "campaign-a",
      "campaign-b",
    ]);
  });
});

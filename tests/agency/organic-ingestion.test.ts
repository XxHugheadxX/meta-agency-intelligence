import { describe, expect, it } from "vitest";
import type { MetaApiResponse } from "../../src/meta/types/common.js";
import {
  AgencyOrganicIngestionService,
  InMemoryOrganicAssetPolicy,
  MetaOrganicInsightsReader,
  normalizeOrganicInsights,
  ORGANIC_ACCOUNT_METRICS,
  type OrganicAsset,
  type OrganicInsightRecord,
  type OrganicInsightsPageQuery,
  type OrganicInsightsPageReader,
  type OrganicReadOnlyMetaClient,
} from "../../src/agency/ingestion/index.js";
import { InMemoryHistoricalDataRepository } from "../../src/agency/historical-data/index.js";
import { tenantA, tenantB } from "./fixtures.js";

const instagram: OrganicAsset = {
  assetId: "9001",
  assetName: "Inmobiliaria Norte IG",
  platform: "instagram",
  currency: "BOB",
  timezone: "America/La_Paz",
  agentId: "agent-ana",
  agentName: "Ana",
};

const facebook: OrganicAsset = {
  ...instagram,
  assetId: "6001",
  assetName: "Inmobiliaria Norte Facebook",
  platform: "facebook_page",
};

function metric(
  name: string,
  values: readonly [string, number][],
  extra: Readonly<Record<string, unknown>> = {},
): OrganicInsightRecord {
  return {
    name,
    period: "day",
    values: values.map(([end_time, value]) => ({ end_time, value })),
    ...extra,
  };
}

class SequenceOrganicReader implements OrganicInsightsPageReader {
  readonly queries: OrganicInsightsPageQuery[] = [];

  constructor(private readonly pages: readonly MetaApiResponse<OrganicInsightRecord>[]) {}

  async readPage(query: OrganicInsightsPageQuery): Promise<MetaApiResponse<OrganicInsightRecord>> {
    this.queries.push(structuredClone(query));
    const page = this.pages[this.queries.length - 1];
    if (!page) throw new Error("synthetic organic reader exhausted");
    return structuredClone(page);
  }
}

function service(reader: OrganicInsightsPageReader, allowedFor = tenantA) {
  const historical = new InMemoryHistoricalDataRepository();
  const policy = new InMemoryOrganicAssetPolicy();
  policy.allow(allowedFor, instagram.platform, instagram.assetId);
  const ingestion = new AgencyOrganicIngestionService(
    reader,
    historical,
    policy,
    () => "2026-08-30T12:00:00.000Z",
  );
  return { historical, policy, ingestion };
}

const request = {
  scope: tenantA,
  asset: instagram,
  startDate: "2026-08-10",
  endDate: "2026-08-11",
  apiVersion: "v25.0",
  runId: "organic-synthetic-1",
} as const;

describe("Meta organic read-only ingestion", () => {
  it("builds fixed, bounded GET-only requests without credentials in params", async () => {
    const calls: Array<{ path: string; params?: Readonly<Record<string, unknown>> }> = [];
    const client: OrganicReadOnlyMetaClient = {
      async get<T>(path: string, params?: Readonly<Record<string, string | number | boolean | undefined>>) {
        calls.push({ path, params });
        return { data: [] } as T;
      },
    };
    const reader = new MetaOrganicInsightsReader(client);
    await reader.readPage({
      asset: instagram,
      startDate: "2026-08-10",
      endDate: "2026-08-11",
      after: "cursor-1",
    });
    await reader.readPage({ asset: facebook, startDate: "2026-08-10", endDate: "2026-08-11" });

    expect(calls[0]).toEqual({
      path: "/9001/insights",
      params: {
        metric: ORGANIC_ACCOUNT_METRICS.instagram.join(","),
        period: "day",
        since: "2026-08-10",
        until: "2026-08-11",
        limit: 100,
        after: "cursor-1",
        metric_type: "time_series",
      },
    });
    expect(calls[1]?.path).toBe("/6001/insights");
    expect(calls[1]?.params).toMatchObject({
      metric: ORGANIC_ACCOUNT_METRICS.facebook_page.join(","),
      period: "day",
    });
    expect(JSON.stringify(calls)).not.toMatch(/access_token|authorization|client_secret/i);
  });

  it("normalizes Instagram daily metrics and derives signed follower growth", () => {
    const records = [
      metric("reach", [["2026-08-10T08:00:00+0000", 1_000], ["2026-08-11T08:00:00+0000", 1_200]]),
      metric("views", [["2026-08-10T08:00:00+0000", 2_000], ["2026-08-11T08:00:00+0000", 2_200]]),
      metric("profile_views", [["2026-08-10T08:00:00+0000", 50], ["2026-08-11T08:00:00+0000", 60]]),
      metric("total_interactions", [["2026-08-10T08:00:00+0000", 80], ["2026-08-11T08:00:00+0000", 90]]),
      metric("saves", [["2026-08-10T08:00:00+0000", 12], ["2026-08-11T08:00:00+0000", 15]]),
      metric("shares", [["2026-08-10T08:00:00+0000", 8], ["2026-08-11T08:00:00+0000", 10]]),
      metric("follower_count", [["2026-08-10T08:00:00+0000", 500], ["2026-08-11T08:00:00+0000", 497]]),
    ];
    const rows = normalizeOrganicInsights(records, {
      asset: instagram,
      startDate: "2026-08-10",
      endDate: "2026-08-11",
      apiVersion: "v25.0",
      extractedAt: "2026-08-30T12:00:00.000Z",
      runId: "synthetic",
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.metrics).toMatchObject({
      reach: 1_000,
      views: 2_000,
      profileVisits: 50,
      interactions: 80,
      saves: 12,
      shares: 8,
      followerCount: 500,
    });
    expect(rows[0]?.metrics.newFollowers).toBeUndefined();
    expect(rows[1]?.metrics.newFollowers).toBe(-3);
    expect(rows[1]?.metrics.impressions).toBeUndefined();
    expect(rows[1]?.breakdowns).toEqual({ source: "meta_organic_insights", platform: "instagram" });
  });

  it("calculates Facebook net followers only when both inputs are available", () => {
    const rows = normalizeOrganicInsights([
      metric("page_impressions", [["2026-08-10T08:00:00+0000", 2_000]]),
      metric("page_impressions_unique", [["2026-08-10T08:00:00+0000", 1_000]]),
      metric("page_post_engagements", [["2026-08-10T08:00:00+0000", 90]]),
      metric("page_views_total", [["2026-08-10T08:00:00+0000", 40]]),
      metric("page_daily_follows", [["2026-08-10T08:00:00+0000", 8]]),
      metric("page_daily_unfollows", [["2026-08-10T08:00:00+0000", 3]]),
    ], {
      asset: facebook,
      startDate: "2026-08-10",
      endDate: "2026-08-10",
      apiVersion: "v25.0",
      extractedAt: "2026-08-30T12:00:00.000Z",
      runId: "synthetic",
    });

    expect(rows[0]?.metrics).toMatchObject({
      impressions: 2_000,
      reach: 1_000,
      interactions: 90,
      profileVisits: 40,
      newFollowers: 5,
    });
  });

  it("authorizes the tenant before reading, persists idempotently, and isolates storage", async () => {
    const reader = new SequenceOrganicReader([{ data: [
      metric("reach", [["2026-08-10T08:00:00+0000", 1_000], ["2026-08-11T08:00:00+0000", 900]]),
      metric("follower_count", [["2026-08-10T08:00:00+0000", 500], ["2026-08-11T08:00:00+0000", 497]]),
    ] }]);
    const context = service(reader);
    await expect(context.ingestion.run(request)).resolves.toMatchObject({
      pagesRead: 1,
      rowsWritten: 2,
      platform: "instagram",
    });
    await expect(context.historical.list(tenantA, {
      startDate: "2026-08-10",
      endDate: "2026-08-11",
      level: "account",
    })).resolves.toHaveLength(2);
    const stored = await context.historical.list(tenantA, {
      startDate: "2026-08-10",
      endDate: "2026-08-11",
      level: "account",
    });
    expect(stored[1]?.metrics.newFollowers).toBe(-3);
    expect(stored[1]?.quality).toBe("partial");
    await expect(context.historical.list(tenantB, {
      startDate: "2026-08-10",
      endDate: "2026-08-11",
    })).resolves.toEqual([]);

    const deniedReader = new SequenceOrganicReader([{ data: [] }]);
    const denied = service(deniedReader, tenantB);
    await expect(denied.ingestion.run(request)).rejects.toThrow("not assigned");
    expect(deniedReader.queries).toEqual([]);
  });

  it("redacts credential-shaped metadata and rejects malformed or out-of-range data", () => {
    const rows = normalizeOrganicInsights([
      metric("reach", [["2026-08-10T08:00:00+0000", 10]], {
        access_token: "EAAThisIsSyntheticSensitiveValue",
      }),
    ], {
      asset: instagram,
      startDate: "2026-08-10",
      endDate: "2026-08-10",
      apiVersion: "v25.0",
      extractedAt: "2026-08-30T12:00:00.000Z",
      runId: "synthetic",
    });
    const rawMetrics = rows[0]?.rawData.metrics as Record<string, Record<string, unknown>>;
    const metadata = rawMetrics.reach?.metadata as Record<string, unknown>;
    expect(metadata.access_token).toBe("[REDACTED]");

    expect(() => normalizeOrganicInsights([
      metric("reach", [["2026-08-12T08:00:00+0000", 10]]),
    ], {
      asset: instagram,
      startDate: "2026-08-10",
      endDate: "2026-08-11",
      apiVersion: "v25.0",
      extractedAt: "2026-08-30T12:00:00.000Z",
      runId: "synthetic",
    })).toThrow("outside");
    expect(() => normalizeOrganicInsights([
      metric("reach", [["2026-08-10T08:00:00+0000", -1]]),
    ], {
      asset: instagram,
      startDate: "2026-08-10",
      endDate: "2026-08-11",
      apiVersion: "v25.0",
      extractedAt: "2026-08-30T12:00:00.000Z",
      runId: "synthetic",
    })).toThrow("non-negative");
  });

  it("fails closed on pagination loops and oversized responses before persistence", async () => {
    const looping = new SequenceOrganicReader([
      { data: [], paging: { cursors: { after: "same" }, next: "next" } },
      { data: [], paging: { cursors: { after: "same" }, next: "next" } },
    ]);
    await expect(service(looping).ingestion.run(request)).rejects.toThrow("repeated an after cursor");

    const oversized = new SequenceOrganicReader([{ data: [
      metric("reach", [["2026-08-10T08:00:00+0000", 1]]),
      metric("views", [["2026-08-10T08:00:00+0000", 2]]),
    ] }]);
    const context = service(oversized);
    await expect(context.ingestion.run({ ...request, maxRecords: 1 })).rejects.toThrow("maxRecords");
    await expect(context.historical.list(tenantA, {
      startDate: "2026-08-10",
      endDate: "2026-08-11",
    })).resolves.toEqual([]);
  });
});

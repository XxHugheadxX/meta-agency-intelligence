import { describe, expect, it } from "vitest";
import type { MetaApiResponse } from "../../src/meta/types/common.js";
import {
  AgencyOrganicContentIngestionService,
  InMemoryOrganicAssetPolicy,
  INSTAGRAM_CONTENT_FIELDS,
  INSTAGRAM_CONTENT_METRICS,
  MetaInstagramContentReader,
  normalizeInstagramContent,
  normalizeInstagramContentInsights,
  type OrganicAsset,
  type OrganicContentInsightsQuery,
  type OrganicContentPageQuery,
  type OrganicContentReader,
  type OrganicContentRecord,
  type OrganicInsightRecord,
  type OrganicReadOnlyMetaClient,
} from "../../src/agency/ingestion/index.js";
import { InMemoryHistoricalDataRepository } from "../../src/agency/historical-data/index.js";
import { tenantA, tenantB } from "./fixtures.js";

const asset: OrganicAsset = {
  assetId: "9001",
  assetName: "Inmobiliaria Norte IG",
  platform: "instagram",
  currency: "BOB",
  timezone: "America/La_Paz",
  agentId: "agent-ana",
  agentName: "Ana",
};

function content(overrides: Partial<OrganicContentRecord> = {}): OrganicContentRecord {
  return {
    id: "7001",
    caption: "Departamento en el centro",
    media_type: "VIDEO",
    media_product_type: "REELS",
    timestamp: "2026-08-10T15:00:00+0000",
    permalink: "https://www.instagram.com/reel/synthetic/?utm_source=test#fragment",
    ...overrides,
  };
}

function insight(name: string, value: number, extra: Readonly<Record<string, unknown>> = {}): OrganicInsightRecord {
  return { name, period: "lifetime", values: [{ value }], ...extra };
}

function insightSet(overrides: Readonly<Record<string, number>> = {}): OrganicInsightRecord[] {
  const values: Record<string, number> = {
    reach: 1_000,
    views: 1_500,
    likes: 80,
    comments: 10,
    shares: 12,
    saved: 18,
    total_interactions: 120,
    ...overrides,
  };
  return Object.entries(values).map(([name, value]) => insight(name, value));
}

class SyntheticContentReader implements OrganicContentReader {
  readonly pageQueries: OrganicContentPageQuery[] = [];
  readonly insightQueries: OrganicContentInsightsQuery[] = [];

  constructor(
    private readonly pages: readonly MetaApiResponse<OrganicContentRecord>[],
    private readonly insights: Readonly<Record<string, readonly OrganicInsightRecord[]>>,
  ) {}

  async readContentPage(query: OrganicContentPageQuery): Promise<MetaApiResponse<OrganicContentRecord>> {
    this.pageQueries.push(structuredClone(query));
    const page = this.pages[this.pageQueries.length - 1];
    if (!page) throw new Error("synthetic content reader exhausted");
    return structuredClone(page);
  }

  async readInsights(query: OrganicContentInsightsQuery): Promise<MetaApiResponse<OrganicInsightRecord>> {
    this.insightQueries.push(structuredClone(query));
    const records = this.insights[query.content.contentId];
    if (!records) throw new Error("synthetic content insights missing");
    return { data: structuredClone(records) };
  }
}

function createService(reader: OrganicContentReader, allowedScope = tenantA) {
  const historical = new InMemoryHistoricalDataRepository();
  const policy = new InMemoryOrganicAssetPolicy();
  policy.allow(allowedScope, "instagram", asset.assetId);
  return {
    historical,
    ingestion: new AgencyOrganicContentIngestionService(
      reader,
      historical,
      policy,
      () => "2026-08-30T12:00:00.000Z",
    ),
  };
}

const request = {
  scope: tenantA,
  asset,
  startDate: "2026-08-01",
  endDate: "2026-08-31",
  apiVersion: "v25.0",
  runId: "content-synthetic-1",
} as const;

describe("Instagram organic content ingestion", () => {
  it("uses only fixed, bounded GET requests without credentials in params", async () => {
    const calls: Array<{ path: string; params?: Readonly<Record<string, unknown>> }> = [];
    const client: OrganicReadOnlyMetaClient = {
      async get<T>(path: string, params?: Readonly<Record<string, string | number | boolean | undefined>>) {
        calls.push({ path, params });
        return { data: [] } as T;
      },
    };
    const reader = new MetaInstagramContentReader(client);
    const normalized = normalizeInstagramContent(content());
    await reader.readContentPage({
      asset,
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      after: "cursor-1",
    });
    await reader.readInsights({ asset, content: normalized });

    expect(calls).toEqual([
      {
        path: "/9001/media",
        params: {
          fields: INSTAGRAM_CONTENT_FIELDS.join(","),
          since: "2026-08-01",
          until: "2026-08-31",
          limit: 100,
          after: "cursor-1",
        },
      },
      {
        path: "/7001/insights",
        params: { metric: INSTAGRAM_CONTENT_METRICS.join(",") },
      },
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/access_token|authorization|client_secret/i);
  });

  it("normalizes content identity, lifetime metrics, and sanitized raw data", () => {
    const item = normalizeInstagramContent(content({
      caption: "\u0000  Casa   familiar  ",
    }));
    expect(item).toMatchObject({
      contentId: "7001",
      contentName: "Casa familiar",
      contentType: "reel",
      publishedAt: "2026-08-10T15:00:00.000Z",
      permalink: "https://www.instagram.com/reel/synthetic/",
    });
    const row = normalizeInstagramContentInsights(
      item,
      insightSet({ shares: 14 }),
      {
        asset,
        apiVersion: "v25.0",
        extractedAt: "2026-08-30T12:00:00.000Z",
        runId: "synthetic",
      },
    );
    expect(row).toMatchObject({
      accountId: "9001",
      contentId: "7001",
      contentName: "Casa familiar",
      contentType: "reel",
      date: "2026-08-10",
      level: "content",
      quality: "complete",
      metrics: { reach: 1_000, views: 1_500, saves: 18, shares: 14, interactions: 120 },
    });

    const redacted = normalizeInstagramContentInsights(
      item,
      [insight("reach", 1, { access_token: "EAAThisIsSyntheticSensitiveValue" })],
      {
        asset,
        apiVersion: "v25.0",
        extractedAt: "2026-08-30T12:00:00.000Z",
        runId: "synthetic",
      },
    );
    const raw = redacted.rawData.metrics as Record<string, Record<string, unknown>>;
    expect(raw.reach?.access_token).toBe("[REDACTED]");
    expect(redacted.quality).toBe("partial");
  });

  it("paginates discovery, reads each content once, and persists tenant-scoped rows", async () => {
    const reader = new SyntheticContentReader([
      {
        data: [content()],
        paging: { cursors: { after: "cursor-2" }, next: "synthetic-next" },
      },
      {
        data: [content({
          id: "7002",
          caption: "Carrusel zona sur",
          media_type: "CAROUSEL_ALBUM",
          media_product_type: "FEED",
          timestamp: "2026-08-11T15:00:00+0000",
        })],
      },
    ], {
      "7001": insightSet(),
      "7002": insightSet({ reach: 800, total_interactions: 90 }),
    });
    const context = createService(reader);
    await expect(context.ingestion.run(request)).resolves.toMatchObject({
      pagesRead: 2,
      contentsRead: 2,
      rowsWritten: 2,
    });
    expect(reader.pageQueries.map((query) => query.after)).toEqual([undefined, "cursor-2"]);
    expect(reader.insightQueries.map((query) => query.content.contentId)).toEqual(["7001", "7002"]);
    const rows = await context.historical.list(tenantA, {
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      level: "content",
    });
    expect(rows.map((row) => row.contentId)).toEqual(["7001", "7002"]);
    expect(rows[1]?.contentType).toBe("carousel");
    await expect(context.historical.list(tenantB, {
      startDate: "2026-08-01",
      endDate: "2026-08-31",
    })).resolves.toEqual([]);
  });

  it("rejects cross-tenant access before discovery or storage", async () => {
    const reader = new SyntheticContentReader([{ data: [] }], {});
    const context = createService(reader, tenantB);
    await expect(context.ingestion.run(request)).rejects.toThrow("not assigned");
    expect(reader.pageQueries).toEqual([]);
    expect(reader.insightQueries).toEqual([]);
    await expect(context.historical.list(tenantA, {
      startDate: "2026-08-01",
      endDate: "2026-08-31",
    })).resolves.toEqual([]);
  });

  it("fails closed on duplicate IDs, out-of-window timestamps, and response budgets", async () => {
    const duplicate = new SyntheticContentReader([{ data: [content(), content()] }], {});
    await expect(createService(duplicate).ingestion.run(request)).rejects.toThrow("repeated a contentId");

    const outside = new SyntheticContentReader([{ data: [content({
      timestamp: "2026-09-01T00:00:00+0000",
    })] }], {});
    await expect(createService(outside).ingestion.run(request)).rejects.toThrow("outside");

    const oversized = new SyntheticContentReader([{ data: [content(), content({ id: "7002" })] }], {});
    const context = createService(oversized);
    await expect(context.ingestion.run({ ...request, maxContent: 1 })).rejects.toThrow("maxContent");
    await expect(context.historical.list(tenantA, {
      startDate: "2026-08-01",
      endDate: "2026-08-31",
    })).resolves.toEqual([]);
  });

  it("derives interactions only when total_interactions is unavailable", () => {
    const row = normalizeInstagramContentInsights(
      normalizeInstagramContent(content()),
      [insight("likes", 10), insight("comments", 2), insight("shares", 3), insight("saved", 4)],
      {
        asset,
        apiVersion: "v25.0",
        extractedAt: "2026-08-30T12:00:00.000Z",
        runId: "synthetic",
      },
    );
    expect(row.metrics.interactions).toBe(19);
    expect(row.quality).toBe("partial");
  });
});

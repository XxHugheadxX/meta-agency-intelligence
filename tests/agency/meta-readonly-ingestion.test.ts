import { describe, expect, it } from "vitest";
import type { MetaApiResponse } from "../../src/meta/types/common.js";
import {
  AgencyInsightsIngestionService,
  InMemoryIngestionAssetPolicy,
  InMemoryIngestionCheckpointRepository,
  MetaAdsInsightsReader,
  normalizeMetaInsight,
  type InsightsPageQuery,
  type InsightsPageReader,
  type MetaInsightRecord,
  type ReadOnlyMetaClient,
} from "../../src/agency/ingestion/index.js";
import { InMemoryHistoricalDataRepository } from "../../src/agency/historical-data/index.js";
import { tenantA, tenantB } from "./fixtures.js";

const account = {
  accountId: "act_100",
  accountName: "Inmobiliaria Norte",
  currency: "BOB",
  timezone: "America/La_Paz",
  agentId: "agent-ana",
  agentName: "Ana",
} as const;

function insight(overrides: Partial<MetaInsightRecord> = {}): MetaInsightRecord {
  return {
    account_id: "100",
    account_name: "Inmobiliaria Norte",
    campaign_id: "campaign-100",
    campaign_name: "Captación Norte",
    adset_id: "adset-100",
    adset_name: "La Paz",
    ad_id: "ad-100",
    ad_name: "Departamento Centro",
    date_start: "2026-08-10",
    date_stop: "2026-08-10",
    spend: "100",
    reach: "1000",
    impressions: "2000",
    clicks: "100",
    actions: [
      { action_type: "onsite_conversion.messaging_first_reply", value: "10" },
      { action_type: "onsite_conversion.messaging_conversation_started_7d", value: "8" },
      { action_type: "lead", value: "5" },
    ],
    conversions: [{ action_type: "purchase", value: "2" }],
    ...overrides,
  };
}

class SequenceReader implements InsightsPageReader {
  readonly queries: InsightsPageQuery[] = [];

  constructor(private readonly pages: readonly MetaApiResponse<MetaInsightRecord>[]) {}

  async readPage(query: InsightsPageQuery): Promise<MetaApiResponse<MetaInsightRecord>> {
    this.queries.push(structuredClone(query));
    const page = this.pages[this.queries.length - 1];
    if (!page) throw new Error("synthetic reader exhausted");
    return structuredClone(page);
  }
}

function service(
  reader: InsightsPageReader,
  historical = new InMemoryHistoricalDataRepository(),
  checkpoints = new InMemoryIngestionCheckpointRepository(),
  policy = new InMemoryIngestionAssetPolicy(),
) {
  policy.allow(tenantA, account.accountId);
  return {
    historical,
    checkpoints,
    policy,
    ingestion: new AgencyInsightsIngestionService(
      reader,
      historical,
      checkpoints,
      policy,
      () => "2026-08-27T12:00:00.000Z",
    ),
  };
}

const request = {
  scope: tenantA,
  account,
  startDate: "2026-08-01",
  endDate: "2026-08-10",
  level: "ad" as const,
  apiVersion: "v25.0",
  attributionWindow: "7d_click",
  breakdowns: ["age", "country"],
  runId: "synthetic-run-1",
};

describe("Meta read-only ingestion", () => {
  it("builds a bounded GET-only Ads Insights request", async () => {
    const calls: Array<{ path: string; params?: Readonly<Record<string, unknown>> }> = [];
    const client: ReadOnlyMetaClient = {
      async get<T>(path: string, params?: Readonly<Record<string, string | number | boolean | undefined>>) {
        calls.push({ path, params });
        return { data: [] } as T;
      },
    };
    const reader = new MetaAdsInsightsReader(client);
    await reader.readPage({
      account,
      startDate: "2026-08-01",
      endDate: "2026-08-10",
      level: "ad_set",
      attributionWindow: "7d_click",
      breakdowns: ["country", "age", "age"],
      pageSize: 100,
      after: "cursor-1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/act_100/insights");
    expect(calls[0].params).toMatchObject({
      level: "adset",
      time_increment: 1,
      limit: 100,
      after: "cursor-1",
      breakdowns: "age,country",
      action_attribution_windows: '["7d_click"]',
      use_unified_attribution_setting: true,
    });
    expect(String(calls[0].params?.fields)).not.toContain("access_token");
  });

  it("paginates, normalizes calculated metrics, redacts raw secrets, and advances its checkpoint", async () => {
    const reader = new SequenceReader([
      {
        data: [insight({ age: "25-34", country: "BO" })],
        paging: { cursors: { after: "cursor-2" }, next: "synthetic-next" },
      },
      {
        data: [insight({ ad_id: "ad-200", ad_name: "Casa Sur", date_start: "2026-08-11", date_stop: "2026-08-11", access_token: "synthetic-sensitive-value" })],
      },
    ]);
    const context = service(reader);
    const result = await context.ingestion.run({ ...request, endDate: "2026-08-11" });

    expect(result).toMatchObject({ rowsWritten: 2, pagesRead: 2, watermarkDate: "2026-08-11" });
    expect(reader.queries.map((query) => query.after)).toEqual([undefined, "cursor-2"]);
    const rows = await context.historical.list(tenantA, { startDate: "2026-08-01", endDate: "2026-08-31" });
    expect(rows).toHaveLength(2);
    expect(rows[0].metrics).toMatchObject({
      spend: 100,
      impressions: 2_000,
      clicks: 100,
      messages: 10,
      conversations: 8,
      leads: 5,
      conversions: 2,
      ctr: 5,
      cpc: 1,
      cpm: 50,
      cpl: 20,
      frequency: 2,
    });
    expect((rows[1].rawData.payload as Record<string, unknown>).access_token).toBe("[REDACTED]");
    await expect(context.checkpoints.get(tenantA, {
      accountId: account.accountId,
      level: "ad",
      attributionWindow: "7d_click",
      breakdowns: ["country", "age"],
      apiVersion: "v25.0",
    })).resolves.toMatchObject({ watermarkDate: "2026-08-11", rowsWritten: 2 });
  });

  it("reprocesses a bounded attribution lookback on incremental runs", async () => {
    const firstReader = new SequenceReader([{ data: [insight()] }]);
    const context = service(firstReader);
    await context.ingestion.run({ ...request, endDate: "2026-08-10", mode: "incremental" });

    const nextReader = new SequenceReader([{ data: [] }]);
    const incremental = new AgencyInsightsIngestionService(
      nextReader,
      context.historical,
      context.checkpoints,
      context.policy,
      () => "2026-08-28T12:00:00.000Z",
    );
    const result = await incremental.run({
      ...request,
      endDate: "2026-08-15",
      mode: "incremental",
      lookbackDays: 3,
      runId: "synthetic-run-2",
    });

    expect(result.effectiveStartDate).toBe("2026-08-08");
    expect(nextReader.queries[0]).toMatchObject({ startDate: "2026-08-08", endDate: "2026-08-15" });
  });

  it("rejects a cross-tenant account before any Meta call or storage access", async () => {
    const reader = new SequenceReader([{ data: [insight()] }]);
    const historical = new InMemoryHistoricalDataRepository();
    const checkpoints = new InMemoryIngestionCheckpointRepository();
    const policy = new InMemoryIngestionAssetPolicy();
    policy.allow(tenantB, account.accountId);
    const ingestion = new AgencyInsightsIngestionService(reader, historical, checkpoints, policy);

    await expect(ingestion.run(request)).rejects.toThrow("not assigned");
    expect(reader.queries).toEqual([]);
    await expect(historical.list(tenantA, { startDate: "2026-08-01", endDate: "2026-08-31" })).resolves.toEqual([]);
  });

  it("does not advance the checkpoint when pagination is malformed", async () => {
    const reader = new SequenceReader([
      { data: [insight()], paging: { next: "synthetic-next" } },
    ]);
    const context = service(reader);

    await expect(context.ingestion.run(request)).rejects.toThrow("without an after cursor");
    await expect(context.checkpoints.get(tenantA, {
      accountId: account.accountId,
      level: "ad",
      attributionWindow: "7d_click",
      breakdowns: ["age", "country"],
      apiVersion: "v25.0",
    })).resolves.toBeNull();
  });

  it("replays a partially persisted run without creating duplicates", async () => {
    class FailingSecondPageReader extends SequenceReader {
      override async readPage(query: InsightsPageQuery) {
        if (this.queries.length === 1) throw new Error("synthetic transport failure");
        return super.readPage(query);
      }
    }
    const historical = new InMemoryHistoricalDataRepository();
    const checkpoints = new InMemoryIngestionCheckpointRepository();
    const policy = new InMemoryIngestionAssetPolicy();
    policy.allow(tenantA, account.accountId);
    const failing = new FailingSecondPageReader([
      { data: [insight()], paging: { cursors: { after: "cursor-2" }, next: "next" } },
    ]);
    const first = new AgencyInsightsIngestionService(failing, historical, checkpoints, policy);
    await expect(first.run(request)).rejects.toThrow("transport failure");

    const retryReader = new SequenceReader([
      { data: [insight()], paging: { cursors: { after: "cursor-2" }, next: "next" } },
      { data: [insight({ ad_id: "ad-200", ad_name: "Casa Sur" })] },
    ]);
    const retry = new AgencyInsightsIngestionService(retryReader, historical, checkpoints, policy);
    await retry.run({ ...request, runId: "synthetic-retry" });
    await expect(historical.list(tenantA, { startDate: "2026-08-01", endDate: "2026-08-31" })).resolves.toHaveLength(2);
  });

  it("fails closed on mismatched accounts, invalid values, and pagination loops", async () => {
    expect(() => normalizeMetaInsight(insight({ account_id: "200" }), {
      account,
      level: "ad",
      attributionWindow: null,
      breakdowns: [],
      apiVersion: "v25.0",
      extractedAt: "2026-08-27T12:00:00.000Z",
      runId: "run",
      pageNumber: 1,
    })).toThrow("does not match");
    expect(() => normalizeMetaInsight(insight({ spend: "not-a-number" }), {
      account,
      level: "ad",
      attributionWindow: null,
      breakdowns: [],
      apiVersion: "v25.0",
      extractedAt: "2026-08-27T12:00:00.000Z",
      runId: "run",
      pageNumber: 1,
    })).toThrow("spend");

    const reader = new SequenceReader([
      { data: [], paging: { cursors: { after: "same" }, next: "next" } },
      { data: [], paging: { cursors: { after: "same" }, next: "next" } },
    ]);
    await expect(service(reader).ingestion.run(request)).rejects.toThrow("repeated an after cursor");
  });

  it("enforces row budgets before persisting an oversized page", async () => {
    const reader = new SequenceReader([{ data: [insight(), insight({ ad_id: "ad-200" })] }]);
    const context = service(reader);
    await expect(context.ingestion.run({ ...request, maxRows: 1 })).rejects.toThrow("maxRows");
    await expect(context.historical.list(tenantA, { startDate: "2026-08-01", endDate: "2026-08-31" })).resolves.toEqual([]);
  });

  it("keeps watermarks monotonic and skips stale incremental windows", async () => {
    const context = service(new SequenceReader([{ data: [insight()] }]));
    await context.ingestion.run({ ...request, endDate: "2026-08-20", mode: "incremental" });
    const staleReader = new SequenceReader([]);
    const stale = new AgencyInsightsIngestionService(
      staleReader,
      context.historical,
      context.checkpoints,
      context.policy,
      () => "2026-08-29T12:00:00.000Z",
    );
    const result = await stale.run({
      ...request,
      endDate: "2026-08-15",
      mode: "incremental",
      lookbackDays: 2,
      runId: "stale-run",
    });

    expect(result).toMatchObject({ pagesRead: 0, rowsWritten: 0, watermarkDate: "2026-08-20" });
    expect(staleReader.queries).toEqual([]);
  });

  it("rejects rows outside the requested date window before persistence", async () => {
    const context = service(new SequenceReader([{
      data: [insight({ date_start: "2026-08-31", date_stop: "2026-08-31" })],
    }]));
    await expect(context.ingestion.run(request)).rejects.toThrow("outside");
    await expect(context.historical.list(tenantA, { startDate: "2026-08-01", endDate: "2026-08-31" })).resolves.toEqual([]);
  });

  it("isolates checkpoints by tenant/workspace and rejects scope substitution", async () => {
    const checkpoints = new InMemoryIngestionCheckpointRepository();
    const key = {
      accountId: account.accountId,
      level: "ad" as const,
      attributionWindow: "7d_click",
      breakdowns: ["age"],
      apiVersion: "v25.0",
    };
    await checkpoints.save(tenantA, {
      ...tenantA,
      ...key,
      watermarkDate: "2026-08-20",
      completedAt: "2026-08-27T12:00:00.000Z",
      rowsWritten: 1,
    });

    await expect(checkpoints.get(tenantA, key)).resolves.toMatchObject({ tenantId: "tenant-a" });
    await expect(checkpoints.get(tenantB, key)).resolves.toBeNull();
    await expect(checkpoints.save(tenantA, {
      ...tenantB,
      ...key,
      watermarkDate: "2026-08-20",
      completedAt: "2026-08-27T12:00:00.000Z",
      rowsWritten: 1,
    })).rejects.toThrow("scope");
  });
});

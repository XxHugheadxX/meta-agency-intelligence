import { describe, expect, it } from "vitest";
import type { MetaApiResponse } from "../../src/meta/types/common.js";
import {
  AgencyInsightsIngestionService,
  AgencyReadOnlyReportingPipeline,
  AgencyReportingService,
  EXCEL_REPORT_SHEETS,
  InMemoryHistoricalDataRepository,
  InMemoryIngestionAssetPolicy,
  InMemoryIngestionCheckpointRepository,
  type InsightsPageQuery,
  type InsightsPageReader,
  type MetaInsightRecord,
} from "../../src/agency/index.js";
import { tenantA } from "./fixtures.js";

class SyntheticMetaReader implements InsightsPageReader {
  readonly queries: InsightsPageQuery[] = [];

  constructor(private readonly pages: readonly MetaApiResponse<MetaInsightRecord>[]) {}

  async readPage(query: InsightsPageQuery): Promise<MetaApiResponse<MetaInsightRecord>> {
    this.queries.push(structuredClone(query));
    const page = this.pages[this.queries.length - 1];
    if (!page) throw new Error("Synthetic Meta fixture exhausted");
    return structuredClone(page);
  }
}

function unzipStored(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries = new Map<string, string>();
  let offset = 0;
  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const start = offset + 30;
    const name = decoder.decode(bytes.slice(start, start + nameLength));
    const contentStart = start + nameLength + extraLength;
    entries.set(name, decoder.decode(bytes.slice(contentStart, contentStart + size)));
    offset = contentStart + size;
  }
  return entries;
}

function insight(overrides: Partial<MetaInsightRecord> = {}): MetaInsightRecord {
  return {
    account_id: "100",
    account_name: "Inmobiliaria Norte",
    campaign_id: "campaign-100",
    campaign_name: "Captación de propiedades",
    adset_id: "adset-100",
    adset_name: "La Paz 25-44",
    ad_id: "ad-100",
    ad_name: "Departamento Centro",
    date_start: "2026-08-10",
    date_stop: "2026-08-10",
    spend: "120",
    reach: "1500",
    impressions: "2400",
    clicks: "120",
    actions: [
      { action_type: "onsite_conversion.messaging_first_reply", value: "18" },
      { action_type: "lead", value: "6" },
    ],
    conversions: [{ action_type: "purchase", value: "2" }],
    ...overrides,
  };
}

describe("read-only reporting MVP end-to-end", () => {
  it("turns synthetic Meta Insights into tenant-safe history, analysis, and professional XLSX", async () => {
    const reader = new SyntheticMetaReader([{
      data: [
        insight(),
        insight({
          ad_id: "ad-101",
          ad_name: "Casa Zona Sur",
          date_start: "2026-08-11",
          date_stop: "2026-08-11",
          spend: "80",
          reach: "900",
          impressions: "1600",
          clicks: "64",
          actions: [{ action_type: "lead", value: "4" }],
        }),
      ],
    }]);
    const historical = new InMemoryHistoricalDataRepository();
    const checkpoints = new InMemoryIngestionCheckpointRepository();
    const policy = new InMemoryIngestionAssetPolicy();
    policy.allow(tenantA, "act_100");
    const ingestion = new AgencyInsightsIngestionService(
      reader,
      historical,
      checkpoints,
      policy,
      () => "2026-08-17T08:00:00.000Z",
    );
    const pipeline = new AgencyReadOnlyReportingPipeline(
      ingestion,
      new AgencyReportingService(historical),
    );

    const result = await pipeline.run({
      ingestion: {
        scope: tenantA,
        account: {
          accountId: "act_100",
          accountName: "Inmobiliaria Norte",
          currency: "BOB",
          timezone: "America/La_Paz",
          agentId: "agent-ana",
          agentName: "Ana",
        },
        startDate: "2026-08-10",
        endDate: "2026-08-16",
        level: "ad",
        apiVersion: "v25.0",
        mode: "backfill",
        runId: "mvp-week-2026-08-10",
      },
      period: { kind: "week", startDate: "2026-08-10", endDate: "2026-08-16" },
      excel: {
        generatedAt: "2026-08-17T08:00:00.000Z",
        filename: "inmobiliaria-norte-semanal-2026-08-10.xlsx",
      },
    });

    expect(reader.queries).toHaveLength(1);
    expect(result.ingestion).toMatchObject({ rowsWritten: 2, pagesRead: 1 });
    expect(result.report.scope).toEqual(tenantA);
    expect(result.report.current.metrics).toMatchObject({
      spend: 200,
      reach: 2400,
      impressions: 4000,
      clicks: 184,
      messages: 18,
      leads: 10,
      ctr: 4.6,
      cpl: 20,
    });
    expect(result.excel.filename).toBe("inmobiliaria-norte-semanal-2026-08-10.xlsx");
    expect(result.excel.bytes.slice(0, 2)).toEqual(Uint8Array.of(0x50, 0x4b));
    const workbook = unzipStored(result.excel.bytes).get("xl/workbook.xml") ?? "";
    expect(EXCEL_REPORT_SHEETS.every((sheet) => workbook.includes(`name=\"${sheet}\"`))).toBe(true);
    const serialized = new TextDecoder().decode(result.excel.bytes);
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain(tenantA.tenantId);
    await expect(historical.list(tenantA, {
      startDate: "2026-08-10",
      endDate: "2026-08-16",
    })).resolves.toHaveLength(2);
  });

  it("rejects a report period not covered by the bounded ingestion window", async () => {
    const historical = new InMemoryHistoricalDataRepository();
    const policy = new InMemoryIngestionAssetPolicy();
    policy.allow(tenantA, "act_100");
    const pipeline = new AgencyReadOnlyReportingPipeline(
      new AgencyInsightsIngestionService(
        new SyntheticMetaReader([]),
        historical,
        new InMemoryIngestionCheckpointRepository(),
        policy,
      ),
      new AgencyReportingService(historical),
    );

    await expect(pipeline.run({
      ingestion: {
        scope: tenantA,
        account: {
          accountId: "act_100",
          accountName: "Inmobiliaria Norte",
          currency: "BOB",
          timezone: "America/La_Paz",
        },
        startDate: "2026-08-12",
        endDate: "2026-08-12",
        level: "ad",
        apiVersion: "v25.0",
      },
      period: { kind: "week", startDate: "2026-08-10", endDate: "2026-08-16" },
    })).rejects.toThrow("fully cover");
  });
});

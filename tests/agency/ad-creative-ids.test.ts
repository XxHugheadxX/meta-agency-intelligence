import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryHistoricalDataRepository } from "../../src/agency/historical-data/index.js";
import {
  AgencyInsightsIngestionService,
  InMemoryIngestionAssetPolicy,
  InMemoryIngestionCheckpointRepository,
  MetaAdCreativeReader,
  resolveAdCreativeIds,
  type AdCreativeReader,
  type AdCreativeRecord,
  type IngestionAccount,
  type MetaInsightRecord,
} from "../../src/agency/ingestion/index.js";
import { analyzeSegmentation } from "../../src/agency/segmentation/index.js";
import { resolveReportingJobRuntimeConfig } from "../../src/agency/worker/index.js";
import type { MetaApiResponse } from "../../src/meta/types/common.js";
import { tenantA } from "./fixtures.js";

const account: IngestionAccount = {
  accountId: "act_100",
  accountName: "Inmobiliaria Norte",
  currency: "BOB",
  timezone: "America/La_Paz",
};
const NOW = "2026-08-17T08:00:00.000Z";

function creativeReader(
  respond: (adIds: readonly string[]) => MetaApiResponse<AdCreativeRecord>,
): AdCreativeReader & { readonly calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async read(query) {
      calls.push([...query.adIds]);
      return respond(query.adIds);
    },
  };
}

function insight(adId: string, date: string): MetaInsightRecord {
  return {
    account_id: "100", account_name: "Inmobiliaria Norte",
    campaign_id: "9001", campaign_name: "Captación",
    adset_id: "8001", adset_name: "La Paz",
    ad_id: adId, ad_name: `Anuncio ${adId}`,
    date_start: date, date_stop: date,
    spend: "50", reach: "500", impressions: "1000", clicks: "20",
  };
}

async function ingest(
  pages: readonly MetaApiResponse<MetaInsightRecord>[],
  adCreatives?: AdCreativeReader,
  level: "ad" | "campaign" = "ad",
) {
  const historical = new InMemoryHistoricalDataRepository();
  const policy = new InMemoryIngestionAssetPolicy();
  policy.allow(tenantA, account.accountId);
  let index = 0;
  const service = new AgencyInsightsIngestionService(
    { async readPage() { return pages[index++]; } },
    historical,
    new InMemoryIngestionCheckpointRepository(),
    policy,
    () => NOW,
    adCreatives,
  );
  await service.run({
    scope: tenantA, account, startDate: "2026-08-10", endDate: "2026-08-16",
    level, apiVersion: "v23.0",
  });
  return historical.list(tenantA, { startDate: "2026-08-10", endDate: "2026-08-16" });
}

describe("ad creative lookup", () => {
  it("asks the account's ads edge only for the requested ads", async () => {
    const requests: Array<{ path: string; params: unknown }> = [];
    await new MetaAdCreativeReader({
      async get<T>(path: string, params?: unknown) {
        requests.push({ path, params });
        return { data: [] } as T;
      },
    }).read({ account, adIds: ["7001", "7002"] });
    expect(requests).toEqual([{
      path: "/act_100/ads",
      params: {
        fields: "id,account_id,creative{id}",
        filtering: JSON.stringify([{ field: "id", operator: "IN", value: ["7001", "7002"] }]),
        limit: 2,
      },
    }]);
  });

  it.each([
    ["no ads", []],
    ["a non-numeric ad id", ["ad-1"]],
    ["more than 50 ads", Array.from({ length: 51 }, (_value, index) => String(1000 + index))],
  ])("refuses a request with %s", async (_name, adIds) => {
    const reader = new MetaAdCreativeReader({ async get<T>() { return { data: [] } as T; } });
    await expect(reader.read({ account, adIds })).rejects.toThrow("1 to 50 numeric ad IDs");
  });

  it("batches distinct ads in groups of 50 and never asks twice for the same ad", async () => {
    const reader = creativeReader((adIds) => ({
      data: adIds.map((id) => ({ id, account_id: "100", creative: { id: `9${id}` } })),
    }));
    const known = new Map<string, string | null>();
    const adIds = Array.from({ length: 120 }, (_value, index) => String(1000 + index));
    await resolveAdCreativeIds(reader, account, [...adIds, ...adIds], known);
    await resolveAdCreativeIds(reader, account, adIds, known);
    expect(reader.calls.map((call) => call.length)).toEqual([50, 50, 20]);
    expect(known.get("1000")).toBe("91000");
    expect(known.size).toBe(120);
  });

  it("records null for an ad Meta does not return or that has no creative", async () => {
    const reader = creativeReader(() => ({ data: [{ id: "7002", account_id: "100", creative: null }] }));
    const known = new Map<string, string | null>();
    await resolveAdCreativeIds(reader, account, ["7001", "7002"], known);
    expect([...known]).toEqual([["7001", null], ["7002", null]]);
  });

  it.each([
    ["an ad that was not requested", { data: [{ id: "9999", creative: { id: "1" } }] }],
    ["the same ad twice", { data: [{ id: "7001", creative: { id: "1" } }, { id: "7001", creative: { id: "2" } }] }],
    ["an ad from another account", { data: [{ id: "7001", account_id: "999", creative: { id: "1" } }] }],
    ["a non-numeric creative id", { data: [{ id: "7001", creative: { id: "creative-x" } }] }],
    ["a paginated response", { data: [{ id: "7001", creative: { id: "1" } }], paging: { next: "https://graph.facebook.com/next" } }],
    ["a non-array payload", { data: null }],
  ])("fails closed on %s", async (_name, page) => {
    const known = new Map<string, string | null>();
    await expect(resolveAdCreativeIds(
      creativeReader(() => page as MetaApiResponse<AdCreativeRecord>), account, ["7001", "7002"], known,
    )).rejects.toThrow();
    expect(known.size).toBe(0);
  });
});

describe("creative IDs in ad-level ingestion", () => {
  const pages = [
    { data: [insight("7001", "2026-08-10"), insight("7002", "2026-08-10")], paging: { cursors: { after: "next" } } },
    { data: [insight("7001", "2026-08-11"), insight("7003", "2026-08-11")] },
  ];

  it("stores each ad's real creative and leaves unknown ads empty instead of using the ad ID", async () => {
    const reader = creativeReader((adIds) => ({
      data: adIds.filter((id) => id !== "7003").map((id) => ({ id, account_id: "100", creative: { id: "5550" } })),
    }));
    const rows = await ingest(pages, reader);
    expect(reader.calls).toEqual([["7001", "7002"], ["7003"]]);
    expect(Object.fromEntries(rows.map((row) => [`${row.adId}@${row.date}`, row.creativeId]))).toEqual({
      "7001@2026-08-10": "5550",
      "7002@2026-08-10": "5550",
      "7001@2026-08-11": "5550",
      "7003@2026-08-11": null,
    });
    const creative = analyzeSegmentation(tenantA, rows, { dimensions: ["creative"] });
    expect(creative.performances).toMatchObject([{ segmentId: "5550", rowCount: 3 }]);
  });

  it("makes no lookup and stores no creative when the feature is off", async () => {
    const rows = await ingest(pages);
    expect(rows.every((row) => row.creativeId === null)).toBe(true);
    expect(analyzeSegmentation(tenantA, rows).unavailableDimensions).toContain("creative");
  });

  it("makes no lookup for levels above the ad", async () => {
    const reader = creativeReader(() => ({ data: [] }));
    await ingest([{ data: [insight("7001", "2026-08-10")] }], reader, "campaign");
    expect(reader.calls).toEqual([]);
  });

  it("fails the ingestion when the creative lookup is inconsistent", async () => {
    const reader = creativeReader(() => ({ data: [{ id: "1", creative: { id: "2" } }] }));
    await expect(ingest(pages, reader)).rejects.toThrow("not requested");
  });
});

describe("ad creative configuration", () => {
  const security = {
    metaAppConfigured: true, allowlistConfigured: true, multiTenantEnabled: true,
    mcpMode: "read_only" as const, allowLeadPii: false,
  };
  const publicKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .publicKey.export({ type: "spki", format: "pem" }).toString();
  const env = (value?: string): NodeJS.ProcessEnv => ({
    AGENCY_REPORTING_JOBS_ENABLED: "true",
    AGENCY_SCHEDULER_AUDIENCE: "https://service.example.test/internal/agency/reporting/jobs",
    AGENCY_SCHEDULER_SERVICE_ACCOUNT: "scheduler@example.iam.gserviceaccount.com",
    AGENCY_SCHEDULER_SUBJECT: "123456789012345678901",
    AGENCY_REPORTING_JOB_PUBLIC_KEY: publicKey,
    REPORTS_GCS_BUCKET: "private-agency-reports",
    FIRESTORE_PROJECT_ID: "agency-project",
    ...(value === undefined ? {} : { AGENCY_REPORTING_AD_CREATIVES_ENABLED: value }),
  });

  it("is off unless explicitly enabled and rejects ambiguous values", () => {
    expect(resolveReportingJobRuntimeConfig(security, env())).toMatchObject({ adCreativesEnabled: false });
    expect(resolveReportingJobRuntimeConfig(security, env("true"))).toMatchObject({ adCreativesEnabled: true });
    expect(() => resolveReportingJobRuntimeConfig(security, env("1"))).toThrow("true or false");
  });
});

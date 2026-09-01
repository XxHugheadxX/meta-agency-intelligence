import { beforeAll, describe, expect, it } from "vitest";
import { requestContext } from "../../src/auth/token-store.js";
import {
  MetaAdsInsightsReader,
  normalizeMetaInsight,
  type IngestionAccount,
} from "../../src/agency/ingestion/index.js";
import { MetaApiClient } from "../../src/meta/client.js";

const enabled = process.env.RUN_META_ADS_CONTRACT_TESTS === "true";
const contractDescribe = enabled ? describe : describe.skip;

const accessToken = process.env.META_ADS_CONTRACT_ACCESS_TOKEN?.trim() ?? "";
const accountId = process.env.META_ADS_CONTRACT_ACCOUNT_ID?.trim() ?? "";
const apiVersion = process.env.META_ADS_CONTRACT_API_VERSION?.trim() || "v25.0";
const startDate = process.env.META_ADS_CONTRACT_START_DATE?.trim() ?? "";
const endDate = process.env.META_ADS_CONTRACT_END_DATE?.trim() ?? "";

interface MetaAdAccountMetadata {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly currency?: unknown;
  readonly timezone_name?: unknown;
}

function assertConfiguration(): void {
  if (!accessToken) throw new Error("META_ADS_CONTRACT_ACCESS_TOKEN is required");
  if (!/^act_\d{1,32}$/.test(accountId)) {
    throw new Error("META_ADS_CONTRACT_ACCOUNT_ID must use act_<digits>");
  }
  if (!/^v\d+\.\d+$/.test(apiVersion)) {
    throw new Error("META_ADS_CONTRACT_API_VERSION is invalid");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error("META_ADS_CONTRACT_START_DATE and META_ADS_CONTRACT_END_DATE are required ISO dates");
  }
  if (startDate > endDate) throw new Error("Meta Ads contract start date must not exceed end date");
}

function requiredMetadata(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Meta Ads test account did not return ${field}`);
  }
  return value;
}

contractDescribe.sequential("Meta Ads Test App read-only contract", () => {
  beforeAll(assertConfiguration);

  const client = new MetaApiClient({
    apiVersion,
    mode: "read_only",
    timeout: 15_000,
    maxRetries: 0,
  });
  const reader = new MetaAdsInsightsReader(client);

  function runInTestWorkspace<T>(operation: () => Promise<T>): Promise<T> {
    return requestContext.run({
      accessToken,
      tenantId: "meta-ads-contract-tenant",
      workspaceId: "meta-ads-contract-workspace",
      allowedAccountIds: new Set([accountId]),
      allowedAssetIds: new Set([accountId]),
      allowedPageIds: new Set<string>(),
      allowedInstagramIds: new Set<string>(),
    }, operation);
  }

  it("reads account metadata and daily account-level insights without write operations", async () => {
    const metadata = await runInTestWorkspace(() => client.get<MetaAdAccountMetadata>(
      `/${accountId}`,
      { fields: "id,name,currency,timezone_name" },
    ));
    const account: IngestionAccount = {
      accountId,
      accountName: requiredMetadata(metadata.name, "name"),
      currency: requiredMetadata(metadata.currency, "currency"),
      timezone: requiredMetadata(metadata.timezone_name, "timezone_name"),
    };

    const response = await runInTestWorkspace(() => reader.readPage({
      account,
      startDate,
      endDate,
      level: "account",
      attributionWindow: null,
      breakdowns: [],
      pageSize: 25,
    }));

    expect(Array.isArray(response.data)).toBe(true);
    for (const [index, record] of response.data.entries()) {
      const normalized = normalizeMetaInsight(record, {
        account,
        level: "account",
        attributionWindow: null,
        breakdowns: [],
        apiVersion,
        extractedAt: new Date().toISOString(),
        runId: "meta-ads-contract",
        pageNumber: 1,
      });
      expect(normalized.accountId).toBe(accountId);
      expect(normalized.date >= startDate && normalized.date <= endDate).toBe(true);
      expect(index).toBeLessThan(25);
    }
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Firestore } from "@google-cloud/firestore";
import {
  createFirestoreReadOnlyReportingPipeline,
  InMemoryIngestionAssetPolicy,
  type InsightsPageQuery,
  type InsightsPageReader,
  type MetaInsightRecord,
} from "../../src/agency/index.js";
import type { MetaApiResponse } from "../../src/meta/types/common.js";

function isLocalEmulator(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = host.replace(/^https?:\/\//, "").split(":")[0].toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1";
}

class SinglePageReader implements InsightsPageReader {
  calls = 0;

  async readPage(_query: InsightsPageQuery): Promise<MetaApiResponse<MetaInsightRecord>> {
    this.calls += 1;
    return {
      data: [{
        account_id: "500",
        account_name: "Inmobiliaria Emulator",
        campaign_id: "campaign-500",
        campaign_name: "Captación",
        adset_id: "adset-500",
        adset_name: "La Paz",
        ad_id: "ad-500",
        ad_name: "Propiedad",
        date_start: "2026-08-24",
        date_stop: "2026-08-24",
        spend: "70",
        reach: "700",
        impressions: "1000",
        clicks: "50",
        actions: [{ action_type: "lead", value: "7" }],
      }],
    };
  }
}

const describeEmulator = isLocalEmulator(process.env.FIRESTORE_EMULATOR_HOST)
  ? describe
  : describe.skip;

describeEmulator("Firestore read-only reporting pipeline integration", () => {
  const scope = {
    tenantId: `emulator-report-${randomUUID()}`,
    workspaceId: "workspace-report",
  };
  let db: Firestore;

  beforeAll(() => {
    db = new Firestore({
      projectId: "meta-agency-emulator",
      ignoreUndefinedProperties: true,
    });
  });

  afterAll(async () => {
    await db.recursiveDelete(db.collection("agency_tenants").doc(scope.tenantId));
    await db.terminate();
  });

  it("persists Meta rows and produces the XLSX from Firestore-backed history", async () => {
    const reader = new SinglePageReader();
    const policy = new InMemoryIngestionAssetPolicy();
    policy.allow(scope, "act_500");
    const pipeline = createFirestoreReadOnlyReportingPipeline({
      db,
      reader,
      assetPolicy: policy,
      now: () => "2026-08-31T08:00:00.000Z",
    });

    const result = await pipeline.run({
      ingestion: {
        scope,
        account: {
          accountId: "act_500",
          accountName: "Inmobiliaria Emulator",
          currency: "BOB",
          timezone: "America/La_Paz",
        },
        startDate: "2026-08-24",
        endDate: "2026-08-30",
        level: "ad",
        apiVersion: "v25.0",
        runId: "emulator-week-2026-08-24",
      },
      period: { kind: "week", startDate: "2026-08-24", endDate: "2026-08-30" },
      excel: { generatedAt: "2026-08-31T08:00:00.000Z" },
    });

    expect(reader.calls).toBe(1);
    expect(result.report.current.metrics).toMatchObject({
      spend: 70,
      clicks: 50,
      leads: 7,
      cpl: 10,
    });
    expect(result.excel.bytes.slice(0, 2)).toEqual(Uint8Array.of(0x50, 0x4b));
    expect(new TextDecoder().decode(result.excel.bytes)).not.toContain(scope.tenantId);
  });
});

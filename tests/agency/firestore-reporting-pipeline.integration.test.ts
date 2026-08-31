import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Firestore } from "@google-cloud/firestore";
import {
  createFirestoreReadOnlyReportingPipeline,
  FirestoreReportArtifactStore,
  FirestoreReportingBatchRepository,
  InMemoryIngestionAssetPolicy,
  type ReportObjectStore,
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

  it("stores report metadata under its tenant and keeps object coordinates private", async () => {
    const objects = new Map<string, Uint8Array>();
    const objectStore: ReportObjectStore = {
      async putObject(input) {
        objects.set(input.objectKey, input.bytes.slice());
      },
      async getObject(input) {
        return objects.get(input.objectKey)?.slice() ?? null;
      },
    };
    const artifacts = new FirestoreReportArtifactStore(
      db,
      objectStore,
      () => Date.parse("2026-08-31T08:00:00.000Z"),
    );
    const stored = await artifacts.store(scope, {
      jobId: "emulator-report-delivery",
      period: { kind: "week", startDate: "2026-08-24", endDate: "2026-08-30" },
      report: {
        filename: "meta-agency-report-2026-08-24-to-2026-08-30.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        bytes: Uint8Array.of(0x50, 0x4b, 0x03, 0x04),
      },
      createdAt: "2026-08-31T08:00:00.000Z",
      retentionDays: 30,
    });

    expect(objects.size).toBe(1);
    expect([...objects.keys()][0]).not.toContain(scope.tenantId);
    await expect(artifacts.getMetadata(scope, stored.artifactId)).resolves.toEqual(stored);
    await expect(artifacts.getMetadata(
      { tenantId: `${scope.tenantId}-other`, workspaceId: scope.workspaceId },
      stored.artifactId,
    )).resolves.toBeNull();
    expect(JSON.stringify(stored)).not.toContain("objectKey");
    expect(JSON.stringify(stored)).not.toContain("bytes");
  });

  it("claims a tenant-scoped batch only after all expected accounts complete", async () => {
    const batches = new FirestoreReportingBatchRepository(
      db,
      () => Date.parse("2026-08-31T08:00:00.000Z"),
    );
    const common = {
      batchId: `batch-${"c".repeat(40)}`,
      expectedAccountIds: ["act_500", "act_600"],
      reportKind: "week" as const,
      startDate: "2026-08-24",
      endDate: "2026-08-30",
    };
    await expect(batches.record(scope, { ...common, accountId: "act_500" }))
      .resolves.toEqual({ status: "waiting" });
    const completed = await batches.record(scope, { ...common, accountId: "act_600" });
    expect(completed.status).toBe("claimed");
    if (completed.status !== "claimed") throw new Error("Expected batch claim");
    await expect(batches.complete(scope, completed.claim, "d".repeat(64))).resolves.toBe(true);
    await expect(batches.record(scope, { ...common, accountId: "act_600" }))
      .resolves.toEqual({ status: "complete" });
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Firestore } from "@google-cloud/firestore";
import {
  FirestoreHistoricalDataRepository,
  historicalMetricId,
} from "../../src/agency/historical-data/index.js";
import {
  FirestoreIngestionCheckpointRepository,
  ingestionCheckpointId,
} from "../../src/agency/ingestion/index.js";
import { metricFixture } from "./fixtures.js";

function isLocalEmulator(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = host.replace(/^https?:\/\//, "").split(":")[0].toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const describeEmulator = isLocalEmulator(emulatorHost) ? describe : describe.skip;

describeEmulator("Firestore agency ingestion integration", () => {
  const suffix = randomUUID();
  const tenantA = { tenantId: `emulator-tenant-a-${suffix}`, workspaceId: "workspace-a" };
  const tenantB = { tenantId: `emulator-tenant-b-${suffix}`, workspaceId: "workspace-b" };
  const projectId = "meta-agency-emulator";
  let db: Firestore;
  let historical: FirestoreHistoricalDataRepository;
  let checkpoints: FirestoreIngestionCheckpointRepository;

  beforeAll(() => {
    db = new Firestore({ projectId, ignoreUndefinedProperties: true });
    historical = new FirestoreHistoricalDataRepository(db);
    checkpoints = new FirestoreIngestionCheckpointRepository(db);
  });

  afterAll(async () => {
    await Promise.all([
      db.recursiveDelete(db.collection("agency_tenants").doc(tenantA.tenantId)),
      db.recursiveDelete(db.collection("agency_tenants").doc(tenantB.tenantId)),
    ]);
    await db.terminate();
  });

  it("atomically persists a batch, preserves replay identity, and isolates tenants", async () => {
    const inputs = [
      metricFixture({ accountId: "act_101", accountName: "Cuenta Uno", adId: "ad-101" }),
      metricFixture({ accountId: "act_102", accountName: "Cuenta Dos", adId: "ad-102" }),
    ];
    const first = await historical.upsertMany(tenantA, inputs);
    const replay = await historical.upsert(
      tenantA,
      metricFixture({
        accountId: "act_101",
        accountName: "Cuenta Uno",
        adId: "ad-101",
        metrics: { spend: 250 },
      }),
    );

    expect(replay.id).toBe(first[0].id);
    expect(replay.createdAt).toBe(first[0].createdAt);
    expect(replay.metrics.spend).toBe(250);
    await expect(historical.list(tenantA, {
      startDate: "2026-08-01",
      endDate: "2026-08-31",
    })).resolves.toHaveLength(2);
    await expect(historical.list(tenantB, {
      startDate: "2026-08-01",
      endDate: "2026-08-31",
    })).resolves.toEqual([]);
  });

  it("rolls back the whole batch when any row is invalid", async () => {
    const valid = metricFixture({
      accountId: "act_201",
      accountName: "Cuenta Válida",
      adId: "ad-201",
      date: "2026-08-11",
    });
    const invalid = metricFixture({
      accountId: "act_202",
      accountName: "Cuenta Inválida",
      adId: "ad-202",
      date: "2026-08-11",
      metrics: { spend: -1 },
    });

    await expect(historical.upsertMany(tenantA, [valid, invalid])).rejects.toThrow("spend");
    await expect(historical.list(tenantA, {
      startDate: "2026-08-11",
      endDate: "2026-08-11",
      accountIds: ["act_201", "act_202"],
    })).resolves.toEqual([]);
  });

  it("keeps checkpoints monotonic during concurrent writes", async () => {
    const key = {
      accountId: "act_301",
      level: "ad" as const,
      attributionWindow: "7d_click",
      breakdowns: ["age"],
      apiVersion: "v25.0",
    };
    const older = {
      ...tenantA,
      ...key,
      watermarkDate: "2026-08-19",
      completedAt: "2026-08-29T12:00:00.000Z",
      rowsWritten: 1,
    };
    const newer = {
      ...tenantA,
      ...key,
      watermarkDate: "2026-08-20",
      completedAt: "2026-08-28T12:00:00.000Z",
      rowsWritten: 2,
    };

    await Promise.all([
      checkpoints.save(tenantA, older),
      checkpoints.save(tenantA, newer),
    ]);

    await expect(checkpoints.get(tenantA, key)).resolves.toMatchObject({
      watermarkDate: "2026-08-20",
      rowsWritten: 2,
    });
    await expect(checkpoints.get(tenantB, key)).resolves.toBeNull();
  });

  it("fails closed when stored historical or checkpoint identity is corrupted", async () => {
    const input = metricFixture({
      accountId: "act_401",
      accountName: "Cuenta Corrupta",
      adId: "ad-401",
      date: "2026-08-12",
    });
    const metricId = historicalMetricId(tenantB, input);
    await db.collection("agency_tenants")
      .doc(tenantB.tenantId)
      .collection("workspaces")
      .doc(tenantB.workspaceId)
      .collection("agency_historical_metrics")
      .doc(metricId)
      .set({ ...input, ...tenantA, id: metricId });

    await expect(historical.list(tenantB, {
      startDate: "2026-08-12",
      endDate: "2026-08-12",
    })).rejects.toThrow("identity");

    const key = {
      accountId: "act_402",
      level: "ad" as const,
      attributionWindow: null,
      breakdowns: [],
      apiVersion: "v25.0",
    };
    const checkpointId = ingestionCheckpointId(tenantB, key);
    await db.collection("agency_tenants")
      .doc(tenantB.tenantId)
      .collection("workspaces")
      .doc(tenantB.workspaceId)
      .collection("ingestion_checkpoints")
      .doc(checkpointId)
      .set({
        ...tenantA,
        ...key,
        watermarkDate: "2026-08-20",
        completedAt: "2026-08-28T12:00:00.000Z",
        rowsWritten: 1,
      });

    await expect(checkpoints.get(tenantB, key)).rejects.toThrow("scope");
  });
});

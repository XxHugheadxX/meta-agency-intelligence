import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { Firestore } from "@google-cloud/firestore";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getAccessToken } from "../../src/auth/token-store.js";
import type { MetaTokenRepo } from "../../src/store/meta-token-repo.js";
import { InMemoryAssetBindingRepo } from "../../src/store/asset-binding-repo.js";
import {
  AgencyReportingWorker,
  createFirestoreAgencyReportingRuntime,
  createReportingJobHttpRouter,
  FirestoreAgencyAccountConnectionRepository,
  FirestoreAgencyControlPlaneProvisioner,
  FirestoreIngestionAuditSink,
  FirestoreReportArtifactStore,
  FirestoreReportingJobLeaseRepository,
  FirestoreTenantWorkspacePolicy,
  PublicKeyIngestionJobVerifier,
  RepositoryIngestionConnectionResolver,
  type ReadOnlyMetaClient,
  type ReportObjectStore,
} from "../../src/agency/index.js";

function isLocalEmulator(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = host.replace(/^https?:\/\//, "").split(":")[0].toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

class MemoryObjectStore implements ReportObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  async putObject(input: { objectKey: string; bytes: Uint8Array }): Promise<void> {
    this.objects.set(input.objectKey, input.bytes.slice());
  }
  async getObject(input: { objectKey: string }): Promise<Uint8Array | null> {
    return this.objects.get(input.objectKey)?.slice() ?? null;
  }
}

const describeEmulator = isLocalEmulator(process.env.FIRESTORE_EMULATOR_HOST)
  ? describe
  : describe.skip;

describeEmulator("agency reporting job synthetic end-to-end", () => {
  const suffix = randomUUID();
  const scope = { tenantId: `e2e-tenant-${suffix}`, workspaceId: `e2e-workspace-${suffix}` };
  const otherScope = { tenantId: `e2e-other-${suffix}`, workspaceId: `e2e-other-workspace-${suffix}` };
  const job = {
    ...scope,
    jobId: "weekly-report-2026-08-24",
    accountId: "act_100",
    startDate: "2026-08-24",
    endDate: "2026-08-30",
    level: "ad",
    apiVersion: "v25.0",
    mode: "incremental",
    reportKind: "week",
    reportStartDate: "2026-08-24",
    reportEndDate: "2026-08-30",
    retentionDays: 30,
  } as const;
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const identity = {
    verify: vi.fn().mockResolvedValue({
      issuer: "https://accounts.google.com",
      audience: "https://service.example.test/internal/agency/reporting/jobs",
      subject: "123456789012345678901",
      roles: ["scheduler"],
    }),
  };
  let db: Firestore;

  beforeAll(() => {
    db = new Firestore({ projectId: "meta-agency-emulator", ignoreUndefinedProperties: true });
  });

  afterAll(async () => {
    await Promise.all([
      db.recursiveDelete(db.collection("agency_tenants").doc(scope.tenantId)),
      db.recursiveDelete(db.collection("agency_tenants").doc(otherScope.tenantId)),
    ]);
    await db.terminate();
  });

  it("runs a signed job once, replays it, and isolates the resulting XLSX", async () => {
    const provisioner = new FirestoreAgencyControlPlaneProvisioner(db);
    await provisioner.provisionWorkspace({ ...scope, active: true }, "synthetic-admin");
    await provisioner.provisionAccount({
      ...scope,
      accountId: "act_100",
      accountName: "Inmobiliaria Sintética",
      currency: "BOB",
      timezone: "America/La_Paz",
      tokenName: "reporting",
      active: true,
    }, "synthetic-admin");

    const bindings = new InMemoryAssetBindingRepo();
    await bindings.save({ workspaceId: scope.workspaceId, kind: "ad_account", assetId: "act_100" });
    const token = "synthetic-server-only-token";
    const tokens = {
      resolveToken: vi.fn().mockResolvedValue({
        accessToken: token,
        workspaceId: scope.workspaceId,
        tokenName: "reporting",
        scopes: ["ads_read"],
        granularScopes: [],
        dataAccessExpiresAt: null,
        allowedAccountIds: ["act_100"],
        allowedAssetIds: [],
      }),
    } as unknown as MetaTokenRepo;
    const metaCalls: string[] = [];
    const metaClient: ReadOnlyMetaClient = {
      async get<T>(path: string) {
        metaCalls.push(path);
        expect(getAccessToken()).toBe(token);
        return { data: [{
          account_id: "100",
          account_name: "Inmobiliaria Sintética",
          campaign_id: "campaign-1",
          campaign_name: "Captación",
          adset_id: "adset-1",
          adset_name: "La Paz",
          ad_id: "ad-1",
          ad_name: "Casa familiar",
          date_start: "2026-08-24",
          date_stop: "2026-08-24",
          spend: "100",
          reach: "1000",
          impressions: "2000",
          clicks: "100",
          actions: [{ action_type: "lead", value: "10" }],
        }] } as T;
      },
    };
    const objectStore = new MemoryObjectStore();
    const artifacts = new FirestoreReportArtifactStore(db, objectStore);
    const worker = new AgencyReportingWorker(
      identity,
      new PublicKeyIngestionJobVerifier(keys.publicKey),
      new RepositoryIngestionConnectionResolver(
        new FirestoreTenantWorkspacePolicy(db),
        new FirestoreAgencyAccountConnectionRepository(db),
        bindings,
        tokens,
      ),
      createFirestoreAgencyReportingRuntime({ db, artifacts, clientFactory: () => metaClient }),
      new FirestoreIngestionAuditSink(db),
      () => "2026-08-31T08:00:00.000Z",
      { repository: new FirestoreReportingJobLeaseRepository(db), leaseTtlMs: 60_000 },
    );
    const app = express();
    app.use("/internal/agency/reporting/jobs", createReportingJobHttpRouter(worker, identity));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Smoke server did not bind");
    const payload = JSON.stringify(job);
    const signature = sign("sha256", Buffer.from(payload), keys.privateKey).toString("base64url");
    try {
      const url = `http://127.0.0.1:${address.port}/internal/agency/reporting/jobs`;
      const request = () => fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer synthetic-oidc", "Content-Type": "application/json" },
        body: JSON.stringify({ payload, signature }),
      });
      const first = await request();
      const firstBody = await first.json() as { artifactId: string; jobId: string };
      expect(first.status).toBe(200);
      expect(firstBody.jobId).toBe(job.jobId);
      expect(firstBody.artifactId).toMatch(/^[a-f0-9]{64}$/);
      const replay = await request();
      await expect(replay.json()).resolves.toEqual({ status: "completed", ...firstBody });
      expect(metaCalls).toEqual(["/act_100/insights"]);
      await expect(artifacts.getMetadata(scope, firstBody.artifactId)).resolves.toBeTruthy();
      await expect(artifacts.getMetadata(otherScope, firstBody.artifactId)).resolves.toBeNull();
      expect(JSON.stringify(firstBody)).not.toContain(token);
      expect([...objectStore.objects.values()][0]?.slice(0, 2)).toEqual(Uint8Array.of(0x50, 0x4b));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

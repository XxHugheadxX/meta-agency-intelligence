import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { getAccessToken, getTenantContext } from "../../src/auth/token-store.js";
import { InMemoryHistoricalDataRepository } from "../../src/agency/historical-data/index.js";
import {
  InMemoryIngestionCheckpointRepository,
  type ReadOnlyMetaClient,
} from "../../src/agency/ingestion/index.js";
import {
  AgencyIngestionWorker,
  InMemoryAgencyAccountConnectionRepository,
  InMemoryTenantWorkspacePolicy,
  MetaAgencyIngestionRuntime,
  PublicKeyIngestionJobVerifier,
  RepositoryIngestionConnectionResolver,
  type IngestionAuditEvent,
  type IngestionJobPayload,
  type ResolvedIngestionConnection,
} from "../../src/agency/worker/index.js";
import { InMemoryAssetBindingRepo } from "../../src/store/asset-binding-repo.js";
import type { MetaTokenRepo } from "../../src/store/meta-token-repo.js";
import { tenantA, tenantB } from "./fixtures.js";

const job: IngestionJobPayload = {
  ...tenantA,
  jobId: "job-2026-08-28-001",
  accountId: "act_100",
  startDate: "2026-08-01",
  endDate: "2026-08-10",
  level: "ad",
  apiVersion: "v25.0",
  mode: "incremental",
};

const connection: ResolvedIngestionConnection = {
  scope: tenantA,
  account: {
    accountId: "act_100",
    accountName: "Inmobiliaria Norte",
    currency: "BOB",
    timezone: "America/La_Paz",
  },
  accessToken: "synthetic-backend-only-token",
  scopes: ["ads_read"],
  allowedAccountIds: ["act_100"],
};

function harness(overrides: {
  identity?: Record<string, unknown>;
  verifiedJob?: IngestionJobPayload;
  resolved?: ResolvedIngestionConnection;
} = {}) {
  const events: IngestionAuditEvent[] = [];
  const identities = {
    verify: vi.fn().mockResolvedValue(overrides.identity ?? {
      issuer: "https://accounts.example.test",
      audience: "agency-ingestion",
      subject: "scheduler-service",
      roles: ["scheduler"],
    }),
  };
  const jobs = { verify: vi.fn().mockResolvedValue(overrides.verifiedJob ?? job) };
  const connections = { resolve: vi.fn().mockResolvedValue(overrides.resolved ?? connection) };
  const runtime = {
    run: vi.fn().mockResolvedValue({
      scope: tenantA,
      accountId: "act_100",
      requestedStartDate: job.startDate,
      effectiveStartDate: job.startDate,
      endDate: job.endDate,
      mode: "incremental",
      rowsWritten: 3,
      pagesRead: 1,
      watermarkDate: job.endDate,
      runId: job.jobId,
    }),
  };
  const worker = new AgencyIngestionWorker(
    identities,
    jobs,
    connections,
    runtime,
    { async record(event) { events.push(structuredClone(event)); } },
    () => "2026-08-28T12:00:00.000Z",
  );
  return { worker, identities, jobs, connections, runtime, events };
}

describe("agency ingestion worker", () => {
  it("verifies the exact signed payload and rejects tenant tampering", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const verifier = new PublicKeyIngestionJobVerifier(publicKey);
    const payload = JSON.stringify(job);
    const signature = sign("sha256", Buffer.from(payload), privateKey).toString("base64url");

    await expect(verifier.verify(payload, signature)).resolves.toEqual(job);
    const tampered = JSON.stringify({ ...job, tenantId: "tenant-b" });
    await expect(verifier.verify(tampered, signature)).rejects.toThrow("invalid");
    await expect(verifier.verify(
      JSON.stringify({ ...job, unexpected: "field" }),
      sign(
        "sha256",
        Buffer.from(JSON.stringify({ ...job, unexpected: "field" })),
        privateKey,
      ).toString("base64url"),
    )).rejects.toThrow("unsupported fields");
  });

  it("verifies workload and signed job before resolving credentials", async () => {
    const context = harness();
    const result = await context.worker.run({
      authorization: "Bearer synthetic-oidc",
      payload: "synthetic-signed-payload",
      signature: "synthetic-signature",
    });

    expect(result).toEqual({
      ...tenantA,
      jobId: job.jobId,
      accountId: "act_100",
      rowsWritten: 3,
      pagesRead: 1,
      watermarkDate: "2026-08-10",
      runId: job.jobId,
    });
    expect(context.identities.verify).toHaveBeenCalledBefore(context.jobs.verify);
    expect(context.jobs.verify).toHaveBeenCalledBefore(context.connections.resolve);
    expect(context.events.map((event) => event.outcome)).toEqual(["started", "succeeded"]);
    expect(JSON.stringify({ result, events: context.events })).not.toContain(connection.accessToken);
  });

  it("fails before job or token resolution when workload lacks scheduler role", async () => {
    const context = harness({
      identity: {
        issuer: "https://accounts.example.test",
        audience: "agency-ingestion",
        subject: "untrusted-service",
        roles: ["viewer"],
      },
    });

    await expect(context.worker.run({
      authorization: "Bearer invalid-role",
      payload: "payload",
      signature: "signature",
    })).rejects.toThrow("rejected or failed");
    expect(context.jobs.verify).not.toHaveBeenCalled();
    expect(context.connections.resolve).not.toHaveBeenCalled();
  });

  it("rejects write-scoped tokens without invoking the ingestion runtime", async () => {
    const context = harness({
      resolved: { ...connection, scopes: ["ads_read", "ads_management"] },
    });

    const failure = context.worker.run({
      authorization: "Bearer synthetic-oidc",
      payload: "payload",
      signature: "signature",
    });
    await expect(failure).rejects.toThrow("rejected or failed");
    expect(context.runtime.run).not.toHaveBeenCalled();
    expect(context.events.at(-1)).toMatchObject({
      outcome: "failed",
      code: "INGESTION_REJECTED",
    });
    await expect(failure.catch((error: Error) => error.message)).resolves.not.toContain(
      connection.accessToken,
    );
  });

  it("resolves account, binding, and token only after tenant ownership succeeds", async () => {
    const workspacePolicy = new InMemoryTenantWorkspacePolicy();
    workspacePolicy.allow(tenantA);
    const accounts = new InMemoryAgencyAccountConnectionRepository();
    accounts.save({
      ...tenantA,
      accountId: "act_100",
      accountName: "Inmobiliaria Norte",
      currency: "BOB",
      timezone: "America/La_Paz",
      tokenName: "reporting",
      active: true,
    });
    const bindings = new InMemoryAssetBindingRepo();
    await bindings.save({
      workspaceId: tenantA.workspaceId,
      kind: "ad_account",
      assetId: "act_100",
    });
    const resolveToken = vi.fn().mockResolvedValue({
      accessToken: connection.accessToken,
      workspaceId: tenantA.workspaceId,
      tokenName: "reporting",
      scopes: ["ads_read"],
      granularScopes: [],
      dataAccessExpiresAt: null,
      allowedAccountIds: ["act_100"],
      allowedAssetIds: [],
    });
    const tokens = { resolveToken } as unknown as MetaTokenRepo;
    const resolver = new RepositoryIngestionConnectionResolver(
      workspacePolicy,
      accounts,
      bindings,
      tokens,
    );

    const overbroadScope = { ...tenantA, jobId: "must-not-propagate" };
    const resolved = await resolver.resolve(overbroadScope, "act_100");
    expect(resolved).toMatchObject({
      scope: { tenantId: tenantA.tenantId, workspaceId: tenantA.workspaceId },
      account: { accountId: "act_100" },
      scopes: ["ads_read"],
    });
    expect(resolved.scope).toEqual(tenantA);
    await expect(resolver.resolve(tenantB, "act_100")).rejects.toThrow("Workspace");
    expect(resolveToken).toHaveBeenCalledTimes(1);
  });

  it("runs the GET-only client inside an isolated backend token context", async () => {
    const calls: Array<{ path: string; token: string; tenantId?: string }> = [];
    const client: ReadOnlyMetaClient = {
      async get<T>(path: string) {
        calls.push({
          path,
          token: getAccessToken(),
          tenantId: getTenantContext()?.tenantId,
        });
        return { data: [] } as T;
      },
    };
    const runtime = new MetaAgencyIngestionRuntime(
      new InMemoryHistoricalDataRepository(),
      new InMemoryIngestionCheckpointRepository(),
      () => client,
    );

    const result = await runtime.run(connection, job);

    expect(calls).toEqual([{
      path: "/act_100/insights",
      token: connection.accessToken,
      tenantId: tenantA.tenantId,
    }]);
    expect(JSON.stringify(result)).not.toContain(connection.accessToken);
    expect(getTenantContext()).toBeNull();
  });
});

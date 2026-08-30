import { describe, expect, it, vi } from "vitest";
import { getAccessToken } from "../../src/auth/token-store.js";
import {
  AgencyReportingWorker,
  InMemoryHistoricalDataRepository,
  InMemoryIngestionCheckpointRepository,
  InMemoryReportArtifactStore,
  MetaAgencyReportingRuntime,
  type IngestionAuditEvent,
  type ReadOnlyMetaClient,
  type ReportingJobPayload,
  type ResolvedIngestionConnection,
} from "../../src/agency/index.js";
import { tenantA, tenantB } from "./fixtures.js";

const job: ReportingJobPayload = {
  ...tenantA,
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
};

const connection: ResolvedIngestionConnection = {
  scope: tenantA,
  account: {
    accountId: "act_100",
    accountName: "Inmobiliaria Norte",
    currency: "BOB",
    timezone: "America/La_Paz",
  },
  accessToken: "synthetic-server-only-credential",
  scopes: ["ads_read"],
  allowedAccountIds: ["act_100"],
};

function workerHarness(
  runtime: MetaAgencyReportingRuntime,
  resolved: ResolvedIngestionConnection = connection,
  verifiedJob: ReportingJobPayload = job,
) {
  const events: IngestionAuditEvent[] = [];
  const connections = { resolve: vi.fn().mockResolvedValue(resolved) };
  const worker = new AgencyReportingWorker(
    {
      verify: vi.fn().mockResolvedValue({
        issuer: "https://accounts.example.test",
        audience: "agency-reporting",
        subject: "scheduler-service",
        roles: ["scheduler"],
      }),
    },
    { verify: vi.fn().mockResolvedValue(verifiedJob) },
    connections,
    runtime,
    { async record(event) { events.push(structuredClone(event)); } },
    () => "2026-08-31T08:00:00.000Z",
  );
  return { worker, connections, events };
}

describe("agency reporting worker", () => {
  it("runs secure ingestion, creates Excel, and returns only tenant-scoped metadata", async () => {
    const artifacts = new InMemoryReportArtifactStore();
    const calls: Array<{ path: string; token: string }> = [];
    const client: ReadOnlyMetaClient = {
      async get<T>(path: string) {
        calls.push({ path, token: getAccessToken() });
        return {
          data: [{
            account_id: "100",
            account_name: "Inmobiliaria Norte",
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
          }],
        } as T;
      },
    };
    const runtime = new MetaAgencyReportingRuntime(
      new InMemoryHistoricalDataRepository(),
      new InMemoryIngestionCheckpointRepository(),
      artifacts,
      () => client,
      () => "2026-08-31T08:00:00.000Z",
    );
    const context = workerHarness(runtime);

    const result = await context.worker.run({
      authorization: "Bearer synthetic-oidc",
      payload: "signed-payload",
      signature: "signed-signature",
    });

    expect(calls).toEqual([{
      path: "/act_100/insights",
      token: connection.accessToken,
    }]);
    expect(result).toMatchObject({
      ...tenantA,
      jobId: job.jobId,
      accountId: "act_100",
      rowsWritten: 1,
      artifact: {
        ...tenantA,
        filename: "meta-agency-report-2026-08-24-to-2026-08-30.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
    expect(result.artifact.artifactId).toMatch(/^[a-f0-9]{64}$/);
    expect(artifacts.readBytes(tenantA, result.artifact.artifactId)?.slice(0, 2))
      .toEqual(Uint8Array.of(0x50, 0x4b));
    await expect(artifacts.getMetadata(tenantB, result.artifact.artifactId))
      .resolves.toBeNull();
    expect(context.events.map((event) => event.outcome)).toEqual(["started", "succeeded"]);
    const serialized = JSON.stringify({ result, events: context.events });
    expect(serialized).not.toContain(connection.accessToken);
    expect(serialized).not.toContain("objectKey");
    expect(serialized).not.toContain("bytes");
  });

  it("rejects a report window outside ingestion before resolving a token", async () => {
    const runtime = {} as MetaAgencyReportingRuntime;
    const context = workerHarness(runtime, connection, {
      ...job,
      reportStartDate: "2026-08-01",
    });

    await expect(context.worker.run({
      authorization: "Bearer synthetic-oidc",
      payload: "signed-payload",
      signature: "signed-signature",
    })).rejects.toThrow("rejected or failed");
    expect(context.connections.resolve).not.toHaveBeenCalled();
  });

  it("rejects write-scoped Meta connections before ingestion or artifact creation", async () => {
    const runtime = { run: vi.fn() } as unknown as MetaAgencyReportingRuntime;
    const context = workerHarness(runtime, {
      ...connection,
      scopes: ["ads_read", "ads_management"],
    });

    await expect(context.worker.run({
      authorization: "Bearer synthetic-oidc",
      payload: "signed-payload",
      signature: "signed-signature",
    })).rejects.toThrow("rejected or failed");
    expect(runtime.run).not.toHaveBeenCalled();
    expect(context.events.at(-1)).toMatchObject({
      outcome: "failed",
      code: "REPORTING_REJECTED",
    });
  });

  it("fails closed when a runtime returns an artifact from another tenant", async () => {
    const runtime = {
      run: vi.fn().mockResolvedValue({
        ingestion: {
          scope: tenantA,
          accountId: job.accountId,
          requestedStartDate: job.startDate,
          effectiveStartDate: job.startDate,
          endDate: job.endDate,
          mode: "incremental",
          rowsWritten: 1,
          pagesRead: 1,
          watermarkDate: job.endDate,
          runId: job.jobId,
        },
        artifact: {
          ...tenantB,
          artifactId: "a".repeat(64),
          jobId: job.jobId,
          period: {
            kind: job.reportKind,
            startDate: job.reportStartDate,
            endDate: job.reportEndDate,
          },
          filename: "report.xlsx",
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          byteLength: 4,
          sha256: "b".repeat(64),
          createdAt: "2026-08-31T08:00:00.000Z",
          expiresAt: "2026-09-30T08:00:00.000Z",
        },
      }),
    } as unknown as MetaAgencyReportingRuntime;
    const context = workerHarness(runtime);

    await expect(context.worker.run({
      authorization: "Bearer synthetic-oidc",
      payload: "signed-payload",
      signature: "signed-signature",
    })).rejects.toThrow("rejected or failed");
    expect(context.events.at(-1)).toMatchObject({
      outcome: "failed",
      code: "REPORTING_REJECTED",
    });
  });
});

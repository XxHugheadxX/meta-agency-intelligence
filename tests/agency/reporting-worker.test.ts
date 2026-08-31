import { describe, expect, it, vi } from "vitest";
import { getAccessToken } from "../../src/auth/token-store.js";
import {
  AgencyReportingWorker,
  InMemoryReportingJobLeaseRepository,
  InMemoryHistoricalDataRepository,
  InMemoryIngestionCheckpointRepository,
  InMemoryReportArtifactStore,
  MetaAgencyReportingRuntime,
  type AgencyReportingWorkerLeaseOptions,
  type IngestionAuditEvent,
  type ReadOnlyMetaClient,
  type ReportingJobPayload,
  type ReportingBatchCompletionSink,
  type ReportingRuntime,
  type ResolvedIngestionConnection,
} from "../../src/agency/index.js";
import { metricFixture, tenantA, tenantB } from "./fixtures.js";

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

const runtimeResult = {
  ingestion: {
    scope: tenantA,
    accountId: job.accountId,
    requestedStartDate: job.startDate,
    effectiveStartDate: job.startDate,
    endDate: job.endDate,
    mode: "incremental" as const,
    rowsWritten: 1,
    pagesRead: 1,
    watermarkDate: job.endDate,
    runId: job.jobId,
  },
  artifact: {
    ...tenantA,
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
};

function workerHarness(
  runtime: ReportingRuntime,
  resolved: ResolvedIngestionConnection = connection,
  verifiedJob: ReportingJobPayload = job,
  leaseOptions?: AgencyReportingWorkerLeaseOptions,
  batches?: ReportingBatchCompletionSink,
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
    leaseOptions,
    batches,
  );
  return {
    worker,
    connections,
    events,
    envelope: {
      authorization: "Bearer synthetic-oidc",
      payload: "signed-payload",
      signature: "signed-signature",
    },
  };
}

describe("agency reporting worker", () => {
  it("applies admission control before resolving the backend token", async () => {
    const admission = {
      run: vi.fn().mockImplementation(async (
        scope: ReportingJobPayload,
        operation: () => Promise<typeof runtimeResult>,
      ) => {
        expect(scope).toBe(job);
        expect(context.connections.resolve).not.toHaveBeenCalled();
        return operation();
      }),
    };
    const context = workerHarness(
      { run: vi.fn().mockResolvedValue(runtimeResult) },
      connection,
      job,
      { repository: new InMemoryReportingJobLeaseRepository(), admission },
    );

    await expect(context.worker.run({
      authorization: "Bearer synthetic-oidc",
      payload: "signed-payload",
      signature: "signed-signature",
    })).resolves.toMatchObject({ jobId: job.jobId });
    expect(admission.run).toHaveBeenCalledOnce();
    expect(context.connections.resolve).toHaveBeenCalledOnce();
  });

  it("runs secure ingestion, creates Excel, and returns only tenant-scoped metadata", async () => {
    const artifacts = new InMemoryReportArtifactStore(
      () => Date.parse("2026-08-31T08:00:00.000Z"),
    );
    const historical = new InMemoryHistoricalDataRepository();
    await historical.upsert(tenantA, metricFixture({
      accountId: "act_999",
      accountName: "Cuenta Fuera Del Job",
      date: job.startDate,
      metrics: { reach: 99_999, leads: 999 },
    }));
    await historical.upsert(tenantA, metricFixture({
      accountId: "999",
      accountName: "Cuenta Fuera Del Job",
      level: "organic_account",
      campaignId: null,
      campaignName: null,
      adSetId: null,
      adSetName: null,
      adId: null,
      adName: null,
      date: job.startDate,
      metrics: { reach: 88_888 },
      attributionWindow: null,
      breakdowns: { source: "meta_organic_insights", platform: "instagram" },
    }));
    await historical.upsert(tenantA, metricFixture({
      accountId: "999",
      accountName: "Cuenta Fuera Del Job",
      level: "content",
      campaignId: null,
      campaignName: null,
      adSetId: null,
      adSetName: null,
      adId: null,
      adName: null,
      contentId: "9999",
      contentName: "Contenido Fuera Del Job",
      contentType: "reel",
      date: job.startDate,
      metrics: { reach: 77_777 },
      attributionWindow: null,
      breakdowns: { source: "meta_organic_content_insights", platform: "instagram" },
    }));
    const calls: Array<{ path: string; token: string }> = [];
    const client: ReadOnlyMetaClient = {
      async get<T>(path: string) {
        calls.push({ path, token: getAccessToken() });
        if (path === "/300/insights") {
          return { data: [{
            name: "reach",
            values: [{ value: 700, end_time: "2026-08-24T23:59:59+0000" }],
          }] } as T;
        }
        if (path === "/300/media") {
          return { data: [{
            id: "700",
            caption: "Reel Orgánico",
            media_type: "VIDEO",
            media_product_type: "REELS",
            timestamp: "2026-08-24T12:00:00.000Z",
            permalink: "https://www.instagram.com/reel/synthetic/",
          }] } as T;
        }
        if (path === "/700/insights") {
          return { data: [{ name: "reach", values: [{ value: 500 }] }] } as T;
        }
        if (path === "/400/insights") {
          return { data: [
            { name: "views", values: [{ value: 1_400, end_time: "2026-08-24T23:59:59+0000" }] },
            { name: "total_interactions", values: [{ value: 250, end_time: "2026-08-24T23:59:59+0000" }] },
            { name: "profile_visits", values: [{ value: 55, end_time: "2026-08-24T23:59:59+0000" }] },
            { name: "follows", values: [{ value: 800, end_time: "2026-08-24T23:59:59+0000" }] },
          ] } as T;
        }
        if (path === "/400/published_posts") {
          return { data: [{
            id: "400_800",
            message: "Casa Facebook Orgánica",
            created_time: "2026-08-24T13:00:00.000Z",
            permalink_url: "https://www.facebook.com/400/posts/800/",
            status_type: "added_photos",
          }] } as T;
        }
        if (path === "/400_800/insights") {
          return { data: [
            { name: "views", values: [{ value: 900 }] },
            { name: "total_interactions", values: [{ value: 70 }] },
          ] } as T;
        }
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
      historical,
      new InMemoryIngestionCheckpointRepository(),
      artifacts,
      () => client,
      () => "2026-08-31T08:00:00.000Z",
    );
    const organicConnection: ResolvedIngestionConnection = {
      ...connection,
      scopes: [
        "ads_read",
        "read_insights",
        "instagram_basic",
        "instagram_manage_insights",
        "pages_read_engagement",
      ],
      allowedAssetIds: ["300", "400"],
      organicAssets: [
        {
          assetId: "300",
          assetName: "Instagram Norte",
          platform: "instagram",
          currency: "BOB",
          timezone: "America/La_Paz",
        },
        {
          assetId: "400",
          assetName: "Facebook Norte",
          platform: "facebook_page",
          currency: "BOB",
          timezone: "America/La_Paz",
        },
      ],
    };
    const context = workerHarness(runtime, organicConnection);

    const result = await context.worker.run({
      authorization: "Bearer synthetic-oidc",
      payload: "signed-payload",
      signature: "signed-signature",
    });

    expect(calls.map(({ path }) => path)).toEqual([
      "/act_100/insights",
      "/300/insights",
      "/400/insights",
      "/300/media",
      "/700/insights",
      "/400/published_posts",
      "/400_800/insights",
    ]);
    expect(calls.every(({ token }) => token === connection.accessToken)).toBe(true);
    expect(result).toMatchObject({
      ...tenantA,
      jobId: job.jobId,
      accountId: "act_100",
      rowsWritten: 5,
      pagesRead: 5,
      artifact: {
        ...tenantA,
        filename: "meta-agency-report-2026-08-24-to-2026-08-30.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
    expect(result.artifact.artifactId).toMatch(/^[a-f0-9]{64}$/);
    expect(artifacts.readBytes(tenantA, result.artifact.artifactId)?.slice(0, 2))
      .toEqual(Uint8Array.of(0x50, 0x4b));
    const rows = await historical.list(tenantA, {
      startDate: job.startDate,
      endDate: job.endDate,
    });
    expect(rows.map(({ level }) => level).sort()).toEqual([
      "ad",
      "ad",
      "content",
      "content",
      "content",
      "organic_account",
      "organic_account",
      "organic_account",
    ]);
    const workbook = new TextDecoder().decode(
      artifacts.readBytes(tenantA, result.artifact.artifactId),
    );
    expect(workbook).toContain("Reel Orgánico");
    expect(workbook).toContain("Casa Facebook Orgánica");
    expect(workbook).not.toContain("Cuenta Fuera Del Job");
    expect(workbook).not.toContain("Contenido Fuera Del Job");
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

  it("rejects incomplete or manipulated signed batch membership", async () => {
    const runtime = { run: vi.fn() } as unknown as MetaAgencyReportingRuntime;
    for (const invalidJob of [
      { ...job, batchId: `batch-${"a".repeat(40)}` },
      { ...job, batchAccountIds: [job.accountId] },
      {
        ...job,
        batchId: `batch-${"a".repeat(40)}`,
        batchAccountIds: ["act_999"],
      },
      {
        ...job,
        batchId: `batch-${"a".repeat(40)}`,
        batchAccountIds: [job.accountId, job.accountId],
      },
    ] as ReportingJobPayload[]) {
      const context = workerHarness(runtime, connection, invalidJob);
      await expect(context.worker.run(context.envelope)).rejects.toThrow(
        "Agency reporting job was rejected or failed",
      );
    }
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it("records a validated batch completion after the account artifact succeeds", async () => {
    const batchedJob: ReportingJobPayload = {
      ...job,
      batchId: `batch-${"a".repeat(40)}`,
      batchAccountIds: [job.accountId],
    };
    const batches = { record: vi.fn().mockResolvedValue(null) };
    const context = workerHarness(
      { run: vi.fn().mockResolvedValue(runtimeResult) },
      connection,
      batchedJob,
      undefined,
      batches,
    );
    await expect(context.worker.run(context.envelope)).resolves.toMatchObject({ jobId: job.jobId });
    expect(batches.record).toHaveBeenCalledOnce();
    expect(batches.record).toHaveBeenCalledWith(batchedJob);
  });

  it("rejects organic assets without their required read-only scopes", async () => {
    const runtime = { run: vi.fn() } as unknown as MetaAgencyReportingRuntime;
    const context = workerHarness(runtime, {
      ...connection,
      allowedAssetIds: ["300"],
      organicAssets: [{
        assetId: "300",
        assetName: "Instagram Norte",
        platform: "instagram",
        currency: "BOB",
        timezone: "America/La_Paz",
      }],
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

  it("rejects an organic asset outside the resolved token allowlist", async () => {
    const runtime = { run: vi.fn() } as unknown as MetaAgencyReportingRuntime;
    const context = workerHarness(runtime, {
      ...connection,
      scopes: [
        "ads_read",
        "read_insights",
        "instagram_basic",
        "instagram_manage_insights",
      ],
      allowedAssetIds: [],
      organicAssets: [{
        assetId: "300",
        assetName: "Instagram Norte",
        platform: "instagram",
        currency: "BOB",
        timezone: "America/La_Paz",
      }],
    });

    await expect(context.worker.run({
      authorization: "Bearer synthetic-oidc",
      payload: "signed-payload",
      signature: "signed-signature",
    })).rejects.toThrow("rejected or failed");
    expect(runtime.run).not.toHaveBeenCalled();
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

  it("fails closed when an organic result belongs to another tenant", async () => {
    const runtime = {
      run: vi.fn().mockResolvedValue({
        ...runtimeResult,
        organicIngestions: [{
          scope: tenantB,
          platform: "instagram",
          assetId: "300",
          startDate: job.startDate,
          endDate: job.endDate,
          pagesRead: 1,
          rowsWritten: 1,
          runId: `${job.jobId}:organic:instagram:300`,
        }],
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

  it("replays a completed tenant-scoped job without calling Meta twice", async () => {
    const runtime = { run: vi.fn().mockResolvedValue(runtimeResult) };
    const leases = new InMemoryReportingJobLeaseRepository();
    const context = workerHarness(runtime, connection, job, { repository: leases });
    const envelope = {
      authorization: "Bearer synthetic-oidc",
      payload: "signed-payload",
      signature: "signed-signature",
    };

    const first = await context.worker.run(envelope);
    const replay = await context.worker.run(envelope);

    expect(replay).toEqual(first);
    expect(runtime.run).toHaveBeenCalledTimes(1);
    expect(context.connections.resolve).toHaveBeenCalledTimes(1);
    expect(context.events.map((event) => event.outcome)).toEqual([
      "started",
      "succeeded",
      "started",
      "succeeded",
    ]);
  });

  it("rejects a concurrent duplicate while the first job owns the lease", async () => {
    let finishRuntime: ((value: typeof runtimeResult) => void) | undefined;
    const runtime = {
      run: vi.fn().mockImplementation(() => new Promise<typeof runtimeResult>((resolve) => {
        finishRuntime = resolve;
      })),
    };
    const leases = new InMemoryReportingJobLeaseRepository();
    const context = workerHarness(runtime, connection, job, { repository: leases });
    const envelope = {
      authorization: "Bearer synthetic-oidc",
      payload: "signed-payload",
      signature: "signed-signature",
    };

    const first = context.worker.run(envelope);
    await vi.waitFor(() => expect(runtime.run).toHaveBeenCalledTimes(1));
    await expect(context.worker.run(envelope)).rejects.toThrow(
      "Reporting capacity is temporarily exhausted",
    );
    finishRuntime?.(runtimeResult);
    await expect(first).resolves.toMatchObject({ jobId: job.jobId });
    expect(runtime.run).toHaveBeenCalledTimes(1);
  });

  it("releases the lease after failure so a scheduler retry can succeed", async () => {
    const runtime = {
      run: vi.fn()
        .mockRejectedValueOnce(new Error("synthetic runtime failure"))
        .mockResolvedValueOnce(runtimeResult),
    };
    const leases = new InMemoryReportingJobLeaseRepository();
    const context = workerHarness(runtime, connection, job, { repository: leases });
    const envelope = {
      authorization: "Bearer synthetic-oidc",
      payload: "signed-payload",
      signature: "signed-signature",
    };

    await expect(context.worker.run(envelope)).rejects.toThrow("rejected or failed");
    await expect(context.worker.run(envelope)).resolves.toMatchObject({ jobId: job.jobId });
    expect(runtime.run).toHaveBeenCalledTimes(2);
  });

  it("renews the lease while a report is still running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T08:00:00.000Z"));
    try {
      let finishRuntime: ((value: typeof runtimeResult) => void) | undefined;
      const runtime = {
        run: vi.fn().mockImplementation(() => new Promise<typeof runtimeResult>((resolve) => {
          finishRuntime = resolve;
        })),
      };
      const leases = new InMemoryReportingJobLeaseRepository(() => new Date(Date.now()));
      const renew = vi.spyOn(leases, "renew");
      const context = workerHarness(runtime, connection, job, {
        repository: leases,
        leaseTtlMs: 1_000,
      });

      const pending = context.worker.run({
        authorization: "Bearer synthetic-oidc",
        payload: "signed-payload",
        signature: "signed-signature",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(400);
      expect(renew).toHaveBeenCalled();
      finishRuntime?.(runtimeResult);
      await expect(pending).resolves.toMatchObject({ jobId: job.jobId });
    } finally {
      vi.useRealTimers();
    }
  });
});

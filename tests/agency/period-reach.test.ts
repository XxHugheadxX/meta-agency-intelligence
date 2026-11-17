import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  InMemoryHistoricalDataRepository,
  InMemoryPeriodReachRepository,
  periodReachId,
  type PeriodReachInput,
} from "../../src/agency/historical-data/index.js";
import {
  AgencyInsightsIngestionService,
  AgencyPeriodReachIngestionService,
  InMemoryIngestionAssetPolicy,
  InMemoryIngestionCheckpointRepository,
  MetaAdsPeriodReachReader,
  type IngestionAccount,
  type MetaInsightRecord,
  type PeriodReachReader,
} from "../../src/agency/ingestion/index.js";
import { AgencyReadOnlyReportingPipeline } from "../../src/agency/mvp/index.js";
import { AgencyReportingService } from "../../src/agency/reporting/index.js";
import { resolveReportingJobRuntimeConfig } from "../../src/agency/worker/index.js";
import type { MetaApiResponse } from "../../src/meta/types/common.js";
import { metricFixture, tenantA, tenantB } from "./fixtures.js";

const account: IngestionAccount = {
  accountId: "act_100",
  accountName: "Inmobiliaria Norte",
  currency: "BOB",
  timezone: "America/La_Paz",
};
const week = { startDate: "2026-08-10", endDate: "2026-08-16" };
const previousWeek = { startDate: "2026-08-03", endDate: "2026-08-09" };
const NOW = "2026-08-17T08:00:00.000Z";
const PUBLIC_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .publicKey.export({ type: "spki", format: "pem" }).toString();

function snapshotInput(overrides: Partial<PeriodReachInput> = {}): PeriodReachInput {
  return {
    accountId: "act_100",
    accountName: "Inmobiliaria Norte",
    ...week,
    timezone: "America/La_Paz",
    apiVersion: "v23.0",
    reach: 1_500,
    impressions: 4_500,
    extractedAt: NOW,
    runId: "run-1",
    ...overrides,
  };
}

function record(overrides: Partial<MetaInsightRecord> = {}): MetaInsightRecord {
  return {
    account_id: "100",
    account_name: "Inmobiliaria Norte",
    date_start: week.startDate,
    date_stop: week.endDate,
    reach: "1500",
    impressions: "4500",
    ...overrides,
  };
}

function readerReturning(
  pages: Readonly<Record<string, MetaApiResponse<MetaInsightRecord>>>,
): PeriodReachReader & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async read(query) {
      calls.push(`${query.startDate}..${query.endDate}`);
      return pages[query.startDate] ?? { data: [] };
    },
  };
}

function service(reader: PeriodReachReader, repository = new InMemoryPeriodReachRepository()) {
  const policy = new InMemoryIngestionAssetPolicy();
  policy.allow(tenantA, account.accountId);
  return {
    repository,
    service: new AgencyPeriodReachIngestionService(reader, repository, policy, () => NOW),
  };
}

describe("period reach repository", () => {
  it("stores one idempotent snapshot per account, exact range, timezone and API version", async () => {
    const repository = new InMemoryPeriodReachRepository();
    const first = await repository.upsert(tenantA, snapshotInput());
    const replay = await repository.upsert(tenantA, snapshotInput({ reach: 1_600, runId: "run-2" }));
    expect(replay.id).toBe(first.id);
    expect(replay.createdAt).toBe(first.createdAt);
    const key = { accountId: "act_100", ...week, timezone: "America/La_Paz", apiVersion: "v23.0" };
    expect(await repository.getMany(tenantA, [key])).toMatchObject([{ reach: 1_600, runId: "run-2" }]);
    expect(periodReachId(tenantA, key)).not.toBe(periodReachId(tenantA, { ...key, ...previousWeek }));
    expect(periodReachId(tenantA, key)).not.toBe(periodReachId(tenantA, { ...key, apiVersion: "v24.0" }));
  });

  it("never returns another tenant's snapshot or one for a different range", async () => {
    const repository = new InMemoryPeriodReachRepository();
    await repository.upsert(tenantA, snapshotInput());
    const key = { accountId: "act_100", ...week, timezone: "America/La_Paz", apiVersion: "v23.0" };
    expect(await repository.getMany(tenantB, [key])).toEqual([]);
    expect(await repository.getMany(tenantA, [{ ...key, ...previousWeek }])).toEqual([]);
    expect(await repository.getMany(tenantA, [{ ...key, timezone: "UTC" }])).toEqual([]);
  });

  it.each([
    ["a fractional reach", { reach: 10.5 }],
    ["a negative reach", { reach: -1 }],
    ["reach above impressions", { reach: 10, impressions: 9 }],
    ["an inverted range", { startDate: "2026-08-17" }],
    ["a non-account id", { accountId: "100" }],
    ["an unsafe runId", { runId: "run/1" }],
  ])("rejects %s", async (_name, overrides) => {
    await expect(new InMemoryPeriodReachRepository().upsert(tenantA, snapshotInput(overrides)))
      .rejects.toThrow();
  });
});

describe("period reach ingestion", () => {
  it("requests an account-level range without a daily increment", async () => {
    const requests: Array<{ path: string; params: unknown }> = [];
    const reader = new MetaAdsPeriodReachReader({
      async get<T>(path: string, params?: unknown) {
        requests.push({ path, params });
        return { data: [] } as T;
      },
    });
    await reader.read({ account, ...week });
    expect(requests).toEqual([{
      path: "/act_100/insights",
      params: {
        fields: "account_id,account_name,date_start,date_stop,reach,impressions",
        level: "account",
        time_range: JSON.stringify({ since: week.startDate, until: week.endDate }),
        limit: 2,
      },
    }]);
  });

  it("stores each requested period and reports periods without delivery", async () => {
    const reader = readerReturning({ [week.startDate]: { data: [record()] } });
    const context = service(reader);
    const result = await context.service.run({
      scope: tenantA, account, periods: [week, previousWeek], apiVersion: "v23.0", runId: "job-1",
    });
    expect(reader.calls).toEqual(["2026-08-10..2026-08-16", "2026-08-03..2026-08-09"]);
    expect(result.snapshots).toMatchObject([{ reach: 1_500, impressions: 4_500, ...week, runId: "job-1" }]);
    expect(result.periodsWithoutData).toEqual([previousWeek]);
  });

  it("refuses an account that is not bound to the tenant before calling Meta", async () => {
    const reader = readerReturning({});
    const context = service(reader);
    await expect(context.service.run({
      scope: tenantB, account, periods: [week], apiVersion: "v23.0",
    })).rejects.toThrow("not assigned");
    expect(reader.calls).toEqual([]);
  });

  it.each([
    ["a row for a different range", { data: [record({ date_stop: "2026-08-15" })] }],
    ["a row for another account", { data: [record({ account_id: "999" })] }],
    ["more than one row", { data: [record(), record()] }],
    ["a paginated response", { data: [record()], paging: { next: "https://graph.facebook.com/next" } }],
    ["a missing reach", { data: [record({ reach: undefined })] }],
    ["a fractional reach", { data: [record({ reach: "10.5" })] }],
  ])("fails closed on %s", async (_name, page) => {
    const context = service(readerReturning({ [week.startDate]: page as MetaApiResponse<MetaInsightRecord> }));
    await expect(context.service.run({
      scope: tenantA, account, periods: [week], apiVersion: "v23.0",
    })).rejects.toThrow();
    expect(await context.repository.getMany(tenantA, [{
      accountId: "act_100", ...week, timezone: "America/La_Paz", apiVersion: "v23.0",
    }])).toEqual([]);
  });

  it.each([
    ["no periods", []],
    ["duplicate periods", [week, week]],
    ["a period longer than 92 days", [{ startDate: "2026-01-01", endDate: "2026-06-30" }]],
  ])("rejects %s", async (_name, periods) => {
    await expect(service(readerReturning({})).service.run({
      scope: tenantA, account, periods, apiVersion: "v23.0",
    })).rejects.toThrow();
  });
});

describe("period reach in reports", () => {
  async function historical() {
    const repository = new InMemoryHistoricalDataRepository();
    await repository.upsert(tenantA, metricFixture({ date: "2026-08-10", metrics: { reach: 1_000, impressions: 2_000 } }));
    await repository.upsert(tenantA, metricFixture({ date: "2026-08-11", metrics: { reach: 900, impressions: 2_500 } }));
    await repository.upsert(tenantA, metricFixture({ date: "2026-08-04", metrics: { reach: 700, impressions: 1_400 } }));
    await repository.upsert(tenantA, metricFixture({ date: "2026-08-05", metrics: { reach: 600, impressions: 1_600 } }));
    return repository;
  }

  it("keeps reach unavailable when no snapshot exists for the exact period", async () => {
    const report = await new AgencyReportingService(await historical(), new InMemoryPeriodReachRepository())
      .createWeeklyReport(tenantA, "2026-08-12");
    expect(report.current.metrics).toMatchObject({ reach: null, frequency: null });
    expect(report.periodReach).toBeUndefined();
    expect(report.current.limitations?.some((note) => note.includes("N/D"))).toBe(true);
  });

  it("uses the stored snapshot for a single account instead of summing daily rows", async () => {
    const periodReach = new InMemoryPeriodReachRepository();
    await periodReach.upsert(tenantA, snapshotInput());
    await periodReach.upsert(tenantA, snapshotInput({ ...previousWeek, reach: 1_000, impressions: 3_000 }));
    const report = await new AgencyReportingService(await historical(), periodReach)
      .createWeeklyReport(tenantA, "2026-08-12");
    expect(report.current.metrics).toMatchObject({ reach: 1_500, frequency: 3, impressions: 4_500 });
    expect(report.previous.metrics).toMatchObject({ reach: 1_000, frequency: 3 });
    expect(report.comparison.reach).toMatchObject({ absoluteChange: 500, percentageChange: 50 });
    expect(report.accountRanking[0].metrics.reach).toBe(1_500);
    expect(report.periodReach?.current).toMatchObject([{ accountId: "act_100", reach: 1_500 }]);
    expect(report.current.limitations?.some((note) => note.includes("snapshot de Meta"))).toBe(true);
    expect(report.current.limitations?.some((note) => note.startsWith("Alcance único y frecuencia del período: N/D"))).toBe(false);
  });

  it("never combines accounts into an agency-wide reach", async () => {
    const repository = await historical();
    await repository.upsert(tenantA, metricFixture({
      accountId: "act_200", accountName: "Inmobiliaria Sur", date: "2026-08-10",
      metrics: { reach: 400, impressions: 800 },
    }));
    const periodReach = new InMemoryPeriodReachRepository();
    await periodReach.upsert(tenantA, snapshotInput());
    await periodReach.upsert(tenantA, snapshotInput({
      accountId: "act_200", accountName: "Inmobiliaria Sur", reach: 400, impressions: 800,
    }));
    const report = await new AgencyReportingService(repository, periodReach)
      .createWeeklyReport(tenantA, "2026-08-12");
    expect(report.current.metrics).toMatchObject({ reach: null, frequency: null });
    expect(report.current.limitations?.some((note) => note.includes("entre cuentas"))).toBe(true);
    expect(Object.fromEntries(report.accountRanking.map((entry) => [entry.id, entry.metrics.reach])))
      .toEqual({ act_100: 1_500, act_200: 400 });
  });

  it("ignores a snapshot stored for another tenant", async () => {
    const periodReach = new InMemoryPeriodReachRepository();
    await periodReach.upsert(tenantB, snapshotInput());
    const report = await new AgencyReportingService(await historical(), periodReach)
      .createWeeklyReport(tenantA, "2026-08-12");
    expect(report.current.metrics.reach).toBeNull();
  });
});

describe("period reach in the reporting pipeline", () => {
  function pipeline(reachReader?: PeriodReachReader) {
    const historicalData = new InMemoryHistoricalDataRepository();
    const periodReach = new InMemoryPeriodReachRepository();
    const policy = new InMemoryIngestionAssetPolicy();
    policy.allow(tenantA, account.accountId);
    const daily = (date: string, reach: string, impressions: string): MetaInsightRecord => ({
      account_id: "100", account_name: "Inmobiliaria Norte",
      campaign_id: "campaign-1", campaign_name: "Captación",
      date_start: date, date_stop: date, spend: "50", reach, impressions, clicks: "10",
    });
    return new AgencyReadOnlyReportingPipeline(
      new AgencyInsightsIngestionService(
        { async readPage() { return { data: [daily("2026-08-10", "1000", "2000"), daily("2026-08-11", "900", "2500")] }; } },
        historicalData,
        new InMemoryIngestionCheckpointRepository(),
        policy,
        () => NOW,
      ),
      new AgencyReportingService(historicalData, reachReader ? periodReach : undefined),
      undefined,
      undefined,
      undefined,
      reachReader
        ? new AgencyPeriodReachIngestionService(reachReader, periodReach, policy, () => NOW)
        : undefined,
    );
  }
  const input = {
    ingestion: {
      scope: tenantA, account, ...week, level: "campaign" as const, apiVersion: "v23.0", runId: "job-1",
    },
    period: { kind: "week" as const, ...week },
    excel: { generatedAt: NOW },
  };

  it("reads the report period and the one before it, then reports the deduplicated value", async () => {
    const reader = readerReturning({ [week.startDate]: { data: [record()] } });
    const result = await pipeline(reader).run(input);
    expect(reader.calls).toEqual(["2026-08-10..2026-08-16", "2026-08-03..2026-08-09"]);
    expect(result.periodReach?.snapshots).toHaveLength(1);
    expect(result.periodReach?.periodsWithoutData).toEqual([previousWeek]);
    expect(result.report.current.metrics).toMatchObject({ reach: 1_500, frequency: 3 });
    expect(result.excel.bytes.slice(0, 2)).toEqual(Uint8Array.of(0x50, 0x4b));
  });

  it("makes no reach request and keeps reach unavailable when the feature is off", async () => {
    const result = await pipeline().run(input);
    expect(result.periodReach).toBeUndefined();
    expect(result.report.current.metrics.reach).toBeNull();
  });

  it("fails the job instead of publishing a report when Meta returns an inconsistent row", async () => {
    const reader = readerReturning({ [week.startDate]: { data: [record({ date_stop: "2026-08-12" })] } });
    await expect(pipeline(reader).run(input)).rejects.toThrow("exact requested period");
  });
});

describe("period reach configuration", () => {
  const security = {
    metaAppConfigured: true, allowlistConfigured: true, multiTenantEnabled: true,
    mcpMode: "read_only" as const, allowLeadPii: false,
  };
  const env = (value?: string): NodeJS.ProcessEnv => ({
    AGENCY_REPORTING_JOBS_ENABLED: "true",
    AGENCY_SCHEDULER_AUDIENCE: "https://service.example.test/internal/agency/reporting/jobs",
    AGENCY_SCHEDULER_SERVICE_ACCOUNT: "scheduler@example.iam.gserviceaccount.com",
    AGENCY_SCHEDULER_SUBJECT: "123456789012345678901",
    AGENCY_REPORTING_JOB_PUBLIC_KEY: PUBLIC_KEY,
    REPORTS_GCS_BUCKET: "private-agency-reports",
    FIRESTORE_PROJECT_ID: "agency-project",
    ...(value === undefined ? {} : { AGENCY_REPORTING_PERIOD_REACH_ENABLED: value }),
  });

  it("is off unless explicitly enabled and rejects ambiguous values", () => {
    expect(resolveReportingJobRuntimeConfig(security, env())).toMatchObject({ periodReachEnabled: false });
    expect(resolveReportingJobRuntimeConfig(security, env("false"))).toMatchObject({ periodReachEnabled: false });
    expect(resolveReportingJobRuntimeConfig(security, env("true"))).toMatchObject({ periodReachEnabled: true });
    expect(() => resolveReportingJobRuntimeConfig(security, env("yes"))).toThrow("true or false");
  });
});

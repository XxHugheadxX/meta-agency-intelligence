import { randomUUID } from "node:crypto";
import {
  assertIsoDate,
  assertReportingScope,
  type PeriodReachRepository,
  type PeriodReachSnapshot,
  type ReportingScope,
} from "../historical-data/index.js";
import type {
  IngestionAccount,
  IngestionAssetPolicy,
  MetaInsightRecord,
  ReadOnlyMetaClient,
} from "./types.js";
import type { MetaApiResponse } from "../../meta/types/common.js";

const MAX_PERIODS = 4;
const MAX_PERIOD_DAYS = 92;

export interface ReachPeriod {
  readonly startDate: string;
  readonly endDate: string;
}

export interface PeriodReachQuery extends ReachPeriod {
  readonly account: IngestionAccount;
}

export interface PeriodReachReader {
  read(query: PeriodReachQuery): Promise<MetaApiResponse<MetaInsightRecord>>;
}

export interface PeriodReachIngestionRequest {
  readonly scope: ReportingScope;
  readonly account: IngestionAccount;
  readonly periods: readonly ReachPeriod[];
  readonly apiVersion: string;
  readonly runId?: string;
}

export interface PeriodReachIngestionResult {
  readonly scope: ReportingScope;
  readonly accountId: string;
  readonly snapshots: readonly PeriodReachSnapshot[];
  /** Periods Meta returned no delivery row for; their reach stays unavailable. */
  readonly periodsWithoutData: readonly ReachPeriod[];
  readonly runId: string;
}

/** Omitting time_increment makes Meta deduplicate people across the whole range. */
export class MetaAdsPeriodReachReader implements PeriodReachReader {
  constructor(private readonly client: ReadOnlyMetaClient) {}

  async read(query: PeriodReachQuery): Promise<MetaApiResponse<MetaInsightRecord>> {
    if (!/^act_\d+$/.test(query.account.accountId)) {
      throw new Error("Meta period reach requires an act_<digits> accountId");
    }
    return this.client.get<MetaApiResponse<MetaInsightRecord>>(
      `/${query.account.accountId}/insights`,
      {
        fields: "account_id,account_name,date_start,date_stop,reach,impressions",
        level: "account",
        time_range: JSON.stringify({ since: query.startDate, until: query.endDate }),
        limit: 2,
      },
    );
  }
}

function count(value: unknown, field: string, required: true): number;
function count(value: unknown, field: string, required: false): number | null;
function count(value: unknown, field: string, required: boolean): number | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`Meta period ${field} is missing`);
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Meta period ${field} must be a non-negative integer`);
  }
  return parsed;
}

function daysInclusive(period: ReachPeriod): number {
  return Math.round(
    (Date.parse(`${period.endDate}T00:00:00.000Z`) -
      Date.parse(`${period.startDate}T00:00:00.000Z`)) / 86_400_000,
  ) + 1;
}

function validateRequest(request: PeriodReachIngestionRequest): void {
  assertReportingScope(request.scope);
  if (!/^act_\d+$/.test(request.account.accountId)) {
    throw new Error("Meta period reach requires an act_<digits> accountId");
  }
  if (!request.account.accountName.trim() || !request.account.timezone.trim()) {
    throw new Error("Period reach account name and timezone are required");
  }
  if (!/^v\d+\.\d+$/.test(request.apiVersion)) {
    throw new Error("apiVersion must use the Meta v<major>.<minor> format");
  }
  if (request.periods.length < 1 || request.periods.length > MAX_PERIODS) {
    throw new Error(`Period reach ingestion accepts between 1 and ${MAX_PERIODS} periods`);
  }
  const seen = new Set<string>();
  for (const period of request.periods) {
    assertIsoDate(period.startDate, "startDate");
    assertIsoDate(period.endDate, "endDate");
    if (period.startDate > period.endDate) {
      throw new Error("Period reach startDate must be on or before endDate");
    }
    if (daysInclusive(period) > MAX_PERIOD_DAYS) {
      throw new Error(`A reach period cannot exceed ${MAX_PERIOD_DAYS} days`);
    }
    const key = `${period.startDate}\u001f${period.endDate}`;
    if (seen.has(key)) throw new Error("Period reach ingestion periods must be unique");
    seen.add(key);
  }
}

export class AgencyPeriodReachIngestionService {
  constructor(
    private readonly reader: PeriodReachReader,
    private readonly periodReach: PeriodReachRepository,
    private readonly assetPolicy: IngestionAssetPolicy,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(request: PeriodReachIngestionRequest): Promise<PeriodReachIngestionResult> {
    validateRequest(request);
    await this.assetPolicy.assertAccountAllowed(request.scope, request.account.accountId);
    const extractedAt = this.now();
    const runId = request.runId ?? randomUUID();
    const snapshots: PeriodReachSnapshot[] = [];
    const periodsWithoutData: ReachPeriod[] = [];

    for (const period of request.periods) {
      const page = await this.reader.read({ account: request.account, ...period });
      if (!Array.isArray(page.data)) {
        throw new Error("Meta period reach response data must be an array");
      }
      if (page.data.length === 0) {
        periodsWithoutData.push({ ...period });
        continue;
      }
      if (page.data.length !== 1 || page.paging?.next) {
        throw new Error("Meta period reach must return a single account-level row");
      }
      const record = page.data[0];
      // A row for any other range is a different set of people; never relabel it.
      if (record.date_start !== period.startDate || record.date_stop !== period.endDate) {
        throw new Error("Meta period reach row does not cover the exact requested period");
      }
      const responseAccountId = record.account_id === undefined
        ? null
        : String(record.account_id).replace(/^(?!act_)/, "act_");
      if (responseAccountId !== null && responseAccountId !== request.account.accountId) {
        throw new Error("Meta period reach account_id does not match the authorized account");
      }
      snapshots.push(await this.periodReach.upsert(request.scope, {
        accountId: request.account.accountId,
        accountName:
          typeof record.account_name === "string" && record.account_name.trim()
            ? record.account_name
            : request.account.accountName,
        startDate: period.startDate,
        endDate: period.endDate,
        timezone: request.account.timezone,
        apiVersion: request.apiVersion,
        reach: count(record.reach, "reach", true),
        impressions: count(record.impressions, "impressions", false),
        extractedAt,
        runId,
      }));
    }

    return {
      scope: { ...request.scope },
      accountId: request.account.accountId,
      snapshots,
      periodsWithoutData,
      runId,
    };
  }
}

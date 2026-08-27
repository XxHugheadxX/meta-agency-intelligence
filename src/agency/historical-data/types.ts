export interface ReportingScope {
  tenantId: string;
  workspaceId: string;
}

export type HistoricalMetricLevel = "account" | "campaign" | "ad_set" | "ad";

export type MetricName =
  | "spend"
  | "reach"
  | "impressions"
  | "clicks"
  | "messages"
  | "conversations"
  | "leads"
  | "conversions"
  | "profileVisits"
  | "interactions"
  | "newFollowers"
  | "ctr"
  | "cpc"
  | "cpm"
  | "cpl"
  | "frequency";

export type MetricValues = Record<MetricName, number | null>;
export type MetricValuesInput = Partial<MetricValues>;

export const METRIC_NAMES: readonly MetricName[] = [
  "spend",
  "reach",
  "impressions",
  "clicks",
  "messages",
  "conversations",
  "leads",
  "conversions",
  "profileVisits",
  "interactions",
  "newFollowers",
  "ctr",
  "cpc",
  "cpm",
  "cpl",
  "frequency",
] as const;

export interface HistoricalMetricInput {
  accountId: string;
  accountName: string;
  campaignId?: string | null;
  campaignName?: string | null;
  adSetId?: string | null;
  adSetName?: string | null;
  adId?: string | null;
  adName?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  date: string;
  level: HistoricalMetricLevel;
  metrics: MetricValuesInput;
  currency: string;
  timezone: string;
  attributionWindow?: string | null;
  breakdowns?: Readonly<Record<string, string | number | boolean | null>>;
  apiVersion?: string | null;
  schemaVersion?: string;
  extractedAt?: string;
  quality?: "complete" | "partial" | "late" | "estimated";
  rawData: Readonly<Record<string, unknown>>;
}

export interface HistoricalMetricRow extends ReportingScope {
  id: string;
  accountId: string;
  accountName: string;
  campaignId: string | null;
  campaignName: string | null;
  adSetId: string | null;
  adSetName: string | null;
  adId: string | null;
  adName: string | null;
  agentId: string | null;
  agentName: string | null;
  date: string;
  level: HistoricalMetricLevel;
  metrics: MetricValues;
  currency: string;
  timezone: string;
  attributionWindow: string | null;
  breakdowns: Readonly<Record<string, string | number | boolean | null>>;
  apiVersion: string | null;
  schemaVersion: string;
  extractedAt: string;
  quality: "complete" | "partial" | "late" | "estimated";
  rawData: Readonly<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
}

export interface HistoricalMetricQuery {
  startDate: string;
  endDate: string;
  accountIds?: readonly string[];
  level?: HistoricalMetricLevel;
}

export interface HistoricalDataRepository {
  upsert(scope: ReportingScope, input: HistoricalMetricInput): Promise<HistoricalMetricRow>;
  upsertMany(
    scope: ReportingScope,
    inputs: readonly HistoricalMetricInput[],
  ): Promise<HistoricalMetricRow[]>;
  list(scope: ReportingScope, query: HistoricalMetricQuery): Promise<HistoricalMetricRow[]>;
}

export function normalizeMetrics(input: MetricValuesInput): MetricValues {
  const metrics = {} as MetricValues;
  for (const name of METRIC_NAMES) {
    const value = input[name];
    if (value !== undefined && value !== null && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`Metric ${name} must be a finite non-negative number or null`);
    }
    metrics[name] = value ?? null;
  }
  return metrics;
}

export function assertReportingScope(scope: ReportingScope): void {
  if (!scope.tenantId.trim() || !scope.workspaceId.trim()) {
    throw new Error("A non-empty tenantId and workspaceId are required");
  }
  if (scope.tenantId.includes("/") || scope.workspaceId.includes("/")) {
    throw new Error("tenantId and workspaceId cannot contain path separators");
  }
}

export function assertIsoDate(value: string, field = "date"): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const instant = match ? new Date(`${value}T00:00:00.000Z`) : null;
  if (
    !match ||
    !instant ||
    Number.isNaN(instant.getTime()) ||
    instant.getUTCFullYear() !== Number(match[1]) ||
    instant.getUTCMonth() + 1 !== Number(match[2]) ||
    instant.getUTCDate() !== Number(match[3])
  ) {
    throw new Error(`${field} must be an ISO calendar date (YYYY-MM-DD)`);
  }
}

function assertRequiredDimension(
  id: string | null | undefined,
  name: string | null | undefined,
  dimension: string,
): void {
  if (!id?.trim() || !name?.trim()) {
    throw new Error(`${dimension}Id and ${dimension}Name are required for this level`);
  }
}

export function normalizeHistoricalMetric(
  scope: ReportingScope,
  input: HistoricalMetricInput,
  id: string,
  existing?: HistoricalMetricRow,
  now = new Date().toISOString(),
): HistoricalMetricRow {
  assertReportingScope(scope);
  assertIsoDate(input.date);
  if (!input.accountId.trim() || !input.accountName.trim()) {
    throw new Error("accountId and accountName are required");
  }
  if (!input.currency.trim() || !input.timezone.trim()) {
    throw new Error("currency and timezone are required");
  }
  if (input.level === "campaign" || input.level === "ad_set" || input.level === "ad") {
    assertRequiredDimension(input.campaignId, input.campaignName, "campaign");
  }
  if (input.level === "ad_set" || input.level === "ad") {
    assertRequiredDimension(input.adSetId, input.adSetName, "adSet");
  }
  if (input.level === "ad") {
    assertRequiredDimension(input.adId, input.adName, "ad");
  }
  if (!input.rawData || Array.isArray(input.rawData)) {
    throw new Error("rawData must be an aggregate, non-PII object");
  }

  return {
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    id,
    accountId: input.accountId,
    accountName: input.accountName,
    campaignId: input.campaignId ?? null,
    campaignName: input.campaignName ?? null,
    adSetId: input.adSetId ?? null,
    adSetName: input.adSetName ?? null,
    adId: input.adId ?? null,
    adName: input.adName ?? null,
    agentId: input.agentId ?? null,
    agentName: input.agentName ?? null,
    date: input.date,
    level: input.level,
    metrics: normalizeMetrics(input.metrics),
    currency: input.currency,
    timezone: input.timezone,
    attributionWindow: input.attributionWindow ?? null,
    breakdowns: structuredClone(input.breakdowns ?? {}),
    apiVersion: input.apiVersion ?? null,
    schemaVersion: input.schemaVersion ?? "v1",
    extractedAt: input.extractedAt ?? now,
    quality: input.quality ?? "complete",
    rawData: structuredClone(input.rawData),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

import { assertIsoDate, type MetricValuesInput } from "../historical-data/index.js";
import type {
  NormalizeOrganicInsightsContext,
  OrganicHistoricalInput,
  OrganicInsightRecord,
} from "./organic-types.js";
import { ORGANIC_ACCOUNT_METRICS } from "./organic-reader.js";

const SENSITIVE_KEY = /(?:token|secret|authorization|password|api[_-]?key|private[_-]?key|credential|cookie|session)/i;
const SENSITIVE_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~-]+|\bEAA[A-Za-z0-9_-]{12,}|(?:access_token|refresh_token|id_token|client_secret)=[^&\s]+)/i;

function sanitizeRaw(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 250).map((item) => sanitizeRaw(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 250)
        .map(([key, child]) => [
          key,
          SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeRaw(child, depth + 1),
        ]),
    );
  }
  if (typeof value === "string") {
    return SENSITIVE_VALUE.test(value) ? "[REDACTED]" : value.slice(0, 4_096);
  }
  return value;
}

function numericValue(value: unknown, metric: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Meta organic metric ${metric} must be a finite non-negative number`);
  }
  return parsed;
}

function dateFromEndTime(value: unknown): string {
  if (typeof value !== "string") throw new Error("Meta organic insight end_time is required");
  const date = value.slice(0, 10);
  assertIsoDate(date, "organic insight end_time");
  return date;
}

function outputMetric(
  name: string,
  platform: NormalizeOrganicInsightsContext["asset"]["platform"],
): keyof MetricValuesInput | null {
  const mapping: Readonly<Record<string, keyof MetricValuesInput>> =
    platform === "facebook_page"
      ? {
          page_impressions: "impressions",
          page_impressions_unique: "reach",
          page_post_engagements: "interactions",
          page_views_total: "profileVisits",
        }
      : {
          reach: "reach",
          views: "views",
          profile_views: "profileVisits",
          total_interactions: "interactions",
          saves: "saves",
          shares: "shares",
          follower_count: "followerCount",
        };
  return mapping[name] ?? null;
}

function metricValues(record: OrganicInsightRecord): readonly { date: string; value: number }[] {
  if (!Array.isArray(record.values)) {
    throw new Error(`Meta organic metric ${record.name} must contain a daily values array`);
  }
  return record.values.map((entry) => ({
    date: dateFromEndTime(entry.end_time),
    value: numericValue(entry.value, record.name),
  }));
}

export function normalizeOrganicInsights(
  records: readonly OrganicInsightRecord[],
  context: NormalizeOrganicInsightsContext,
): OrganicHistoricalInput[] {
  const daily = new Map<string, { metrics: MetricValuesInput; raw: Record<string, unknown> }>();
  const seen = new Set<string>();
  const follows = new Map<string, number>();
  const unfollows = new Map<string, number>();

  for (const record of records) {
    if (typeof record.name !== "string" || !record.name.trim()) {
      throw new Error("Meta organic insight name is required");
    }
    if (seen.has(record.name)) throw new Error(`Meta organic response repeated metric ${record.name}`);
    seen.add(record.name);
    for (const entry of metricValues(record)) {
      if (entry.date < context.startDate || entry.date > context.endDate) {
        throw new Error("Meta organic insight falls outside the requested ingestion window");
      }
      const row = daily.get(entry.date) ?? { metrics: {}, raw: {} };
      const metadata = Object.fromEntries(
        Object.entries(record).filter(([key]) => key !== "values" && key !== "total_value"),
      );
      row.raw[record.name] = sanitizeRaw({
        metadata,
        value: entry.value,
        endTime: entry.date,
      });
      daily.set(entry.date, row);
      if (record.name === "page_daily_follows") follows.set(entry.date, entry.value);
      else if (record.name === "page_daily_unfollows") unfollows.set(entry.date, entry.value);
      else {
        const metric = outputMetric(record.name, context.asset.platform);
        if (metric) row.metrics[metric] = entry.value;
      }
    }
  }

  if (context.asset.platform === "facebook_page") {
    for (const [date, row] of daily) {
      if (follows.has(date) && unfollows.has(date)) {
        row.metrics.newFollowers = (follows.get(date) ?? 0) - (unfollows.get(date) ?? 0);
      }
    }
  } else {
    const followerSeries = [...daily.entries()]
      .filter(([, row]) => row.metrics.followerCount !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    for (let index = 1; index < followerSeries.length; index += 1) {
      const [, previous] = followerSeries[index - 1];
      const [, current] = followerSeries[index];
      current.metrics.newFollowers =
        (current.metrics.followerCount as number) - (previous.metrics.followerCount as number);
    }
  }

  return [...daily.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, row]) => {
      const missingMetrics = ORGANIC_ACCOUNT_METRICS[context.asset.platform]
        .filter((name) => !(name in row.raw));
      return {
      accountId: context.asset.assetId,
      accountName: context.asset.assetName,
      agentId: context.asset.agentId ?? null,
      agentName: context.asset.agentName ?? null,
      date,
      level: "account",
      metrics: row.metrics,
      currency: context.asset.currency,
      timezone: context.asset.timezone,
      attributionWindow: null,
      breakdowns: {
        source: "meta_organic_insights",
        platform: context.asset.platform,
      },
      apiVersion: context.apiVersion,
      schemaVersion: "meta-organic-insights-v1",
      extractedAt: context.extractedAt,
      quality: missingMetrics.length === 0 ? "complete" : "partial",
      rawData: {
        source: "meta_organic_insights",
        platform: context.asset.platform,
        runId: context.runId,
        missingMetrics,
        metrics: row.raw,
      },
      };
    });
}

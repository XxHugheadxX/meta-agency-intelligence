import type { ActionValue } from "../../meta/types/insights.js";
import {
  assertIsoDate,
  type HistoricalMetricInput,
  type PaidHistoricalMetricLevel,
} from "../historical-data/index.js";
import type { IngestionAccount, MetaInsightRecord } from "./types.js";

const MESSAGE_ACTIONS = new Set([
  "onsite_conversion.messaging_first_reply",
  "onsite_conversion.total_messaging_connection",
]);
const CONVERSATION_ACTIONS = new Set([
  "onsite_conversion.messaging_conversation_started_7d",
  "messaging_conversation_started_7d",
]);
const LEAD_ACTIONS = new Set([
  "lead",
  "onsite_conversion.lead_grouped",
  "offsite_conversion.fb_pixel_lead",
]);
const SENSITIVE_KEY = /(?:token|secret|authorization|password|api[_-]?key|private[_-]?key|credential|cookie|session)/i;
const SENSITIVE_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~-]+|\bEAA[A-Za-z0-9_-]{12,}|(?:access_token|refresh_token|id_token|client_secret)=[^&\s]+)/i;

export interface NormalizeInsightContext {
  readonly account: IngestionAccount;
  readonly level: PaidHistoricalMetricLevel;
  readonly attributionWindow: string | null;
  readonly breakdowns: readonly string[];
  readonly apiVersion: string;
  readonly extractedAt: string;
  readonly runId: string;
  readonly pageNumber: number;
}

function optionalMetric(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Meta insight ${field} must be a finite non-negative number`);
  }
  return parsed;
}

function sumActions(values: readonly ActionValue[] | undefined, allowed?: ReadonlySet<string>): number | null {
  if (!values) return null;
  let total = 0;
  let matched = false;
  for (const action of values) {
    if (allowed && !allowed.has(action.action_type)) continue;
    const value = optionalMetric(action.value, `action ${action.action_type}`);
    if (value === null) continue;
    total += value;
    matched = true;
  }
  return matched ? total : null;
}

function ratio(numerator: number | null, denominator: number | null, multiplier = 1): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return (numerator / denominator) * multiplier;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Meta insight ${field} is required for the requested level`);
  }
  return value;
}

function normalizedAccountId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value);
  return raw.startsWith("act_") ? raw : `act_${raw}`;
}

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
    if (SENSITIVE_VALUE.test(value)) return "[REDACTED]";
    return value.slice(0, 4_096);
  }
  return value;
}

function dimensions(record: MetaInsightRecord, level: PaidHistoricalMetricLevel) {
  const campaignId = level === "account" ? null : requiredText(record.campaign_id, "campaign_id");
  const campaignName = level === "account" ? null : requiredText(record.campaign_name, "campaign_name");
  const adSetId = level === "ad_set" || level === "ad" ? requiredText(record.adset_id, "adset_id") : null;
  const adSetName = level === "ad_set" || level === "ad" ? requiredText(record.adset_name, "adset_name") : null;
  const adId = level === "ad" ? requiredText(record.ad_id, "ad_id") : null;
  const adName = level === "ad" ? requiredText(record.ad_name, "ad_name") : null;
  return { campaignId, campaignName, adSetId, adSetName, adId, adName };
}

export function normalizeMetaInsight(
  record: MetaInsightRecord,
  context: NormalizeInsightContext,
): HistoricalMetricInput {
  assertIsoDate(record.date_start, "date_start");
  const responseAccountId = normalizedAccountId(record.account_id);
  if (responseAccountId && responseAccountId !== context.account.accountId) {
    throw new Error("Meta insight account_id does not match the authorized account");
  }

  const spend = optionalMetric(record.spend, "spend");
  const reach = optionalMetric(record.reach, "reach");
  const impressions = optionalMetric(record.impressions, "impressions");
  const clicks = optionalMetric(record.clicks, "clicks");
  const messages = sumActions(record.actions, MESSAGE_ACTIONS);
  const conversations = sumActions(record.actions, CONVERSATION_ACTIONS);
  const leads = sumActions(record.actions, LEAD_ACTIONS);
  const conversions = sumActions(record.conversions);
  const breakdowns = Object.fromEntries(
    context.breakdowns.flatMap((name) => {
      const value = record[name];
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null
        ? [[name, value] as const]
        : [];
    }),
  );
  const daily = record.date_stop === undefined || record.date_stop === record.date_start;

  return {
    accountId: context.account.accountId,
    accountName:
      typeof record.account_name === "string" && record.account_name.trim()
        ? record.account_name
        : context.account.accountName,
    ...dimensions(record, context.level),
    agentId: context.account.agentId ?? null,
    agentName: context.account.agentName ?? null,
    date: record.date_start,
    level: context.level,
    metrics: {
      spend,
      reach,
      impressions,
      clicks,
      messages,
      conversations,
      leads,
      conversions,
      ctr: ratio(clicks, impressions, 100),
      cpc: ratio(spend, clicks),
      cpm: ratio(spend, impressions, 1_000),
      cpl: ratio(spend, leads),
      frequency: ratio(impressions, reach),
    },
    currency: context.account.currency,
    timezone: context.account.timezone,
    attributionWindow: context.attributionWindow,
    breakdowns,
    apiVersion: context.apiVersion,
    schemaVersion: "meta-insights-v1",
    extractedAt: context.extractedAt,
    quality: daily ? "complete" : "partial",
    rawData: {
      source: "meta_ads_insights",
      runId: context.runId,
      pageNumber: context.pageNumber,
      payload: sanitizeRaw(record),
    },
  };
}

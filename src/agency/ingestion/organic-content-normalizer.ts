import type { MetricValuesInput } from "../historical-data/index.js";
import {
  FACEBOOK_POST_METRICS,
  INSTAGRAM_CONTENT_METRICS,
} from "./organic-content-reader.js";
import type {
  NormalizeOrganicContentContext,
  OrganicContentHistoricalInput,
  OrganicContentItem,
  OrganicContentRecord,
  OrganicContentType,
} from "./organic-content-types.js";
import type { OrganicInsightRecord } from "./organic-types.js";

const SENSITIVE_KEY = /(?:token|secret|authorization|password|api[_-]?key|private[_-]?key|credential|cookie|session)/i;
const SENSITIVE_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~-]+|\bEAA[A-Za-z0-9_-]{12,}|(?:access_token|refresh_token|id_token|client_secret)=[^&\s]+)/i;

function sanitizeRaw(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeRaw(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
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

function cleanContentName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const clean = value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (SENSITIVE_VALUE.test(clean)) return "[REDACTED CONTENT]";
  return clean ? clean.slice(0, 160) : fallback;
}

function safePermalink(value: unknown, allowedHosts: ReadonlySet<string>): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) {
      return null;
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function contentType(record: OrganicContentRecord): OrganicContentType {
  const product = record.media_product_type?.toUpperCase();
  const media = record.media_type?.toUpperCase();
  if (product === "REELS") return "reel";
  if (product === "STORY") return "story";
  if (media === "CAROUSEL_ALBUM") return "carousel";
  if (media === "VIDEO") return "video";
  if (media === "IMAGE") return "image";
  return "unknown";
}

function publishedAt(value: unknown, source: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${source} timestamp must be a valid ISO timestamp`);
  }
  return new Date(value).toISOString();
}

export function normalizeInstagramContent(record: OrganicContentRecord): OrganicContentItem {
  if (!/^\d{1,32}$/.test(record.id)) {
    throw new Error("Instagram content response contains an invalid contentId");
  }
  return {
    contentId: record.id,
    contentName: cleanContentName(record.caption, `Instagram ${record.id}`),
    contentType: contentType(record),
    publishedAt: publishedAt(record.timestamp, "Instagram content"),
    permalink: safePermalink(record.permalink, new Set(["instagram.com", "www.instagram.com"])),
  };
}

function facebookContentType(value: unknown): OrganicContentType {
  if (typeof value !== "string") return "unknown";
  if (value === "added_photos") return "image";
  if (value === "added_video") return "video";
  return "unknown";
}

export function normalizeFacebookPost(record: OrganicContentRecord): OrganicContentItem {
  if (!/^\d{1,32}_\d{1,32}$/.test(record.id)) {
    throw new Error("Facebook post response contains an invalid Page-scoped postId");
  }
  return {
    contentId: record.id,
    contentName: cleanContentName(record.message, `Facebook ${record.id}`),
    contentType: facebookContentType(record.status_type),
    publishedAt: publishedAt(record.created_time, "Facebook post"),
    permalink: safePermalink(
      record.permalink_url,
      new Set(["facebook.com", "www.facebook.com", "m.facebook.com"]),
    ),
  };
}

function insightValue(record: OrganicInsightRecord, source: string): number {
  const candidate = Array.isArray(record.values) && record.values.length === 1
    ? record.values[0]?.value
    : record.total_value?.value;
  const parsed = typeof candidate === "number" ? candidate : Number(candidate);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${source} metric ${record.name} must contain one non-negative lifetime value`);
  }
  return parsed;
}

export function normalizeInstagramContentInsights(
  content: OrganicContentItem,
  records: readonly OrganicInsightRecord[],
  context: NormalizeOrganicContentContext,
): OrganicContentHistoricalInput {
  const values = new Map<string, number>();
  const raw: Record<string, unknown> = {};
  for (const record of records) {
    if (!INSTAGRAM_CONTENT_METRICS.includes(record.name as typeof INSTAGRAM_CONTENT_METRICS[number])) {
      throw new Error(`Instagram content response returned unsupported metric ${record.name}`);
    }
    if (values.has(record.name)) {
      throw new Error(`Instagram content response repeated metric ${record.name}`);
    }
    const value = insightValue(record, "Instagram content");
    values.set(record.name, value);
    raw[record.name] = sanitizeRaw(record);
  }

  const metrics: MetricValuesInput = {
    reach: values.get("reach"),
    views: values.get("views"),
    saves: values.get("saved"),
    shares: values.get("shares"),
    interactions: values.get("total_interactions"),
  };
  if (metrics.interactions === undefined) {
    const components = ["likes", "comments", "shares", "saved"]
      .map((name) => values.get(name));
    if (components.some((value) => value !== undefined)) {
      metrics.interactions = components.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    }
  }
  const missingMetrics = INSTAGRAM_CONTENT_METRICS.filter((name) => !values.has(name));
  return {
    accountId: context.asset.assetId,
    accountName: context.asset.assetName,
    contentId: content.contentId,
    contentName: content.contentName,
    contentType: content.contentType,
    agentId: context.asset.agentId ?? null,
    agentName: context.asset.agentName ?? null,
    date: content.publishedAt.slice(0, 10),
    level: "content",
    metrics,
    currency: context.asset.currency,
    timezone: context.asset.timezone,
    attributionWindow: null,
    breakdowns: {
      source: "meta_organic_content_insights",
      platform: "instagram",
    },
    apiVersion: context.apiVersion,
    schemaVersion: "meta-organic-content-v1",
    extractedAt: context.extractedAt,
    quality: missingMetrics.length === 0 ? "complete" : "partial",
    rawData: {
      source: "meta_organic_content_insights",
      platform: "instagram",
      runId: context.runId,
      publishedAt: content.publishedAt,
      permalink: content.permalink,
      missingMetrics,
      metrics: raw,
    },
  };
}

export function normalizeFacebookPostInsights(
  content: OrganicContentItem,
  records: readonly OrganicInsightRecord[],
  context: NormalizeOrganicContentContext,
): OrganicContentHistoricalInput {
  const values = new Map<string, number>();
  const raw: Record<string, unknown> = {};
  for (const record of records) {
    if (!FACEBOOK_POST_METRICS.includes(record.name as typeof FACEBOOK_POST_METRICS[number])) {
      throw new Error(`Facebook post response returned unsupported metric ${record.name}`);
    }
    if (values.has(record.name)) {
      throw new Error(`Facebook post response repeated metric ${record.name}`);
    }
    const value = insightValue(record, "Facebook post");
    values.set(record.name, value);
    raw[record.name] = sanitizeRaw(record);
  }

  const missingMetrics = FACEBOOK_POST_METRICS.filter((name) => !values.has(name));
  return {
    accountId: context.asset.assetId,
    accountName: context.asset.assetName,
    contentId: content.contentId,
    contentName: content.contentName,
    contentType: content.contentType,
    agentId: context.asset.agentId ?? null,
    agentName: context.asset.agentName ?? null,
    date: content.publishedAt.slice(0, 10),
    level: "content",
    metrics: {
      views: values.get("views"),
      interactions: values.get("total_interactions"),
    },
    currency: context.asset.currency,
    timezone: context.asset.timezone,
    attributionWindow: null,
    breakdowns: {
      source: "meta_facebook_post_insights",
      platform: "facebook_page",
    },
    apiVersion: context.apiVersion,
    schemaVersion: "meta-facebook-post-v1",
    extractedAt: context.extractedAt,
    quality: missingMetrics.length === 0 ? "complete" : "partial",
    rawData: {
      source: "meta_facebook_post_insights",
      platform: "facebook_page",
      runId: context.runId,
      publishedAt: content.publishedAt,
      permalink: content.permalink,
      missingMetrics,
      metrics: raw,
    },
  };
}

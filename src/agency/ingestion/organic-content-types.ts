import type { MetaApiResponse } from "../../meta/types/common.js";
import type { HistoricalMetricInput, ReportingScope } from "../historical-data/index.js";
import type { OrganicAsset, OrganicInsightRecord, OrganicPlatform } from "./organic-types.js";

export type OrganicContentType = "image" | "video" | "reel" | "carousel" | "story" | "unknown";

export interface OrganicContentRecord {
  readonly id: string;
  readonly caption?: string;
  readonly media_type?: string;
  readonly media_product_type?: string;
  readonly timestamp?: string;
  readonly permalink?: string;
  readonly message?: string;
  readonly created_time?: string;
  readonly permalink_url?: string;
  readonly status_type?: string;
  readonly [key: string]: unknown;
}

export interface OrganicContentItem {
  readonly contentId: string;
  readonly contentName: string;
  readonly contentType: OrganicContentType;
  readonly publishedAt: string;
  readonly permalink: string | null;
}

export interface OrganicContentPageQuery {
  readonly asset: OrganicAsset;
  readonly startDate: string;
  readonly endDate: string;
  readonly after?: string;
}

export interface OrganicContentInsightsQuery {
  readonly asset: OrganicAsset;
  readonly content: OrganicContentItem;
}

export interface OrganicContentReader {
  readContentPage(query: OrganicContentPageQuery): Promise<MetaApiResponse<OrganicContentRecord>>;
  readInsights(query: OrganicContentInsightsQuery): Promise<MetaApiResponse<OrganicInsightRecord>>;
}

export interface OrganicContentIngestionRequest {
  readonly scope: ReportingScope;
  readonly asset: OrganicAsset;
  readonly startDate: string;
  readonly endDate: string;
  readonly apiVersion: string;
  readonly maxPages?: number;
  readonly maxContent?: number;
  readonly runId?: string;
}

export interface OrganicContentIngestionResult {
  readonly scope: ReportingScope;
  readonly platform: OrganicPlatform;
  readonly assetId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly pagesRead: number;
  readonly contentsRead: number;
  readonly rowsWritten: number;
  readonly runId: string;
}

export interface NormalizeOrganicContentContext {
  readonly asset: OrganicAsset;
  readonly apiVersion: string;
  readonly extractedAt: string;
  readonly runId: string;
}

export type OrganicContentHistoricalInput = HistoricalMetricInput;

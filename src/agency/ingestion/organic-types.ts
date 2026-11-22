import type { MetaApiResponse } from "../../meta/types/common.js";
import type { HistoricalMetricInput, ReportingScope } from "../historical-data/index.js";
import type { ReadOnlyMetaClient } from "./types.js";

export type OrganicPlatform = "facebook_page" | "instagram";

export interface OrganicAsset {
  readonly assetId: string;
  readonly assetName: string;
  readonly platform: OrganicPlatform;
  readonly currency: string;
  readonly timezone: string;
  readonly agentId?: string | null;
  readonly agentName?: string | null;
}

export interface OrganicInsightValue {
  readonly value: unknown;
  readonly end_time?: string;
}

export interface OrganicInsightRecord {
  readonly id?: string;
  readonly name: string;
  readonly period?: string;
  readonly values?: readonly OrganicInsightValue[];
  readonly total_value?: { readonly value?: unknown };
  readonly [key: string]: unknown;
}

export interface OrganicInsightsPageQuery {
  readonly asset: OrganicAsset;
  readonly startDate: string;
  readonly endDate: string;
  readonly after?: string;
}

export interface OrganicInsightsPageReader {
  readPage(query: OrganicInsightsPageQuery): Promise<MetaApiResponse<OrganicInsightRecord>>;
}

export interface OrganicAssetPolicy {
  assertAssetAllowed(
    scope: ReportingScope,
    platform: OrganicPlatform,
    assetId: string,
  ): Promise<void>;
}

export interface OrganicIngestionRequest {
  readonly scope: ReportingScope;
  readonly asset: OrganicAsset;
  readonly startDate: string;
  readonly endDate: string;
  readonly apiVersion: string;
  readonly maxPages?: number;
  readonly maxRecords?: number;
  readonly runId?: string;
}

export interface OrganicIngestionResult {
  readonly scope: ReportingScope;
  readonly platform: OrganicPlatform;
  readonly assetId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly pagesRead: number;
  readonly rowsWritten: number;
  readonly runId: string;
}

export interface NormalizeOrganicInsightsContext {
  readonly asset: OrganicAsset;
  readonly startDate: string;
  readonly endDate: string;
  readonly apiVersion: string;
  readonly extractedAt: string;
  readonly runId: string;
}

export type OrganicHistoricalInput = HistoricalMetricInput;
export type OrganicReadOnlyMetaClient = ReadOnlyMetaClient;

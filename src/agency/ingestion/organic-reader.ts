import type { MetaApiResponse } from "../../meta/types/common.js";
import type {
  OrganicInsightRecord,
  OrganicInsightsPageQuery,
  OrganicInsightsPageReader,
  OrganicPlatform,
  OrganicReadOnlyMetaClient,
} from "./organic-types.js";

export const ORGANIC_ACCOUNT_METRICS: Readonly<Record<OrganicPlatform, readonly string[]>> = {
  facebook_page: [
    "page_impressions",
    "page_impressions_unique",
    "page_post_engagements",
    "page_views_total",
    "page_daily_follows",
    "page_daily_unfollows",
  ],
  instagram: [
    "reach",
    "views",
    "profile_views",
    "total_interactions",
    "saves",
    "shares",
    "follower_count",
  ],
};

function assertAssetId(assetId: string): void {
  if (!/^\d{1,32}$/.test(assetId)) {
    throw new Error("Organic ingestion requires a numeric Meta assetId");
  }
}

export class MetaOrganicInsightsReader implements OrganicInsightsPageReader {
  constructor(private readonly client: OrganicReadOnlyMetaClient) {}

  readPage(query: OrganicInsightsPageQuery): Promise<MetaApiResponse<OrganicInsightRecord>> {
    assertAssetId(query.asset.assetId);
    const params: Record<string, string | number | boolean | undefined> = {
      metric: ORGANIC_ACCOUNT_METRICS[query.asset.platform].join(","),
      period: "day",
      since: query.startDate,
      until: query.endDate,
      limit: 100,
      after: query.after,
      metric_type: query.asset.platform === "instagram" ? "time_series" : undefined,
    };
    return this.client.get<MetaApiResponse<OrganicInsightRecord>>(
      `/${query.asset.assetId}/insights`,
      params,
    );
  }
}

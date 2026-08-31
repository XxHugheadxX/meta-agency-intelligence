import type { MetaApiResponse } from "../../meta/types/common.js";
import type { OrganicInsightRecord, OrganicReadOnlyMetaClient } from "./organic-types.js";
import type {
  OrganicContentInsightsQuery,
  OrganicContentPageQuery,
  OrganicContentReader,
  OrganicContentRecord,
} from "./organic-content-types.js";

export const INSTAGRAM_CONTENT_FIELDS = [
  "id",
  "caption",
  "media_type",
  "media_product_type",
  "timestamp",
  "permalink",
] as const;

export const INSTAGRAM_CONTENT_METRICS = [
  "reach",
  "views",
  "likes",
  "comments",
  "shares",
  "saved",
  "total_interactions",
] as const;

function assertInstagramAsset(query: { readonly asset: { readonly platform: string; readonly assetId: string } }): void {
  if (query.asset.platform !== "instagram") {
    throw new Error("Organic content ingestion currently supports Instagram assets only");
  }
  if (!/^\d{1,32}$/.test(query.asset.assetId)) {
    throw new Error("Organic content ingestion requires a numeric Instagram assetId");
  }
}

function assertContentId(contentId: string): void {
  if (!/^\d{1,32}$/.test(contentId)) {
    throw new Error("Organic content insights require a numeric Instagram contentId");
  }
}

export class MetaInstagramContentReader implements OrganicContentReader {
  constructor(private readonly client: OrganicReadOnlyMetaClient) {}

  readContentPage(query: OrganicContentPageQuery): Promise<MetaApiResponse<OrganicContentRecord>> {
    assertInstagramAsset(query);
    return this.client.get<MetaApiResponse<OrganicContentRecord>>(
      `/${query.asset.assetId}/media`,
      {
        fields: INSTAGRAM_CONTENT_FIELDS.join(","),
        since: query.startDate,
        until: query.endDate,
        limit: 100,
        after: query.after,
      },
    );
  }

  readInsights(query: OrganicContentInsightsQuery): Promise<MetaApiResponse<OrganicInsightRecord>> {
    assertInstagramAsset(query);
    assertContentId(query.content.contentId);
    return this.client.get<MetaApiResponse<OrganicInsightRecord>>(
      `/${query.content.contentId}/insights`,
      { metric: INSTAGRAM_CONTENT_METRICS.join(",") },
    );
  }
}

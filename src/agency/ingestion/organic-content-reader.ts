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

export const FACEBOOK_POST_FIELDS = [
  "id",
  "message",
  "created_time",
  "permalink_url",
  "status_type",
] as const;

export const FACEBOOK_POST_METRICS = [
  "views",
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

function assertFacebookAsset(query: { readonly asset: { readonly platform: string; readonly assetId: string } }): void {
  if (query.asset.platform !== "facebook_page") {
    throw new Error("Facebook post ingestion requires a Facebook Page asset");
  }
  if (!/^\d{1,32}$/.test(query.asset.assetId)) {
    throw new Error("Facebook post ingestion requires a numeric Page assetId");
  }
}

function assertFacebookPostId(contentId: string, pageId: string): void {
  if (!/^\d{1,32}_\d{1,32}$/.test(contentId) || !contentId.startsWith(`${pageId}_`)) {
    throw new Error("Facebook post insights require a Page-scoped numeric postId");
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

export class MetaFacebookPostReader implements OrganicContentReader {
  constructor(private readonly client: OrganicReadOnlyMetaClient) {}

  readContentPage(query: OrganicContentPageQuery): Promise<MetaApiResponse<OrganicContentRecord>> {
    assertFacebookAsset(query);
    return this.client.get<MetaApiResponse<OrganicContentRecord>>(
      `/${query.asset.assetId}/published_posts`,
      {
        fields: FACEBOOK_POST_FIELDS.join(","),
        since: query.startDate,
        until: query.endDate,
        limit: 100,
        after: query.after,
      },
    );
  }

  readInsights(query: OrganicContentInsightsQuery): Promise<MetaApiResponse<OrganicInsightRecord>> {
    assertFacebookAsset(query);
    assertFacebookPostId(query.content.contentId, query.asset.assetId);
    return this.client.get<MetaApiResponse<OrganicInsightRecord>>(
      `/${query.content.contentId}/insights`,
      { metric: FACEBOOK_POST_METRICS.join(",") },
    );
  }
}

export class MetaPlatformContentReader implements OrganicContentReader {
  private readonly instagram: MetaInstagramContentReader;
  private readonly facebook: MetaFacebookPostReader;

  constructor(client: OrganicReadOnlyMetaClient) {
    this.instagram = new MetaInstagramContentReader(client);
    this.facebook = new MetaFacebookPostReader(client);
  }

  readContentPage(query: OrganicContentPageQuery): Promise<MetaApiResponse<OrganicContentRecord>> {
    return query.asset.platform === "instagram"
      ? this.instagram.readContentPage(query)
      : this.facebook.readContentPage(query);
  }

  readInsights(query: OrganicContentInsightsQuery): Promise<MetaApiResponse<OrganicInsightRecord>> {
    return query.asset.platform === "instagram"
      ? this.instagram.readInsights(query)
      : this.facebook.readInsights(query);
  }
}

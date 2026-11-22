import type { Breakdown } from "../../meta/types/insights.js";
import type {
  InsightsPageQuery,
  InsightsPageReader,
  MetaInsightRecord,
  ReadOnlyMetaClient,
} from "./types.js";
import type { MetaApiResponse } from "../../meta/types/common.js";

const IDENTIFIER_FIELDS = [
  "account_id",
  "account_name",
  "campaign_id",
  "campaign_name",
  "adset_id",
  "adset_name",
  "ad_id",
  "ad_name",
] as const;

const METRIC_FIELDS = [
  "date_start",
  "date_stop",
  "spend",
  "reach",
  "impressions",
  "clicks",
  "actions",
  "conversions",
] as const;

const ALLOWED_BREAKDOWNS = new Set<Breakdown>([
  "age",
  "gender",
  "country",
  "region",
  "dma",
  "impression_device",
  "device_platform",
  "platform_position",
  "publisher_platform",
  "product_id",
  "frequency_value",
  "hourly_stats_aggregated_by_advertiser_time_zone",
  "hourly_stats_aggregated_by_audience_time_zone",
  "body_asset",
  "call_to_action_asset",
  "description_asset",
  "image_asset",
  "link_url_asset",
  "title_asset",
  "video_asset",
]);

function assertAccountId(accountId: string): void {
  if (!/^act_\d+$/.test(accountId)) {
    throw new Error("Meta ingestion requires an act_<digits> accountId");
  }
}
function normalizeBreakdowns(values: readonly string[]): string[] {
  const unique = [...new Set(values)];
  for (const value of unique) {
    if (!ALLOWED_BREAKDOWNS.has(value as Breakdown)) {
      throw new Error(`Unsupported Meta insights breakdown: ${value}`);
    }
  }
  return unique.sort();
}

export class MetaAdsInsightsReader implements InsightsPageReader {
  constructor(private readonly client: ReadOnlyMetaClient) {}

  async readPage(query: InsightsPageQuery): Promise<MetaApiResponse<MetaInsightRecord>> {
    assertAccountId(query.account.accountId);
    const breakdowns = normalizeBreakdowns(query.breakdowns);
    const params: Record<string, string | number | boolean | undefined> = {
      fields: [...IDENTIFIER_FIELDS, ...METRIC_FIELDS].join(","),
      level: query.level === "ad_set" ? "adset" : query.level,
      time_range: JSON.stringify({ since: query.startDate, until: query.endDate }),
      time_increment: 1,
      limit: query.pageSize,
      after: query.after,
      breakdowns: breakdowns.length > 0 ? breakdowns.join(",") : undefined,
      action_attribution_windows: query.attributionWindow
        ? JSON.stringify([query.attributionWindow])
        : undefined,
      use_unified_attribution_setting: true,
    };
    return this.client.get<MetaApiResponse<MetaInsightRecord>>(
      `/${query.account.accountId}/insights`,
      params,
    );
  }
}

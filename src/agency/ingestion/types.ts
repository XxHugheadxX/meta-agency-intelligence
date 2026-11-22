import type { MetaApiResponse } from "../../meta/types/common.js";
import type { InsightsResult } from "../../meta/types/insights.js";
import type {
  PaidHistoricalMetricLevel,
  ReportingScope,
} from "../historical-data/index.js";

export interface IngestionAccount {
  readonly accountId: string;
  readonly accountName: string;
  readonly currency: string;
  readonly timezone: string;
  readonly agentId?: string | null;
  readonly agentName?: string | null;
}

export interface MetaInsightRecord extends InsightsResult {
  account_id?: string;
  account_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
}

export interface InsightsPageQuery {
  readonly account: IngestionAccount;
  readonly startDate: string;
  readonly endDate: string;
  readonly level: PaidHistoricalMetricLevel;
  readonly attributionWindow: string | null;
  readonly breakdowns: readonly string[];
  readonly pageSize: number;
  readonly after?: string;
}

export interface InsightsPageReader {
  readPage(query: InsightsPageQuery): Promise<MetaApiResponse<MetaInsightRecord>>;
}

export interface ReadOnlyMetaClient {
  get<T>(
    path: string,
    params?: Readonly<Record<string, string | number | boolean | undefined>>,
  ): Promise<T>;
}

export interface IngestionAssetPolicy {
  assertAccountAllowed(scope: ReportingScope, accountId: string): Promise<void>;
}

export interface IngestionCheckpointKey {
  readonly accountId: string;
  readonly level: PaidHistoricalMetricLevel;
  readonly attributionWindow: string | null;
  readonly breakdowns: readonly string[];
  readonly apiVersion: string;
}

export interface IngestionCheckpoint extends IngestionCheckpointKey, ReportingScope {
  readonly watermarkDate: string;
  readonly completedAt: string;
  readonly rowsWritten: number;
}

export interface IngestionCheckpointRepository {
  get(
    scope: ReportingScope,
    key: IngestionCheckpointKey,
  ): Promise<IngestionCheckpoint | null>;
  save(scope: ReportingScope, checkpoint: IngestionCheckpoint): Promise<void>;
}

export interface InsightsIngestionRequest {
  readonly scope: ReportingScope;
  readonly account: IngestionAccount;
  readonly startDate: string;
  readonly endDate: string;
  readonly level: PaidHistoricalMetricLevel;
  readonly apiVersion: string;
  readonly attributionWindow?: string | null;
  readonly breakdowns?: readonly string[];
  readonly mode?: "backfill" | "incremental";
  readonly lookbackDays?: number;
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly maxRows?: number;
  readonly runId?: string;
}

export interface InsightsIngestionResult {
  readonly scope: ReportingScope;
  readonly accountId: string;
  readonly requestedStartDate: string;
  readonly effectiveStartDate: string;
  readonly endDate: string;
  readonly mode: "backfill" | "incremental";
  readonly rowsWritten: number;
  readonly pagesRead: number;
  readonly watermarkDate: string;
  readonly runId: string;
}

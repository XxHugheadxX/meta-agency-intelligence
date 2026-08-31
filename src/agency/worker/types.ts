import type { PaidHistoricalMetricLevel, ReportingScope } from "../historical-data/index.js";
import type {
  IngestionAccount,
  InsightsIngestionResult,
  OrganicAsset,
  OrganicContentIngestionResult,
  OrganicIngestionResult,
} from "../ingestion/index.js";
import type { StoredReportArtifact } from "../delivery/index.js";

export interface IngestionJobPayload extends ReportingScope {
  readonly jobId: string;
  readonly accountId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly level: PaidHistoricalMetricLevel;
  readonly apiVersion: string;
  readonly attributionWindow?: string | null;
  readonly breakdowns?: readonly string[];
  readonly mode?: "backfill" | "incremental";
  readonly lookbackDays?: number;
}

export interface ReportingJobPayload extends IngestionJobPayload {
  readonly reportKind: "week" | "month";
  readonly reportStartDate: string;
  readonly reportEndDate: string;
  readonly retentionDays?: number;
}

export interface IngestionJobEnvelope {
  readonly authorization: string;
  readonly payload: string;
  readonly signature: string;
}

export interface VerifiedWorkloadIdentity {
  readonly issuer: string;
  readonly audience: string;
  readonly subject: string;
  readonly roles: readonly string[];
}

export interface WorkloadIdentityVerifier {
  verify(authorization: string): Promise<VerifiedWorkloadIdentity>;
}

export interface IngestionJobVerifier {
  verify(payload: string, signature: string): Promise<IngestionJobPayload>;
}

export interface ResolvedIngestionConnection {
  readonly scope: ReportingScope;
  readonly account: IngestionAccount;
  readonly accessToken: string;
  readonly scopes: readonly string[];
  readonly allowedAccountIds: readonly string[];
  readonly allowedAssetIds?: readonly string[];
  readonly organicAssets?: readonly OrganicAsset[];
}

export interface IngestionConnectionResolver {
  resolve(scope: ReportingScope, accountId: string): Promise<ResolvedIngestionConnection>;
}

export interface IngestionRuntime {
  run(
    connection: ResolvedIngestionConnection,
    job: IngestionJobPayload,
  ): Promise<InsightsIngestionResult>;
}

export interface ReportingRuntimeResult {
  readonly ingestion: InsightsIngestionResult;
  readonly organicIngestions?: readonly OrganicIngestionResult[];
  readonly contentIngestions?: readonly OrganicContentIngestionResult[];
  readonly artifact: StoredReportArtifact;
}

export interface ReportingRuntime {
  run(
    connection: ResolvedIngestionConnection,
    job: ReportingJobPayload,
  ): Promise<ReportingRuntimeResult>;
}

export type IngestionAuditOutcome = "started" | "succeeded" | "rejected" | "failed";

export interface IngestionAuditEvent extends ReportingScope {
  readonly jobId: string;
  readonly accountId: string;
  readonly workloadSubject: string;
  readonly outcome: IngestionAuditOutcome;
  readonly code?: string;
  readonly occurredAt: string;
}

export interface IngestionAuditSink {
  record(event: IngestionAuditEvent): Promise<void>;
}

export interface AgencyIngestionWorkerResult extends ReportingScope {
  readonly jobId: string;
  readonly accountId: string;
  readonly rowsWritten: number;
  readonly pagesRead: number;
  readonly watermarkDate: string;
  readonly runId: string;
}

export interface AgencyReportingWorkerResult extends AgencyIngestionWorkerResult {
  readonly artifact: StoredReportArtifact;
}

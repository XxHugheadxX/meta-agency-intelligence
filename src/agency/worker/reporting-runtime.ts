import { requestContext } from "../../auth/token-store.js";
import { MetaApiClient } from "../../meta/client.js";
import type { ReportArtifactStore } from "../delivery/index.js";
import { AgencyExcelReportGenerator } from "../excel/index.js";
import type { HistoricalDataRepository } from "../historical-data/index.js";
import {
  AgencyInsightsIngestionService,
  AgencyOrganicContentIngestionService,
  AgencyOrganicIngestionService,
  InMemoryIngestionAssetPolicy,
  InMemoryOrganicAssetPolicy,
  MetaAdsInsightsReader,
  MetaPlatformContentReader,
  MetaOrganicInsightsReader,
  type IngestionCheckpointRepository,
  type ReadOnlyMetaClient,
} from "../ingestion/index.js";
import { AgencyReadOnlyReportingPipeline } from "../mvp/index.js";
import { AgencyReportingService } from "../reporting/index.js";
import type {
  ReportingJobPayload,
  ReportingRuntime,
  ResolvedIngestionConnection,
} from "./types.js";

export type ReportingReadOnlyMetaClientFactory = (
  apiVersion: string,
) => ReadOnlyMetaClient;

export class MetaAgencyReportingRuntime implements ReportingRuntime {
  constructor(
    private readonly historicalData: HistoricalDataRepository,
    private readonly checkpoints: IngestionCheckpointRepository,
    private readonly artifacts: ReportArtifactStore,
    private readonly clientFactory: ReportingReadOnlyMetaClientFactory = (apiVersion) =>
      new MetaApiClient({ apiVersion, mode: "read_only" }),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(connection: ResolvedIngestionConnection, job: ReportingJobPayload) {
    const client = this.clientFactory(job.apiVersion);
    const policy = new InMemoryIngestionAssetPolicy();
    policy.allow(connection.scope, connection.account.accountId);
    const organicPolicy = new InMemoryOrganicAssetPolicy();
    for (const asset of connection.organicAssets ?? []) {
      organicPolicy.allow(connection.scope, asset.platform, asset.assetId);
    }
    const pipeline = new AgencyReadOnlyReportingPipeline(
      new AgencyInsightsIngestionService(
        new MetaAdsInsightsReader(client),
        this.historicalData,
        this.checkpoints,
        policy,
        this.now,
      ),
      new AgencyReportingService(this.historicalData),
      new AgencyExcelReportGenerator(),
      new AgencyOrganicIngestionService(
        new MetaOrganicInsightsReader(client),
        this.historicalData,
        organicPolicy,
        this.now,
      ),
      new AgencyOrganicContentIngestionService(
        new MetaPlatformContentReader(client),
        this.historicalData,
        organicPolicy,
        this.now,
      ),
    );
    const generatedAt = this.now();

    return requestContext.run(
      {
        accessToken: connection.accessToken,
        tenantId: connection.scope.tenantId,
        workspaceId: connection.scope.workspaceId,
        allowedAccountIds: new Set([connection.account.accountId]),
        allowedAssetIds: new Set((connection.organicAssets ?? []).map(({ assetId }) => assetId)),
        allowedPageIds: new Set((connection.organicAssets ?? [])
          .filter(({ platform }) => platform === "facebook_page").map(({ assetId }) => assetId)),
        allowedInstagramIds: new Set((connection.organicAssets ?? [])
          .filter(({ platform }) => platform === "instagram").map(({ assetId }) => assetId)),
      },
      async () => {
        const result = await pipeline.run({
          ingestion: {
            scope: connection.scope,
            account: connection.account,
            startDate: job.startDate,
            endDate: job.endDate,
            level: job.level,
            apiVersion: job.apiVersion,
            attributionWindow: job.attributionWindow,
            breakdowns: job.breakdowns,
            mode: job.mode,
            lookbackDays: job.lookbackDays,
            runId: job.jobId,
          },
          organicIngestions: (connection.organicAssets ?? []).map((asset) => ({
            scope: connection.scope,
            asset,
            startDate: job.startDate,
            endDate: job.endDate,
            apiVersion: job.apiVersion,
            runId: `${job.jobId}:organic:${asset.platform}:${asset.assetId}`,
          })),
          contentIngestions: (connection.organicAssets ?? []).map((asset) => ({
            scope: connection.scope,
            asset,
            startDate: job.startDate,
            endDate: job.endDate,
            apiVersion: job.apiVersion,
            runId: `${job.jobId}:content:${asset.platform}:${asset.assetId}`,
          })),
          reportSourceAccountIds: {
            paid: [connection.account.accountId],
            organicAccount: (connection.organicAssets ?? []).map(({ assetId }) => assetId),
            content: (connection.organicAssets ?? []).map(({ assetId }) => assetId),
          },
          period: {
            kind: job.reportKind,
            startDate: job.reportStartDate,
            endDate: job.reportEndDate,
          },
          excel: { generatedAt },
        });
        const artifact = await this.artifacts.store(connection.scope, {
          jobId: job.jobId,
          period: result.report.period,
          report: result.excel,
          createdAt: generatedAt,
          retentionDays: job.retentionDays ?? 90,
        });
        return {
          ingestion: result.ingestion,
          organicIngestions: result.organicIngestions,
          contentIngestions: result.contentIngestions,
          artifact,
        };
      },
    );
  }
}

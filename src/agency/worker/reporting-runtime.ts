import { requestContext } from "../../auth/token-store.js";
import { MetaApiClient } from "../../meta/client.js";
import type { ReportArtifactStore } from "../delivery/index.js";
import { AgencyExcelReportGenerator } from "../excel/index.js";
import type { HistoricalDataRepository } from "../historical-data/index.js";
import {
  AgencyInsightsIngestionService,
  InMemoryIngestionAssetPolicy,
  MetaAdsInsightsReader,
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
    const policy = new InMemoryIngestionAssetPolicy();
    policy.allow(connection.scope, connection.account.accountId);
    const pipeline = new AgencyReadOnlyReportingPipeline(
      new AgencyInsightsIngestionService(
        new MetaAdsInsightsReader(this.clientFactory(job.apiVersion)),
        this.historicalData,
        this.checkpoints,
        policy,
        this.now,
      ),
      new AgencyReportingService(this.historicalData),
      new AgencyExcelReportGenerator(),
    );
    const generatedAt = this.now();

    return requestContext.run(
      {
        accessToken: connection.accessToken,
        tenantId: connection.scope.tenantId,
        workspaceId: connection.scope.workspaceId,
        allowedAccountIds: new Set([connection.account.accountId]),
        allowedAssetIds: new Set<string>(),
        allowedPageIds: new Set<string>(),
        allowedInstagramIds: new Set<string>(),
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
        return { ingestion: result.ingestion, artifact };
      },
    );
  }
}

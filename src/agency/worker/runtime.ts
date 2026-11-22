import { requestContext } from "../../auth/token-store.js";
import { MetaApiClient } from "../../meta/client.js";
import type { HistoricalDataRepository } from "../historical-data/index.js";
import {
  AgencyInsightsIngestionService,
  InMemoryIngestionAssetPolicy,
  MetaAdsInsightsReader,
  type IngestionCheckpointRepository,
  type ReadOnlyMetaClient,
} from "../ingestion/index.js";
import type {
  IngestionJobPayload,
  IngestionRuntime,
  ResolvedIngestionConnection,
} from "./types.js";

export type ReadOnlyMetaClientFactory = (apiVersion: string) => ReadOnlyMetaClient;

export class MetaAgencyIngestionRuntime implements IngestionRuntime {
  constructor(
    private readonly historicalData: HistoricalDataRepository,
    private readonly checkpoints: IngestionCheckpointRepository,
    private readonly clientFactory: ReadOnlyMetaClientFactory = (apiVersion) =>
      new MetaApiClient({ apiVersion, mode: "read_only" }),
  ) {}

  async run(connection: ResolvedIngestionConnection, job: IngestionJobPayload) {
    const policy = new InMemoryIngestionAssetPolicy();
    policy.allow(connection.scope, connection.account.accountId);
    const ingestion = new AgencyInsightsIngestionService(
      new MetaAdsInsightsReader(this.clientFactory(job.apiVersion)),
      this.historicalData,
      this.checkpoints,
      policy,
    );

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
      () => ingestion.run({
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
      }),
    );
  }
}

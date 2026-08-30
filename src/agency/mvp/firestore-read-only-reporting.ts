import type { Firestore } from "@google-cloud/firestore";
import { AgencyExcelReportGenerator } from "../excel/index.js";
import { FirestoreHistoricalDataRepository } from "../historical-data/index.js";
import {
  AgencyInsightsIngestionService,
  FirestoreIngestionCheckpointRepository,
  type IngestionAssetPolicy,
  type InsightsPageReader,
} from "../ingestion/index.js";
import { AgencyReportingService } from "../reporting/index.js";
import { AgencyReadOnlyReportingPipeline } from "./read-only-reporting-pipeline.js";

export interface FirestoreReadOnlyReportingDependencies {
  readonly db: Firestore;
  readonly reader: InsightsPageReader;
  readonly assetPolicy: IngestionAssetPolicy;
  readonly now?: () => string;
}

export function createFirestoreReadOnlyReportingPipeline(
  dependencies: FirestoreReadOnlyReportingDependencies,
): AgencyReadOnlyReportingPipeline {
  const historical = new FirestoreHistoricalDataRepository(dependencies.db);
  const checkpoints = new FirestoreIngestionCheckpointRepository(dependencies.db);
  return new AgencyReadOnlyReportingPipeline(
    new AgencyInsightsIngestionService(
      dependencies.reader,
      historical,
      checkpoints,
      dependencies.assetPolicy,
      dependencies.now,
    ),
    new AgencyReportingService(historical),
    new AgencyExcelReportGenerator(),
  );
}

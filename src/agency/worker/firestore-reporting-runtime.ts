import type { Firestore } from "@google-cloud/firestore";
import type { ReportArtifactStore } from "../delivery/index.js";
import {
  FirestoreHistoricalDataRepository,
  type PeriodReachRepository,
} from "../historical-data/index.js";
import { FirestoreIngestionCheckpointRepository } from "../ingestion/index.js";
import {
  MetaAgencyReportingRuntime,
  type ReportingReadOnlyMetaClientFactory,
} from "./reporting-runtime.js";

export interface FirestoreAgencyReportingRuntimeDependencies {
  readonly db: Firestore;
  readonly artifacts: ReportArtifactStore;
  readonly historicalData?: FirestoreHistoricalDataRepository;
  readonly checkpoints?: FirestoreIngestionCheckpointRepository;
  readonly clientFactory?: ReportingReadOnlyMetaClientFactory;
  readonly now?: () => string;
  readonly periodReach?: PeriodReachRepository;
  readonly readAdCreatives?: boolean;
}

export function createFirestoreAgencyReportingRuntime(
  dependencies: FirestoreAgencyReportingRuntimeDependencies,
): MetaAgencyReportingRuntime {
  return new MetaAgencyReportingRuntime(
    dependencies.historicalData ?? new FirestoreHistoricalDataRepository(dependencies.db),
    dependencies.checkpoints ?? new FirestoreIngestionCheckpointRepository(dependencies.db),
    dependencies.artifacts,
    dependencies.clientFactory,
    dependencies.now,
    dependencies.periodReach,
    dependencies.readAdCreatives,
  );
}

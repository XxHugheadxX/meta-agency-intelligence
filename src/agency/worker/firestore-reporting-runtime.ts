import type { Firestore } from "@google-cloud/firestore";
import type { ReportArtifactStore } from "../delivery/index.js";
import { FirestoreHistoricalDataRepository } from "../historical-data/index.js";
import { FirestoreIngestionCheckpointRepository } from "../ingestion/index.js";
import {
  MetaAgencyReportingRuntime,
  type ReportingReadOnlyMetaClientFactory,
} from "./reporting-runtime.js";

export interface FirestoreAgencyReportingRuntimeDependencies {
  readonly db: Firestore;
  readonly artifacts: ReportArtifactStore;
  readonly clientFactory?: ReportingReadOnlyMetaClientFactory;
  readonly now?: () => string;
}

export function createFirestoreAgencyReportingRuntime(
  dependencies: FirestoreAgencyReportingRuntimeDependencies,
): MetaAgencyReportingRuntime {
  return new MetaAgencyReportingRuntime(
    new FirestoreHistoricalDataRepository(dependencies.db),
    new FirestoreIngestionCheckpointRepository(dependencies.db),
    dependencies.artifacts,
    dependencies.clientFactory,
    dependencies.now,
  );
}

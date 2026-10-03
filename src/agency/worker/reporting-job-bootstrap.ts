import type { Firestore } from "@google-cloud/firestore";
import { FirestoreAssetBindingRepo } from "../../store/asset-binding-repo.js";
import { FirestoreMetaTokenRepo } from "../../store/meta-token-repo.js";
import type { SecurityConfig } from "../../transport/security-config.js";
import {
  FirestoreReportArtifactStore,
  GcsReportObjectStore,
} from "../delivery/index.js";
import { RepositoryIngestionConnectionResolver } from "./connection-resolver.js";
import {
  FirestoreAgencyAccountConnectionRepository,
  FirestoreIngestionAuditSink,
  FirestoreTenantWorkspacePolicy,
} from "./firestore-control-plane.js";
import { createFirestoreAgencyReportingRuntime } from "./firestore-reporting-runtime.js";
import { GoogleOidcWorkloadIdentityVerifier } from "./google-oidc-verifier.js";
import { PublicKeyIngestionJobVerifier } from "./job-verifier.js";
import { resolveReportingJobRuntimeConfig } from "./reporting-job-config.js";
import { FirestoreReportingJobLeaseRepository } from "./reporting-job-lease-repository.js";
import {
  AgencyReportingBatchCoordinator,
  FirestoreReportingBatchRepository,
} from "./reporting-batch-coordinator.js";
import { FirestoreHistoricalDataRepository } from "../historical-data/index.js";
import type { ReportingJobEndpointDependencies } from "./reporting-job-http-handler.js";
import { AgencyReportingWorker } from "./reporting-worker.js";
import { ReportingConcurrencyGate } from "../scheduler/index.js";

export interface ReportingJobBootstrapDependencies {
  readonly getDb: () => Firestore;
  readonly security: SecurityConfig;
  readonly serverUrl: URL;
  readonly env?: NodeJS.ProcessEnv;
}

export function createReportingJobEndpointDependencies(
  dependencies: ReportingJobBootstrapDependencies,
): ReportingJobEndpointDependencies | null {
  const config = resolveReportingJobRuntimeConfig(
    dependencies.security,
    dependencies.env,
  );
  if (!config.enabled) return null;
  const db = dependencies.getDb();

  const identities = new GoogleOidcWorkloadIdentityVerifier({
    audience: config.audience,
    serviceAccountEmail: config.serviceAccountEmail,
    serviceAccountSubject: config.serviceAccountSubject,
  });
  const artifacts = new FirestoreReportArtifactStore(
    db,
    new GcsReportObjectStore(config.reportBucket),
  );
  const connections = new RepositoryIngestionConnectionResolver(
    new FirestoreTenantWorkspacePolicy(db),
    new FirestoreAgencyAccountConnectionRepository(db),
    new FirestoreAssetBindingRepo(),
    new FirestoreMetaTokenRepo(),
    dependencies.serverUrl,
  );
  const historicalData = new FirestoreHistoricalDataRepository(db);
  const worker = new AgencyReportingWorker(
    identities,
    new PublicKeyIngestionJobVerifier(config.jobPublicKey),
    connections,
    createFirestoreAgencyReportingRuntime({ db, artifacts, historicalData }),
    new FirestoreIngestionAuditSink(db),
    undefined,
    {
      repository: new FirestoreReportingJobLeaseRepository(db),
      leaseTtlMs: config.leaseTtlMs,
      admission: new ReportingConcurrencyGate(),
    },
    new AgencyReportingBatchCoordinator(
      new FirestoreReportingBatchRepository(db),
      historicalData,
      artifacts,
      undefined,
      undefined,
      connections,
    ),
  );
  return { worker, identities };
}

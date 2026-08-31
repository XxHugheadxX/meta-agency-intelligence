import type { Firestore } from "@google-cloud/firestore";
import type { SecurityConfig } from "../../transport/security-config.js";
import { MetadataServerAccessTokenProvider } from "../delivery/index.js";
import { FirestoreAgencyAccountConnectionRepository } from "../worker/firestore-control-plane.js";
import { CloudKmsReportingPayloadSigner } from "./cloud-kms-signer.js";
import { GooglePubSubReportingQueuePublisher } from "./pubsub-publisher.js";
import { ReportingJobFanOut } from "./reporting-fan-out.js";
import { resolveReportingSchedulerConfig } from "./reporting-scheduler-config.js";

export interface ReportingSchedulerBootstrapDependencies {
  readonly getDb: () => Firestore;
  readonly security: SecurityConfig;
  readonly env?: NodeJS.ProcessEnv;
}

export function createReportingScheduler(
  dependencies: ReportingSchedulerBootstrapDependencies,
): ReportingJobFanOut | null {
  const config = resolveReportingSchedulerConfig(dependencies.security, dependencies.env);
  if (!config.enabled) return null;

  const tokens = new MetadataServerAccessTokenProvider();
  const signer = new CloudKmsReportingPayloadSigner(config.signingKeyVersion, tokens);
  const publisher = new GooglePubSubReportingQueuePublisher(config.pubSubTopic, tokens);
  const db = dependencies.getDb();
  return new ReportingJobFanOut(
    new FirestoreAgencyAccountConnectionRepository(db),
    signer,
    publisher,
  );
}

import type { Firestore } from "@google-cloud/firestore";
import type { SecurityConfig } from "../../transport/security-config.js";
import { MetadataServerAccessTokenProvider } from "../delivery/index.js";
import { FirestoreAgencyAccountConnectionRepository } from "../worker/firestore-control-plane.js";
import { GoogleOidcWorkloadIdentityVerifier } from "../worker/google-oidc-verifier.js";
import { CloudKmsReportingPayloadSigner } from "./cloud-kms-signer.js";
import { GooglePubSubReportingQueuePublisher } from "./pubsub-publisher.js";
import { ReportingJobFanOut } from "./reporting-fan-out.js";
import type {
  ReportingScheduleOptions,
  ReportingSchedulePublisher,
} from "./reporting-schedule-http-handler.js";
import {
  resolveReportingSchedulerConfig,
  type ReportingSchedulerConfig,
} from "./reporting-scheduler-config.js";

export interface ReportingSchedulerBootstrapDependencies {
  readonly getDb: () => Firestore;
  readonly security: SecurityConfig;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ReportingScheduleEndpointDependencies {
  readonly scheduler: ReportingSchedulePublisher;
  readonly identities: GoogleOidcWorkloadIdentityVerifier;
  readonly options: ReportingScheduleOptions;
}

function composeScheduler(
  dependencies: ReportingSchedulerBootstrapDependencies,
  config: Extract<ReportingSchedulerConfig, { readonly enabled: true }>,
): ReportingJobFanOut {
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

export function createReportingScheduler(
  dependencies: ReportingSchedulerBootstrapDependencies,
): ReportingJobFanOut | null {
  const config = resolveReportingSchedulerConfig(dependencies.security, dependencies.env);
  if (!config.enabled) return null;
  return composeScheduler(dependencies, config);
}

export function createReportingScheduleEndpointDependencies(
  dependencies: ReportingSchedulerBootstrapDependencies,
): ReportingScheduleEndpointDependencies | null {
  const config = resolveReportingSchedulerConfig(dependencies.security, dependencies.env);
  if (!config.enabled) return null;
  const identities = new GoogleOidcWorkloadIdentityVerifier({
    audience: config.triggerAudience,
    serviceAccountEmail: config.triggerServiceAccountEmail,
    serviceAccountSubject: config.triggerServiceAccountSubject,
  });
  const scheduler = composeScheduler(dependencies, config);
  return {
    scheduler,
    identities,
    options: {
      timeZone: config.timeZone,
      apiVersion: config.apiVersion,
      attributionWindow: config.attributionWindow,
      retentionDays: config.retentionDays,
      ingestionLookbackDays: config.ingestionLookbackDays,
    },
  };
}

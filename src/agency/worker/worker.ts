import { assertIsoDate, assertReportingScope } from "../historical-data/index.js";
import type {
  AgencyIngestionWorkerResult,
  IngestionAuditSink,
  IngestionAuditOutcome,
  IngestionConnectionResolver,
  IngestionJobEnvelope,
  IngestionJobPayload,
  IngestionJobVerifier,
  IngestionRuntime,
  VerifiedWorkloadIdentity,
  WorkloadIdentityVerifier,
  ResolvedIngestionConnection,
} from "./types.js";

const FORBIDDEN_SCOPES = new Set([
  "ads_management",
  "instagram_content_publish",
  "pages_manage_ads",
  "pages_manage_metadata",
  "pages_manage_posts",
  "pages_messaging",
  "whatsapp_business_management",
  "whatsapp_business_messaging",
]);

export function validateIngestionJob(job: IngestionJobPayload): void {
  assertReportingScope(job);
  assertIsoDate(job.startDate, "startDate");
  assertIsoDate(job.endDate, "endDate");
  if (job.startDate > job.endDate) throw new Error("Invalid ingestion date window");
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(job.jobId)) throw new Error("Invalid ingestion jobId");
  if (!/^act_\d+$/.test(job.accountId)) throw new Error("Invalid ingestion accountId");
  if (!/^v\d+\.\d+$/.test(job.apiVersion)) throw new Error("Invalid Meta API version");
  if (!["account", "campaign", "ad_set", "ad"].includes(job.level)) {
    throw new Error("Invalid ingestion level");
  }
  if (job.mode !== undefined && job.mode !== "backfill" && job.mode !== "incremental") {
    throw new Error("Invalid ingestion mode");
  }
  if (
    job.lookbackDays !== undefined &&
    (!Number.isInteger(job.lookbackDays) || job.lookbackDays < 1 || job.lookbackDays > 30)
  ) {
    throw new Error("Invalid ingestion lookbackDays");
  }
  if (
    job.breakdowns !== undefined &&
    (!Array.isArray(job.breakdowns) ||
      job.breakdowns.length > 2 ||
      job.breakdowns.some((breakdown) => typeof breakdown !== "string"))
  ) {
    throw new Error("Invalid ingestion breakdowns");
  }
  if (
    job.attributionWindow !== undefined &&
    job.attributionWindow !== null &&
    (typeof job.attributionWindow !== "string" || job.attributionWindow.length > 64)
  ) {
    throw new Error("Invalid ingestion attributionWindow");
  }
}

export function assertSchedulerIdentity(identity: VerifiedWorkloadIdentity): void {
  if (!identity.subject.trim() || !identity.issuer.trim() || !identity.audience.trim()) {
    throw new Error("Verified workload identity is incomplete");
  }
  if (!identity.roles.includes("scheduler")) {
    throw new Error("Workload identity lacks the scheduler role");
  }
}

export function assertReadOnlyConnection(connection: ResolvedIngestionConnection): void {
  if (!connection.scopes.includes("ads_read")) {
    throw new Error("Resolved Meta token lacks ads_read");
  }
  if (connection.scopes.some((scope) => FORBIDDEN_SCOPES.has(scope))) {
    throw new Error("Resolved Meta token carries a forbidden write scope");
  }
}

function auditEvent(
  job: IngestionJobPayload,
  identity: VerifiedWorkloadIdentity,
  outcome: IngestionAuditOutcome,
  occurredAt: string,
  code?: string,
) {
  return {
    tenantId: job.tenantId,
    workspaceId: job.workspaceId,
    jobId: job.jobId,
    accountId: job.accountId,
    workloadSubject: identity.subject,
    outcome,
    ...(code ? { code } : {}),
    occurredAt,
  };
}

export class AgencyIngestionWorker {
  constructor(
    private readonly identities: WorkloadIdentityVerifier,
    private readonly jobs: IngestionJobVerifier,
    private readonly connections: IngestionConnectionResolver,
    private readonly runtime: IngestionRuntime,
    private readonly audit: IngestionAuditSink,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(envelope: IngestionJobEnvelope): Promise<AgencyIngestionWorkerResult> {
    let identity: VerifiedWorkloadIdentity | undefined;
    let job: IngestionJobPayload | undefined;
    try {
      identity = await this.identities.verify(envelope.authorization);
      assertSchedulerIdentity(identity);
      job = await this.jobs.verify(envelope.payload, envelope.signature);
      validateIngestionJob(job);
      await this.audit.record(auditEvent(job, identity, "started", this.now()));

      const connection = await this.connections.resolve(job, job.accountId);
      assertReadOnlyConnection(connection);
      const result = await this.runtime.run(connection, job);
      await this.audit.record(auditEvent(job, identity, "succeeded", this.now()));
      return {
        tenantId: job.tenantId,
        workspaceId: job.workspaceId,
        jobId: job.jobId,
        accountId: job.accountId,
        rowsWritten: result.rowsWritten,
        pagesRead: result.pagesRead,
        watermarkDate: result.watermarkDate,
        runId: result.runId,
      };
    } catch {
      if (identity && job) {
        await this.audit.record(
          auditEvent(job, identity, "failed", this.now(), "INGESTION_REJECTED"),
        );
      }
      throw new Error("Agency ingestion job was rejected or failed");
    }
  }
}

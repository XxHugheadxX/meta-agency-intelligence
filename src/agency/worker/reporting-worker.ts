import { assertIsoDate } from "../historical-data/index.js";
import type {
  AgencyReportingWorkerResult,
  IngestionAuditSink,
  IngestionConnectionResolver,
  IngestionJobEnvelope,
  IngestionJobVerifier,
  ReportingJobPayload,
  ReportingRuntime,
  ReportingRuntimeResult,
  VerifiedWorkloadIdentity,
  WorkloadIdentityVerifier,
} from "./types.js";
import {
  assertReadOnlyConnection,
  assertSchedulerIdentity,
  validateIngestionJob,
} from "./worker.js";

function validateReportingJob(job: ReportingJobPayload): void {
  validateIngestionJob(job);
  assertIsoDate(job.reportStartDate, "reportStartDate");
  assertIsoDate(job.reportEndDate, "reportEndDate");
  if (job.reportKind !== "week" && job.reportKind !== "month") {
    throw new Error("Invalid reporting period kind");
  }
  if (
    job.reportStartDate > job.reportEndDate ||
    job.reportStartDate < job.startDate ||
    job.reportEndDate > job.endDate
  ) {
    throw new Error("Report period must be contained within the ingestion window");
  }
  if (
    job.retentionDays !== undefined &&
    (!Number.isInteger(job.retentionDays) || job.retentionDays < 1 || job.retentionDays > 365)
  ) {
    throw new Error("Invalid report retentionDays");
  }
}

function auditEvent(
  job: ReportingJobPayload,
  identity: VerifiedWorkloadIdentity,
  outcome: "started" | "succeeded" | "failed",
  occurredAt: string,
) {
  return {
    tenantId: job.tenantId,
    workspaceId: job.workspaceId,
    jobId: job.jobId,
    accountId: job.accountId,
    workloadSubject: identity.subject,
    outcome,
    ...(outcome === "failed" ? { code: "REPORTING_REJECTED" } : {}),
    occurredAt,
  } as const;
}

function assertRuntimeResult(job: ReportingJobPayload, result: ReportingRuntimeResult): void {
  const artifact = result.artifact;
  if (
    result.ingestion.scope.tenantId !== job.tenantId ||
    result.ingestion.scope.workspaceId !== job.workspaceId ||
    result.ingestion.accountId !== job.accountId ||
    result.ingestion.runId !== job.jobId ||
    artifact.tenantId !== job.tenantId ||
    artifact.workspaceId !== job.workspaceId ||
    artifact.jobId !== job.jobId ||
    artifact.period.kind !== job.reportKind ||
    artifact.period.startDate !== job.reportStartDate ||
    artifact.period.endDate !== job.reportEndDate
  ) {
    throw new Error("Reporting runtime returned a mismatched tenant-scoped result");
  }
}

export class AgencyReportingWorker {
  constructor(
    private readonly identities: WorkloadIdentityVerifier,
    private readonly jobs: IngestionJobVerifier,
    private readonly connections: IngestionConnectionResolver,
    private readonly runtime: ReportingRuntime,
    private readonly audit: IngestionAuditSink,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(envelope: IngestionJobEnvelope): Promise<AgencyReportingWorkerResult> {
    let identity: VerifiedWorkloadIdentity | undefined;
    let job: ReportingJobPayload | undefined;
    try {
      identity = await this.identities.verify(envelope.authorization);
      assertSchedulerIdentity(identity);
      const verified = await this.jobs.verify(envelope.payload, envelope.signature);
      job = verified as ReportingJobPayload;
      validateReportingJob(job);
      await this.audit.record(auditEvent(job, identity, "started", this.now()));

      const connection = await this.connections.resolve(job, job.accountId);
      assertReadOnlyConnection(connection);
      const result = await this.runtime.run(connection, job);
      assertRuntimeResult(job, result);
      const response: AgencyReportingWorkerResult = {
        tenantId: job.tenantId,
        workspaceId: job.workspaceId,
        jobId: job.jobId,
        accountId: job.accountId,
        rowsWritten: result.ingestion.rowsWritten,
        pagesRead: result.ingestion.pagesRead,
        watermarkDate: result.ingestion.watermarkDate,
        runId: result.ingestion.runId,
        artifact: result.artifact,
      };
      await this.audit.record(auditEvent(job, identity, "succeeded", this.now()));
      return response;
    } catch {
      if (identity && job) {
        await this.audit.record(auditEvent(job, identity, "failed", this.now()));
      }
      throw new Error("Agency reporting job was rejected or failed");
    }
  }
}

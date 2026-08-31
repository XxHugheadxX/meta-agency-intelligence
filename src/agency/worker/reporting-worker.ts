import { createHash } from "node:crypto";
import { assertIsoDate } from "../historical-data/index.js";
import {
  ReportingBackpressureError,
  type ReportingConcurrencyGate,
} from "../scheduler/index.js";
import {
  type ReportingJobLeaseHandle,
  type ReportingJobLeaseRepository,
} from "./reporting-job-lease-repository.js";
import type { ReportingBatchCompletionSink } from "./reporting-batch-coordinator.js";
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

const DEFAULT_LEASE_TTL_MS = 60_000;

export interface AgencyReportingWorkerLeaseOptions {
  readonly repository: ReportingJobLeaseRepository;
  readonly leaseTtlMs?: number;
  readonly admission?: Pick<ReportingConcurrencyGate, "run">;
}

interface LeaseHeartbeatState {
  readonly handle: ReportingJobLeaseHandle;
  readonly lost: boolean;
}

interface LeaseHeartbeat {
  stop(): Promise<LeaseHeartbeatState>;
}

function requestFingerprint(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function busyRetryAfterMs(expiresAt: string): number {
  const remaining = Date.parse(expiresAt) - Date.now();
  return Math.min(15 * 60_000, Math.max(1_000, Number.isFinite(remaining) ? remaining : 5_000));
}

function startLeaseHeartbeat(
  repository: ReportingJobLeaseRepository,
  job: ReportingJobPayload,
  initialHandle: ReportingJobLeaseHandle,
  leaseTtlMs: number,
): LeaseHeartbeat {
  let handle = initialHandle;
  let lost = false;
  let stopped = false;
  let pending = Promise.resolve();
  const intervalMs = Math.max(250, Math.floor(leaseTtlMs / 3));
  const timer = setInterval(() => {
    if (stopped || lost) return;
    pending = pending.then(async () => {
      if (stopped || lost) return;
      try {
        const renewed = await repository.renew(job, job.jobId, handle, leaseTtlMs);
        if (!renewed) {
          lost = true;
          return;
        }
        handle = renewed;
      } catch {
        lost = true;
      }
    });
  }, intervalMs);
  timer.unref();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await pending;
      return { handle, lost };
    },
  };
}

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
  if ((job.batchId === undefined) !== (job.batchAccountIds === undefined)) {
    throw new Error("Reporting batch identity and accounts must be provided together");
  }
  if (job.batchId !== undefined && job.batchAccountIds !== undefined) {
    if (!/^batch-[a-f0-9]{40}$/.test(job.batchId)) {
      throw new Error("Invalid reporting batchId");
    }
    if (job.batchAccountIds.length < 1 || job.batchAccountIds.length > 100) {
      throw new Error("Reporting batch account count is invalid");
    }
    const sorted = [...job.batchAccountIds].sort();
    if (
      sorted.some((accountId, index) =>
        !/^act_[0-9]+$/.test(accountId) ||
        accountId !== job.batchAccountIds?.[index] ||
        (index > 0 && accountId === sorted[index - 1])) ||
      !job.batchAccountIds.includes(job.accountId)
    ) {
      throw new Error("Reporting batch accounts are invalid");
    }
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
  const organicResults = [
    ...(result.organicIngestions ?? []),
    ...(result.contentIngestions ?? []),
  ];
  if (organicResults.some((ingestion) =>
    ingestion.scope.tenantId !== job.tenantId ||
    ingestion.scope.workspaceId !== job.workspaceId ||
    ingestion.startDate !== job.startDate ||
    ingestion.endDate !== job.endDate)) {
    throw new Error("Reporting runtime returned a mismatched organic ingestion result");
  }
}

function assertReplayResult(job: ReportingJobPayload, result: AgencyReportingWorkerResult): void {
  if (
    result.tenantId !== job.tenantId ||
    result.workspaceId !== job.workspaceId ||
    result.jobId !== job.jobId ||
    result.accountId !== job.accountId ||
    result.runId !== job.jobId ||
    result.artifact.tenantId !== job.tenantId ||
    result.artifact.workspaceId !== job.workspaceId ||
    result.artifact.jobId !== job.jobId ||
    result.artifact.period.kind !== job.reportKind ||
    result.artifact.period.startDate !== job.reportStartDate ||
    result.artifact.period.endDate !== job.reportEndDate
  ) {
    throw new Error("Reporting lease returned a mismatched tenant-scoped result");
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
    private readonly leaseOptions?: AgencyReportingWorkerLeaseOptions,
    private readonly batches?: ReportingBatchCompletionSink,
  ) {}

  async run(envelope: IngestionJobEnvelope): Promise<AgencyReportingWorkerResult> {
    let identity: VerifiedWorkloadIdentity | undefined;
    let job: ReportingJobPayload | undefined;
    let heartbeat: LeaseHeartbeat | undefined;
    let leaseHandle: ReportingJobLeaseHandle | undefined;
    let fingerprint: string | undefined;
    try {
      identity = await this.identities.verify(envelope.authorization);
      assertSchedulerIdentity(identity);
      const verified = await this.jobs.verify(envelope.payload, envelope.signature);
      job = verified as ReportingJobPayload;
      validateReportingJob(job);
      const validatedJob = job;

      if (this.leaseOptions) {
        const leaseTtlMs = this.leaseOptions.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
        fingerprint = requestFingerprint(envelope.payload);
        const claim = await this.leaseOptions.repository.claim(
          job,
          job.jobId,
          fingerprint,
          identity.subject,
          leaseTtlMs,
        );
        if (claim.status === "busy") {
          throw new ReportingBackpressureError(busyRetryAfterMs(claim.expiresAt));
        }
        if (claim.status === "completed") {
          assertReplayResult(job, claim.result);
          await this.audit.record(auditEvent(job, identity, "started", this.now()));
          await this.audit.record(auditEvent(job, identity, "succeeded", this.now()));
          return claim.result;
        }
        leaseHandle = claim.handle;
        heartbeat = startLeaseHeartbeat(
          this.leaseOptions.repository,
          job,
          leaseHandle,
          leaseTtlMs,
        );
      }

      await this.audit.record(auditEvent(job, identity, "started", this.now()));

      const execute = async () => {
        const connection = await this.connections.resolve(validatedJob, validatedJob.accountId);
        assertReadOnlyConnection(connection);
        return this.runtime.run(connection, validatedJob);
      };
      const result = this.leaseOptions?.admission
        ? await this.leaseOptions.admission.run(validatedJob, execute)
        : await execute();
      assertRuntimeResult(job, result);
      const organicRows = (result.organicIngestions ?? [])
        .reduce((total, ingestion) => total + ingestion.rowsWritten, 0);
      const contentRows = (result.contentIngestions ?? [])
        .reduce((total, ingestion) => total + ingestion.rowsWritten, 0);
      const organicPages = (result.organicIngestions ?? [])
        .reduce((total, ingestion) => total + ingestion.pagesRead, 0);
      const contentPages = (result.contentIngestions ?? [])
        .reduce((total, ingestion) => total + ingestion.pagesRead, 0);
      const response: AgencyReportingWorkerResult = {
        tenantId: job.tenantId,
        workspaceId: job.workspaceId,
        jobId: job.jobId,
        accountId: job.accountId,
        rowsWritten: result.ingestion.rowsWritten + organicRows + contentRows,
        pagesRead: result.ingestion.pagesRead + organicPages + contentPages,
        watermarkDate: result.ingestion.watermarkDate,
        runId: result.ingestion.runId,
        artifact: result.artifact,
      };

      await this.batches?.record(job);

      if (this.leaseOptions && heartbeat && leaseHandle && fingerprint) {
        const heartbeatState = await heartbeat.stop();
        heartbeat = undefined;
        leaseHandle = heartbeatState.handle;
        if (
          heartbeatState.lost ||
          !await this.leaseOptions.repository.complete(
            job,
            job.jobId,
            fingerprint,
            leaseHandle,
            response,
          )
        ) {
          throw new Error("Reporting job lease was lost before completion");
        }
      }

      await this.audit.record(auditEvent(job, identity, "succeeded", this.now()));
      return response;
    } catch (error) {
      if (this.leaseOptions && job && heartbeat) {
        try {
          const heartbeatState = await heartbeat.stop();
          if (!heartbeatState.lost) {
            await this.leaseOptions.repository.release(job, job.jobId, heartbeatState.handle);
          }
        } catch {
          // The original failure remains authoritative and is sanitized below.
        }
      }
      if (identity && job) {
        await this.audit.record(auditEvent(job, identity, "failed", this.now()));
      }
      if (error instanceof ReportingBackpressureError) throw error;
      throw new Error("Agency reporting job was rejected or failed");
    }
  }
}

import { randomUUID } from "node:crypto";
import type { Firestore } from "@google-cloud/firestore";
import type { ReportArtifactStore, StoredReportArtifact } from "../delivery/index.js";
import { AgencyExcelReportGenerator } from "../excel/index.js";
import { assertReportingScope, type HistoricalDataRepository, type ReportingScope } from "../historical-data/index.js";
import { AgencyReportingService } from "../reporting/index.js";
import type { ReportingJobPayload } from "./types.js";

const CLAIM_TTL_MS = 5 * 60_000;
const COLLECTION = "agency_reporting_batches";

export interface ReportingBatchClaim {
  readonly batchId: string;
  readonly leaseId: string;
  readonly fence: number;
}

interface BatchCompletionInput {
  readonly batchId: string;
  readonly expectedAccountIds: readonly string[];
  readonly accountId: string;
  readonly reportKind: "week" | "month";
  readonly startDate: string;
  readonly endDate: string;
}

export type ReportingBatchRecordResult =
  | { readonly status: "waiting" | "complete" }
  | { readonly status: "claimed"; readonly claim: ReportingBatchClaim };

export interface ReportingBatchRepository {
  record(scope: ReportingScope, input: BatchCompletionInput): Promise<ReportingBatchRecordResult>;
  complete(scope: ReportingScope, claim: ReportingBatchClaim, artifactId: string): Promise<boolean>;
  release(scope: ReportingScope, claim: ReportingBatchClaim): Promise<void>;
}

export interface ReportingBatchCompletionSink {
  record(job: ReportingJobPayload): Promise<StoredReportArtifact | null>;
}

interface BatchState extends Omit<BatchCompletionInput, "accountId">, ReportingScope {
  completedAccountIds: string[];
  status: "collecting" | "generating" | "complete";
  leaseId: string | null;
  fence: number;
  claimExpiresAt: number | null;
  artifactId: string | null;
}

function initialState(scope: ReportingScope, input: BatchCompletionInput): BatchState {
  return {
    ...scope,
    batchId: input.batchId,
    expectedAccountIds: [...input.expectedAccountIds],
    reportKind: input.reportKind,
    startDate: input.startDate,
    endDate: input.endDate,
    completedAccountIds: [], status: "collecting", leaseId: null, fence: 0,
    claimExpiresAt: null, artifactId: null,
  };
}

function assertInput(scope: ReportingScope, input: BatchCompletionInput): void {
  assertReportingScope(scope);
  if (!/^batch-[a-f0-9]{40}$/.test(input.batchId)) throw new Error("Invalid reporting batchId");
  if (input.expectedAccountIds.length < 1 || input.expectedAccountIds.length > 100) throw new Error("Invalid reporting batch membership");
  const sorted = [...input.expectedAccountIds].sort();
  if (sorted.some((id, index) => !/^act_\d+$/.test(id) || id !== input.expectedAccountIds[index] || (index > 0 && id === sorted[index - 1])) || !input.expectedAccountIds.includes(input.accountId)) throw new Error("Invalid reporting batch membership");
}

function sameBatch(state: BatchState, scope: ReportingScope, input: BatchCompletionInput): boolean {
  return state.tenantId === scope.tenantId && state.workspaceId === scope.workspaceId &&
    state.batchId === input.batchId && state.reportKind === input.reportKind &&
    state.startDate === input.startDate && state.endDate === input.endDate &&
    JSON.stringify(state.expectedAccountIds) === JSON.stringify(input.expectedAccountIds);
}

function claim(state: BatchState, now: number): ReportingBatchClaim {
  state.status = "generating";
  state.leaseId = randomUUID();
  state.fence += 1;
  state.claimExpiresAt = now + CLAIM_TTL_MS;
  return { batchId: state.batchId, leaseId: state.leaseId, fence: state.fence };
}

export class InMemoryReportingBatchRepository implements ReportingBatchRepository {
  private readonly states = new Map<string, BatchState>();
  constructor(private readonly now: () => number = Date.now) {}
  private key(scope: ReportingScope, batchId: string): string { return `${scope.tenantId}\u001f${scope.workspaceId}\u001f${batchId}`; }

  async record(scope: ReportingScope, input: BatchCompletionInput): Promise<ReportingBatchRecordResult> {
    assertInput(scope, input);
    const key = this.key(scope, input.batchId);
    let state = this.states.get(key);
    if (!state) {
      state = initialState(scope, input);
      this.states.set(key, state);
    } else if (!sameBatch(state, scope, input)) throw new Error("Reporting batch identity collision");
    if (!state.completedAccountIds.includes(input.accountId)) state.completedAccountIds.push(input.accountId);
    state.completedAccountIds.sort();
    if (state.status === "complete") return { status: "complete" };
    const now = this.now();
    if (state.completedAccountIds.length !== state.expectedAccountIds.length ||
      (state.status === "generating" && (state.claimExpiresAt ?? Infinity) > now)) return { status: "waiting" };
    return { status: "claimed", claim: claim(state, now) };
  }

  async complete(scope: ReportingScope, current: ReportingBatchClaim, artifactId: string): Promise<boolean> {
    const state = this.states.get(this.key(scope, current.batchId));
    if (!state || state.status !== "generating" || state.leaseId !== current.leaseId || state.fence !== current.fence || !/^[a-f0-9]{64}$/.test(artifactId)) return false;
    state.status = "complete"; state.artifactId = artifactId; state.claimExpiresAt = null;
    return true;
  }

  async release(scope: ReportingScope, current: ReportingBatchClaim): Promise<void> {
    const state = this.states.get(this.key(scope, current.batchId));
    if (state?.status === "generating" && state.leaseId === current.leaseId && state.fence === current.fence) {
      state.status = "collecting"; state.leaseId = null; state.claimExpiresAt = null;
    }
  }
}

function firestoreState(scope: ReportingScope, batchId: string, data: unknown): BatchState {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Stored reporting batch is invalid");
  const state = data as BatchState & { schemaVersion?: unknown };
  const expectedKeys = ["artifactId", "batchId", "claimExpiresAt", "completedAccountIds", "endDate", "expectedAccountIds", "fence", "leaseId", "reportKind", "schemaVersion", "startDate", "status", "tenantId", "workspaceId"];
  if (Object.keys(state).sort().join("\u001f") !== expectedKeys.join("\u001f") ||
    state.schemaVersion !== 1 || state.batchId !== batchId || state.tenantId !== scope.tenantId || state.workspaceId !== scope.workspaceId ||
    !Array.isArray(state.expectedAccountIds) || !Array.isArray(state.completedAccountIds) ||
    !["collecting", "generating", "complete"].includes(state.status) || !Number.isSafeInteger(state.fence)) {
    throw new Error("Stored reporting batch identity is invalid");
  }
  const { schemaVersion: _schemaVersion, ...result } = state;
  return structuredClone(result);
}

export class FirestoreReportingBatchRepository implements ReportingBatchRepository {
  constructor(private readonly db: Firestore, private readonly now: () => number = Date.now) {}
  private reference(scope: ReportingScope, batchId: string) {
    assertReportingScope(scope);
    return this.db.collection("agency_tenants").doc(scope.tenantId)
      .collection("workspaces").doc(scope.workspaceId).collection(COLLECTION).doc(batchId);
  }

  async record(scope: ReportingScope, input: BatchCompletionInput): Promise<ReportingBatchRecordResult> {
    assertInput(scope, input);
    const reference = this.reference(scope, input.batchId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      const state: BatchState = snapshot.exists
        ? firestoreState(scope, input.batchId, snapshot.data())
        : initialState(scope, input);
      if (!sameBatch(state, scope, input)) throw new Error("Reporting batch identity collision");
      if (!state.completedAccountIds.includes(input.accountId)) state.completedAccountIds.push(input.accountId);
      state.completedAccountIds.sort();
      let result: ReportingBatchRecordResult = { status: "waiting" };
      if (state.status === "complete") result = { status: "complete" };
      else if (state.completedAccountIds.length === state.expectedAccountIds.length &&
        (state.status !== "generating" || (state.claimExpiresAt ?? 0) <= this.now())) {
        result = { status: "claimed", claim: claim(state, this.now()) };
      }
      transaction.set(reference, { schemaVersion: 1, ...state }, { merge: false });
      return result;
    });
  }

  async complete(scope: ReportingScope, current: ReportingBatchClaim, artifactId: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(artifactId)) return false;
    const reference = this.reference(scope, current.batchId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) return false;
      const state = firestoreState(scope, current.batchId, snapshot.data());
      if (state.status !== "generating" || state.leaseId !== current.leaseId || state.fence !== current.fence) return false;
      state.status = "complete"; state.artifactId = artifactId; state.claimExpiresAt = null;
      transaction.set(reference, { schemaVersion: 1, ...state }, { merge: false });
      return true;
    });
  }

  async release(scope: ReportingScope, current: ReportingBatchClaim): Promise<void> {
    const reference = this.reference(scope, current.batchId);
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) return;
      const state = firestoreState(scope, current.batchId, snapshot.data());
      if (state.status === "generating" && state.leaseId === current.leaseId && state.fence === current.fence) {
        state.status = "collecting"; state.leaseId = null; state.claimExpiresAt = null;
        transaction.set(reference, { schemaVersion: 1, ...state }, { merge: false });
      }
    });
  }
}

export class AgencyReportingBatchCoordinator implements ReportingBatchCompletionSink {
  constructor(
    private readonly batches: ReportingBatchRepository,
    private readonly historical: HistoricalDataRepository,
    private readonly artifacts: ReportArtifactStore,
    private readonly excel = new AgencyExcelReportGenerator(),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async record(job: ReportingJobPayload): Promise<StoredReportArtifact | null> {
    if (!job.batchId || !job.batchAccountIds) return null;
    const scope = { tenantId: job.tenantId, workspaceId: job.workspaceId };
    const recorded = await this.batches.record(scope, {
      batchId: job.batchId, expectedAccountIds: job.batchAccountIds, accountId: job.accountId,
      reportKind: job.reportKind, startDate: job.reportStartDate, endDate: job.reportEndDate,
    });
    if (recorded.status !== "claimed") return null;
    try {
      const generatedAt = this.now();
      const report = await new AgencyReportingService(this.historical).createUnifiedReport(scope, {
        period: { kind: job.reportKind, startDate: job.reportStartDate, endDate: job.reportEndDate },
        paidGranularity: job.level,
      });
      const artifact = await this.artifacts.store(scope, {
        jobId: job.batchId,
        period: report.period,
        report: this.excel.generate(report, { generatedAt, filename: `meta-agency-consolidated-${job.reportStartDate}-to-${job.reportEndDate}.xlsx` }),
        createdAt: generatedAt,
        retentionDays: job.retentionDays ?? 90,
      });
      if (!await this.batches.complete(scope, recorded.claim, artifact.artifactId)) throw new Error("Reporting batch generation claim was lost");
      return artifact;
    } catch (error) {
      await this.batches.release(scope, recorded.claim);
      throw error;
    }
  }
}

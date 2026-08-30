import { randomUUID } from "node:crypto";
import type { Firestore } from "@google-cloud/firestore";
import type { ReportingScope } from "../historical-data/index.js";

const COLLECTION = "agency_reporting_job_leases";
const MIN_LEASE_TTL_MS = 1_000;
const MAX_LEASE_TTL_MS = 15 * 60 * 1_000;
const COMPLETED_RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_IDENTIFIER_LENGTH = 128;

export interface ReportingJobReplayResult {
  readonly artifactId: string;
  readonly runId: string;
  readonly rowsWritten: number;
  readonly pagesRead: number;
  readonly watermarkDate: string;
}

export interface ReportingJobLeaseHandle {
  readonly leaseId: string;
  readonly fence: number;
  readonly expiresAt: string;
}

export type ReportingJobClaim =
  | { readonly status: "acquired"; readonly handle: ReportingJobLeaseHandle }
  | { readonly status: "busy"; readonly expiresAt: string }
  | { readonly status: "completed"; readonly result: ReportingJobReplayResult };

export interface ReportingJobLeaseRepository {
  claim(scope: ReportingScope, jobId: string, requestFingerprint: string, holderId: string, leaseTtlMs: number): Promise<ReportingJobClaim>;
  renew(scope: ReportingScope, jobId: string, handle: ReportingJobLeaseHandle, leaseTtlMs: number): Promise<ReportingJobLeaseHandle | null>;
  complete(scope: ReportingScope, jobId: string, requestFingerprint: string, handle: ReportingJobLeaseHandle, result: ReportingJobReplayResult): Promise<boolean>;
  release(scope: ReportingScope, jobId: string, handle: ReportingJobLeaseHandle): Promise<boolean>;
}

interface ActiveRecord extends ReportingScope {
  readonly schemaVersion: 2;
  readonly jobId: string;
  readonly status: "active";
  readonly requestFingerprint: string;
  readonly holderId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface CompletedRecord extends ReportingScope {
  readonly schemaVersion: 2;
  readonly jobId: string;
  readonly status: "completed";
  readonly requestFingerprint: string;
  readonly completedLeaseId: string;
  readonly completedFence: number;
  readonly result: ReportingJobReplayResult;
  readonly deleteAfter: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type StoredRecord = ActiveRecord | CompletedRecord;

function assertIdentifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH || value.trim() !== value || /[\u0000-\u001f\u007f/]/.test(value)) {
    throw new Error(`${field} must be a bounded identifier without controls or path separators`);
  }
}

function assertScope(scope: ReportingScope): void {
  if (!scope || typeof scope !== "object") throw new Error("A reporting scope is required");
  assertIdentifier(scope.tenantId, "tenantId");
  assertIdentifier(scope.workspaceId, "workspaceId");
}

function assertFingerprint(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("requestFingerprint must be a lowercase SHA-256 hex digest");
}

function assertTtl(leaseTtlMs: number): void {
  if (!Number.isInteger(leaseTtlMs) || leaseTtlMs < MIN_LEASE_TTL_MS || leaseTtlMs > MAX_LEASE_TTL_MS) throw new Error(`leaseTtlMs must be between ${MIN_LEASE_TTL_MS} and ${MAX_LEASE_TTL_MS}`);
}

function assertFence(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
}

function assertLeaseId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${field} must be a UUID v4`);
}

function assertIsoDate(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} must be an ISO calendar date`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`${field} must be an ISO calendar date`);
}

function assertPublicResult(value: unknown): asserts value is ReportingJobReplayResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Reporting job replay result must be an object");
  const result = value as Record<string, unknown>;
  const keys = Object.keys(result).sort();
  const expected = ["artifactId", "pagesRead", "rowsWritten", "runId", "watermarkDate"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error("Reporting job replay result contains unsupported fields");
  assertIdentifier(result.artifactId, "result.artifactId");
  assertIdentifier(result.runId, "result.runId");
  if (typeof result.rowsWritten !== "number" || !Number.isSafeInteger(result.rowsWritten) || result.rowsWritten < 0) throw new Error("result.rowsWritten must be a non-negative safe integer");
  if (typeof result.pagesRead !== "number" || !Number.isSafeInteger(result.pagesRead) || result.pagesRead < 0) throw new Error("result.pagesRead must be a non-negative safe integer");
  assertIsoDate(result.watermarkDate, "result.watermarkDate");
}

function cloneResult(result: ReportingJobReplayResult): ReportingJobReplayResult { return { ...result }; }

function sameResult(left: ReportingJobReplayResult, right: ReportingJobReplayResult): boolean {
  return left.artifactId === right.artifactId && left.runId === right.runId && left.rowsWritten === right.rowsWritten && left.pagesRead === right.pagesRead && left.watermarkDate === right.watermarkDate;
}

function toStoredDate(value: unknown, field: string): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return new Date(value.getTime());
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    const date = value.toDate();
    if (date instanceof Date && !Number.isNaN(date.getTime())) return date;
  }
  throw new Error(`${field} must be a Firestore timestamp`);
}

function handleFrom(record: ActiveRecord): ReportingJobLeaseHandle { return { leaseId: record.leaseId, fence: record.fence, expiresAt: record.expiresAt.toISOString() }; }

function assertHandle(handle: ReportingJobLeaseHandle): void {
  if (!handle || typeof handle !== "object") throw new Error("A lease handle is required");
  assertLeaseId(handle.leaseId, "leaseId");
  assertFence(handle.fence, "fence");
  if (typeof handle.expiresAt !== "string" || Number.isNaN(Date.parse(handle.expiresAt))) throw new Error("expiresAt must be an ISO instant");
}

function recordKey(scope: ReportingScope, jobId: string): string { return JSON.stringify([scope.tenantId, scope.workspaceId, jobId]); }

function assertClaimInputs(scope: ReportingScope, jobId: string, fingerprint: string, holderId: string): void {
  assertScope(scope);
  assertIdentifier(jobId, "jobId");
  assertFingerprint(fingerprint);
  assertIdentifier(holderId, "holderId");
}

function assertHandleInputs(scope: ReportingScope, jobId: string, handle: ReportingJobLeaseHandle): void {
  assertScope(scope);
  assertIdentifier(jobId, "jobId");
  assertHandle(handle);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function readRecord(scope: ReportingScope, jobId: string, data: unknown): StoredRecord {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Stored reporting job lease is not an object");
  const record = data as Record<string, unknown>;
  if (record.schemaVersion !== 2 || record.tenantId !== scope.tenantId || record.workspaceId !== scope.workspaceId || record.jobId !== jobId) throw new Error("Stored reporting job lease identity does not match its tenant path");
  if (record.status === "active") {
    if (!hasExactKeys(record, ["createdAt", "expiresAt", "fence", "holderId", "jobId", "leaseId", "requestFingerprint", "schemaVersion", "status", "tenantId", "updatedAt", "workspaceId"])) throw new Error("Stored active reporting job lease has unsupported fields");
    assertFingerprint(record.requestFingerprint); assertIdentifier(record.holderId, "Stored reporting job lease holderId"); assertLeaseId(record.leaseId, "Stored reporting job lease leaseId"); assertFence(record.fence, "Stored reporting job lease fence");
    return { ...record, expiresAt: toStoredDate(record.expiresAt, "Stored reporting job lease expiresAt"), createdAt: toStoredDate(record.createdAt, "Stored reporting job lease createdAt"), updatedAt: toStoredDate(record.updatedAt, "Stored reporting job lease updatedAt") } as unknown as ActiveRecord;
  }
  if (record.status === "completed") {
    if (!hasExactKeys(record, ["completedFence", "completedLeaseId", "createdAt", "deleteAfter", "jobId", "requestFingerprint", "result", "schemaVersion", "status", "tenantId", "updatedAt", "workspaceId"])) throw new Error("Stored completed reporting job lease has unsupported fields");
    assertFingerprint(record.requestFingerprint); assertLeaseId(record.completedLeaseId, "Stored completed reporting job lease leaseId"); assertFence(record.completedFence, "Stored completed reporting job lease fence"); assertPublicResult(record.result);
    return { ...record, result: cloneResult(record.result), deleteAfter: toStoredDate(record.deleteAfter, "Stored completed reporting job deleteAfter"), createdAt: toStoredDate(record.createdAt, "Stored completed reporting job createdAt"), updatedAt: toStoredDate(record.updatedAt, "Stored completed reporting job updatedAt") } as unknown as CompletedRecord;
  }
  throw new Error("Stored reporting job lease has an invalid status");
}

function activeRecord(scope: ReportingScope, jobId: string, fingerprint: string, holderId: string, now: Date, ttl: number, fence: number, createdAt = now): ActiveRecord {
  return { schemaVersion: 2, tenantId: scope.tenantId, workspaceId: scope.workspaceId, jobId, status: "active", requestFingerprint: fingerprint, holderId, leaseId: randomUUID(), fence, expiresAt: new Date(now.getTime() + ttl), createdAt, updatedAt: now };
}

function completedRecord(active: ActiveRecord, result: ReportingJobReplayResult, now: Date): CompletedRecord {
  return { schemaVersion: 2, tenantId: active.tenantId, workspaceId: active.workspaceId, jobId: active.jobId, status: "completed", requestFingerprint: active.requestFingerprint, completedLeaseId: active.leaseId, completedFence: active.fence, result: cloneResult(result), deleteAfter: new Date(now.getTime() + COMPLETED_RECORD_RETENTION_MS), createdAt: active.createdAt, updatedAt: now };
}

function nowDate(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error("Clock returned an invalid date");
  return new Date(value.getTime());
}

function matchesHandle(active: ActiveRecord, handle: ReportingJobLeaseHandle): boolean { return active.leaseId === handle.leaseId && active.fence === handle.fence; }

export class InMemoryReportingJobLeaseRepository implements ReportingJobLeaseRepository {
  private readonly records = new Map<string, StoredRecord>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  async claim(scope: ReportingScope, jobId: string, fingerprint: string, holderId: string, ttl: number): Promise<ReportingJobClaim> {
    assertClaimInputs(scope, jobId, fingerprint, holderId); assertTtl(ttl);
    const now = nowDate(this.now); const key = recordKey(scope, jobId); const existing = this.records.get(key);
    if (existing && existing.requestFingerprint !== fingerprint) throw new Error("Reporting job request fingerprint does not match existing job");
    if (existing?.status === "completed") return { status: "completed", result: cloneResult(existing.result) };
    if (existing?.status === "active" && existing.expiresAt.getTime() > now.getTime()) return { status: "busy", expiresAt: existing.expiresAt.toISOString() };
    const record = activeRecord(scope, jobId, fingerprint, holderId, now, ttl, (existing?.status === "active" ? existing.fence : 0) + 1, existing?.createdAt);
    this.records.set(key, record); return { status: "acquired", handle: handleFrom(record) };
  }

  async renew(scope: ReportingScope, jobId: string, handle: ReportingJobLeaseHandle, ttl: number): Promise<ReportingJobLeaseHandle | null> {
    assertHandleInputs(scope, jobId, handle); assertTtl(ttl);
    const existing = this.records.get(recordKey(scope, jobId)); const now = nowDate(this.now);
    if (!existing || existing.status !== "active" || !matchesHandle(existing, handle) || existing.expiresAt.getTime() <= now.getTime()) return null;
    const renewed = { ...existing, expiresAt: new Date(now.getTime() + ttl), updatedAt: now };
    this.records.set(recordKey(scope, jobId), renewed); return handleFrom(renewed);
  }

  async complete(scope: ReportingScope, jobId: string, fingerprint: string, handle: ReportingJobLeaseHandle, result: ReportingJobReplayResult): Promise<boolean> {
    assertScope(scope); assertIdentifier(jobId, "jobId"); assertFingerprint(fingerprint); assertHandle(handle); assertPublicResult(result);
    const key = recordKey(scope, jobId); const existing = this.records.get(key);
    if (!existing || existing.requestFingerprint !== fingerprint) return false;
    if (existing.status === "completed") return existing.completedLeaseId === handle.leaseId && existing.completedFence === handle.fence && sameResult(existing.result, result);
    const now = nowDate(this.now);
    if (!matchesHandle(existing, handle) || existing.expiresAt.getTime() <= now.getTime()) return false;
    this.records.set(key, completedRecord(existing, result, now)); return true;
  }

  async release(scope: ReportingScope, jobId: string, handle: ReportingJobLeaseHandle): Promise<boolean> {
    assertHandleInputs(scope, jobId, handle); const key = recordKey(scope, jobId); const existing = this.records.get(key);
    if (!existing || existing.status !== "active" || !matchesHandle(existing, handle)) return false;
    this.records.set(key, { ...existing, expiresAt: new Date(0), updatedAt: nowDate(this.now) }); return true;
  }
}

export class FirestoreReportingJobLeaseRepository implements ReportingJobLeaseRepository {
  constructor(private readonly db: Firestore, private readonly now: () => Date = () => new Date()) {}
  private collection(scope: ReportingScope) { assertScope(scope); return this.db.collection("agency_tenants").doc(scope.tenantId).collection("workspaces").doc(scope.workspaceId).collection(COLLECTION); }

  async claim(scope: ReportingScope, jobId: string, fingerprint: string, holderId: string, ttl: number): Promise<ReportingJobClaim> {
    assertClaimInputs(scope, jobId, fingerprint, holderId); assertTtl(ttl); const reference = this.collection(scope).doc(jobId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference); const now = nowDate(this.now); const existing = snapshot.exists ? readRecord(scope, jobId, snapshot.data()) : undefined;
      if (existing && existing.requestFingerprint !== fingerprint) throw new Error("Reporting job request fingerprint does not match existing job");
      if (existing?.status === "completed") return { status: "completed", result: cloneResult(existing.result) };
      if (existing?.status === "active" && existing.expiresAt.getTime() > now.getTime()) return { status: "busy", expiresAt: existing.expiresAt.toISOString() };
      const record = activeRecord(scope, jobId, fingerprint, holderId, now, ttl, (existing?.status === "active" ? existing.fence : 0) + 1, existing?.createdAt);
      transaction.set(reference, record, { merge: false }); return { status: "acquired", handle: handleFrom(record) };
    });
  }

  async renew(scope: ReportingScope, jobId: string, handle: ReportingJobLeaseHandle, ttl: number): Promise<ReportingJobLeaseHandle | null> {
    assertHandleInputs(scope, jobId, handle); assertTtl(ttl); const reference = this.collection(scope).doc(jobId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference); if (!snapshot.exists) return null;
      const existing = readRecord(scope, jobId, snapshot.data()); const now = nowDate(this.now);
      if (existing.status !== "active" || !matchesHandle(existing, handle) || existing.expiresAt.getTime() <= now.getTime()) return null;
      const renewed = { ...existing, expiresAt: new Date(now.getTime() + ttl), updatedAt: now };
      transaction.set(reference, renewed, { merge: false }); return handleFrom(renewed);
    });
  }

  async complete(scope: ReportingScope, jobId: string, fingerprint: string, handle: ReportingJobLeaseHandle, result: ReportingJobReplayResult): Promise<boolean> {
    assertScope(scope); assertIdentifier(jobId, "jobId"); assertFingerprint(fingerprint); assertHandle(handle); assertPublicResult(result); const reference = this.collection(scope).doc(jobId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference); if (!snapshot.exists) return false;
      const existing = readRecord(scope, jobId, snapshot.data()); if (existing.requestFingerprint !== fingerprint) return false;
      if (existing.status === "completed") return existing.completedLeaseId === handle.leaseId && existing.completedFence === handle.fence && sameResult(existing.result, result);
      const now = nowDate(this.now); if (!matchesHandle(existing, handle) || existing.expiresAt.getTime() <= now.getTime()) return false;
      transaction.set(reference, completedRecord(existing, result, now), { merge: false }); return true;
    });
  }

  async release(scope: ReportingScope, jobId: string, handle: ReportingJobLeaseHandle): Promise<boolean> {
    assertHandleInputs(scope, jobId, handle); const reference = this.collection(scope).doc(jobId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference); if (!snapshot.exists) return false;
      const existing = readRecord(scope, jobId, snapshot.data());
      if (existing.status !== "active" || !matchesHandle(existing, handle)) return false;
      transaction.set(reference, { ...existing, expiresAt: new Date(0), updatedAt: nowDate(this.now) }, { merge: false }); return true;
    });
  }
}

export { COMPLETED_RECORD_RETENTION_MS, MAX_LEASE_TTL_MS, MIN_LEASE_TTL_MS };

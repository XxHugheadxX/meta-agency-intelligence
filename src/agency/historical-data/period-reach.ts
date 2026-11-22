import { createHash } from "node:crypto";
import type { Firestore } from "@google-cloud/firestore";
import { assertIsoDate, assertReportingScope, type ReportingScope } from "./types.js";

const COLLECTION = "agency_period_reach";
const MAX_KEYS = 200;
export const PERIOD_REACH_SCHEMA_VERSION = "meta-period-reach-v1";

/** Identifies one deduplicated-people count: a single ad account over one exact date range. */
export interface PeriodReachKey {
  readonly accountId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly timezone: string;
  readonly apiVersion: string;
}

export interface PeriodReachInput extends PeriodReachKey {
  readonly accountName: string;
  readonly reach: number;
  readonly impressions: number | null;
  readonly extractedAt: string;
  readonly runId: string;
}

export interface PeriodReachSnapshot extends PeriodReachInput, ReportingScope {
  readonly id: string;
  readonly schemaVersion: typeof PERIOD_REACH_SCHEMA_VERSION;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PeriodReachRepository {
  upsert(scope: ReportingScope, input: PeriodReachInput): Promise<PeriodReachSnapshot>;
  getMany(
    scope: ReportingScope,
    keys: readonly PeriodReachKey[],
  ): Promise<PeriodReachSnapshot[]>;
}

function assertKey(key: PeriodReachKey): void {
  if (!/^act_\d+$/.test(key.accountId)) {
    throw new Error("Period reach requires an act_<digits> accountId");
  }
  assertIsoDate(key.startDate, "startDate");
  assertIsoDate(key.endDate, "endDate");
  if (key.startDate > key.endDate) {
    throw new Error("Period reach startDate must be on or before endDate");
  }
  if (!key.timezone.trim()) throw new Error("Period reach timezone is required");
  if (!/^v\d+\.\d+$/.test(key.apiVersion)) {
    throw new Error("Period reach apiVersion must use the Meta v<major>.<minor> format");
  }
}

function assertKeys(keys: readonly PeriodReachKey[]): void {
  if (keys.length > MAX_KEYS) {
    throw new Error(`A period reach lookup cannot exceed ${MAX_KEYS} keys`);
  }
  keys.forEach(assertKey);
}

export function periodReachId(scope: ReportingScope, key: PeriodReachKey): string {
  assertReportingScope(scope);
  assertKey(key);
  return createHash("sha256")
    .update([
      scope.tenantId,
      scope.workspaceId,
      key.accountId,
      key.startDate,
      key.endDate,
      key.timezone,
      key.apiVersion,
      PERIOD_REACH_SCHEMA_VERSION,
    ].join("\u001f"))
    .digest("hex");
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function normalizePeriodReach(
  scope: ReportingScope,
  input: PeriodReachInput,
  existing?: PeriodReachSnapshot,
  now = new Date().toISOString(),
): PeriodReachSnapshot {
  const id = periodReachId(scope, input);
  if (!input.accountName.trim()) throw new Error("Period reach accountName is required");
  if (!isCount(input.reach)) {
    throw new Error("Period reach must be a non-negative integer count of people");
  }
  if (input.impressions !== null && !isCount(input.impressions)) {
    throw new Error("Period reach impressions must be a non-negative integer or null");
  }
  if (input.impressions !== null && input.impressions < input.reach) {
    throw new Error("Period reach cannot exceed its impressions");
  }
  if (
    Number.isNaN(Date.parse(input.extractedAt)) ||
    new Date(input.extractedAt).toISOString() !== input.extractedAt
  ) {
    throw new Error("Period reach extractedAt must be an ISO timestamp");
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.runId)) {
    throw new Error("Period reach runId contains unsupported characters");
  }
  return {
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    id,
    accountId: input.accountId,
    accountName: input.accountName,
    startDate: input.startDate,
    endDate: input.endDate,
    timezone: input.timezone,
    apiVersion: input.apiVersion,
    schemaVersion: PERIOD_REACH_SCHEMA_VERSION,
    reach: input.reach,
    impressions: input.impressions,
    extractedAt: input.extractedAt,
    runId: input.runId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function readStoredSnapshot(
  scope: ReportingScope,
  id: string,
  key: PeriodReachKey,
  data: unknown,
): PeriodReachSnapshot {
  if (!data || typeof data !== "object") {
    throw new Error("Stored period reach snapshot is not an object");
  }
  const snapshot = data as PeriodReachSnapshot;
  if (
    snapshot.id !== id ||
    snapshot.tenantId !== scope.tenantId ||
    snapshot.workspaceId !== scope.workspaceId ||
    snapshot.accountId !== key.accountId ||
    snapshot.startDate !== key.startDate ||
    snapshot.endDate !== key.endDate ||
    snapshot.timezone !== key.timezone ||
    snapshot.apiVersion !== key.apiVersion ||
    snapshot.schemaVersion !== PERIOD_REACH_SCHEMA_VERSION ||
    !isCount(snapshot.reach) ||
    (snapshot.impressions !== null && !isCount(snapshot.impressions))
  ) {
    throw new Error("Stored period reach snapshot does not match its tenant-scoped identity");
  }
  return structuredClone(snapshot);
}

export class InMemoryPeriodReachRepository implements PeriodReachRepository {
  private readonly snapshots = new Map<string, PeriodReachSnapshot>();

  async upsert(scope: ReportingScope, input: PeriodReachInput): Promise<PeriodReachSnapshot> {
    const id = periodReachId(scope, input);
    const snapshot = normalizePeriodReach(scope, input, this.snapshots.get(id));
    this.snapshots.set(id, snapshot);
    return structuredClone(snapshot);
  }

  async getMany(
    scope: ReportingScope,
    keys: readonly PeriodReachKey[],
  ): Promise<PeriodReachSnapshot[]> {
    assertReportingScope(scope);
    assertKeys(keys);
    return keys.flatMap((key) => {
      const id = periodReachId(scope, key);
      const snapshot = this.snapshots.get(id);
      return snapshot ? [readStoredSnapshot(scope, id, key, snapshot)] : [];
    });
  }
}

export class FirestorePeriodReachRepository implements PeriodReachRepository {
  constructor(private readonly db: Firestore) {}

  private collection(scope: ReportingScope) {
    assertReportingScope(scope);
    return this.db
      .collection("agency_tenants")
      .doc(scope.tenantId)
      .collection("workspaces")
      .doc(scope.workspaceId)
      .collection(COLLECTION);
  }

  async upsert(scope: ReportingScope, input: PeriodReachInput): Promise<PeriodReachSnapshot> {
    const id = periodReachId(scope, input);
    const reference = this.collection(scope).doc(id);
    return this.db.runTransaction(async (transaction) => {
      const stored = await transaction.get(reference);
      const existing = stored.exists
        ? readStoredSnapshot(scope, id, input, stored.data())
        : undefined;
      const snapshot = normalizePeriodReach(scope, input, existing);
      transaction.set(reference, snapshot, { merge: false });
      return snapshot;
    });
  }

  async getMany(
    scope: ReportingScope,
    keys: readonly PeriodReachKey[],
  ): Promise<PeriodReachSnapshot[]> {
    assertReportingScope(scope);
    assertKeys(keys);
    if (keys.length === 0) return [];
    const ids = keys.map((key) => periodReachId(scope, key));
    const collection = this.collection(scope);
    const stored = await this.db.getAll(...ids.map((id) => collection.doc(id)));
    return stored.flatMap((document, index) =>
      document.exists
        ? [readStoredSnapshot(scope, ids[index], keys[index], document.data())]
        : []);
  }
}

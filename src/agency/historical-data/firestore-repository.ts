import type { Firestore } from "@google-cloud/firestore";
import {
  assertReportingScope,
  normalizeHistoricalMetric,
  type HistoricalDataRepository,
  type HistoricalMetricInput,
  type HistoricalMetricQuery,
  type HistoricalMetricRow,
  type ReportingScope,
} from "./types.js";
import {
  historicalMetricId,
  matchesHistoricalMetricQuery,
  validateHistoricalMetricQuery,
} from "./repository.js";

const COLLECTION = "agency_historical_metrics";
const MAX_TRANSACTION_WRITES = 500;

function readStoredRow(
  scope: ReportingScope,
  id: string,
  data: unknown,
): HistoricalMetricRow {
  if (!data || typeof data !== "object") {
    throw new Error("Stored historical metric is not an object");
  }
  const row = data as HistoricalMetricRow;
  if (
    row.id !== id ||
    row.tenantId !== scope.tenantId ||
    row.workspaceId !== scope.workspaceId
  ) {
    throw new Error("Stored historical metric identity does not match its tenant path");
  }
  return {
    ...row,
    contentId: row.contentId ?? null,
    contentName: row.contentName ?? null,
    contentType: row.contentType ?? null,
  };
}

export class FirestoreHistoricalDataRepository implements HistoricalDataRepository {
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

  async upsert(scope: ReportingScope, input: HistoricalMetricInput): Promise<HistoricalMetricRow> {
    const id = historicalMetricId(scope, input);
    const reference = this.collection(scope).doc(id);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      const existing = snapshot.exists
        ? readStoredRow(scope, id, snapshot.data())
        : undefined;
      const row = normalizeHistoricalMetric(scope, input, id, existing);
      transaction.set(reference, row, { merge: false });
      return row;
    });
  }

  async upsertMany(
    scope: ReportingScope,
    inputs: readonly HistoricalMetricInput[],
  ): Promise<HistoricalMetricRow[]> {
    assertReportingScope(scope);
    if (inputs.length === 0) return [];
    if (inputs.length > MAX_TRANSACTION_WRITES) {
      throw new Error(
        `A historical metric transaction cannot exceed ${MAX_TRANSACTION_WRITES} rows`,
      );
    }

    const ids = inputs.map((input) => historicalMetricId(scope, input));
    if (new Set(ids).size !== ids.length) {
      throw new Error("A historical metric batch cannot contain duplicate source identities");
    }
    const references = ids.map((id) => this.collection(scope).doc(id));

    return this.db.runTransaction(async (transaction) => {
      const snapshots = await transaction.getAll(...references);
      const rows = inputs.map((input, index) => {
        const snapshot = snapshots[index];
        const existing = snapshot.exists
          ? readStoredRow(scope, ids[index], snapshot.data())
          : undefined;
        return normalizeHistoricalMetric(scope, input, ids[index], existing);
      });
      rows.forEach((row, index) => {
        transaction.set(references[index], row, { merge: false });
      });
      return rows;
    });
  }

  async list(scope: ReportingScope, query: HistoricalMetricQuery): Promise<HistoricalMetricRow[]> {
    validateHistoricalMetricQuery(query);
    let reference = this.collection(scope)
      .where("date", ">=", query.startDate)
      .where("date", "<=", query.endDate);
    if (query.level) reference = reference.where("level", "==", query.level);
    const snapshot = await reference.get();
    return snapshot.docs
      .map((document) => readStoredRow(scope, document.id, document.data()))
      .filter((row) => matchesHistoricalMetricQuery(row, query))
      .sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id));
  }
}

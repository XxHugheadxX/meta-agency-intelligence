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
    const snapshot = await reference.get();
    const existing = snapshot.exists ? (snapshot.data() as HistoricalMetricRow) : undefined;
    const row = normalizeHistoricalMetric(scope, input, id, existing);
    await reference.set(row, { merge: false });
    return row;
  }

  async upsertMany(
    scope: ReportingScope,
    inputs: readonly HistoricalMetricInput[],
  ): Promise<HistoricalMetricRow[]> {
    // Twenty agency accounts remain comfortably bounded; preserving upsert semantics also
    // retains each document's original createdAt value on replay.
    return Promise.all(inputs.map((input) => this.upsert(scope, input)));
  }

  async list(scope: ReportingScope, query: HistoricalMetricQuery): Promise<HistoricalMetricRow[]> {
    validateHistoricalMetricQuery(query);
    let reference = this.collection(scope)
      .where("date", ">=", query.startDate)
      .where("date", "<=", query.endDate);
    if (query.level) reference = reference.where("level", "==", query.level);
    const snapshot = await reference.get();
    return snapshot.docs
      .map((document) => document.data() as HistoricalMetricRow)
      .filter((row) => row.tenantId === scope.tenantId && row.workspaceId === scope.workspaceId)
      .filter((row) => matchesHistoricalMetricQuery(row, query))
      .sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id));
  }
}

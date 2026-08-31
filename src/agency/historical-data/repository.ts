import { createHash } from "node:crypto";
import {
  assertIsoDate,
  assertReportingScope,
  normalizeHistoricalMetric,
  type HistoricalDataRepository,
  type HistoricalMetricInput,
  type HistoricalMetricQuery,
  type HistoricalMetricRow,
  type ReportingScope,
} from "./types.js";

function stableObject(value: Readonly<Record<string, string | number | boolean | null>>): string {
  return JSON.stringify(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, item]),
  );
}

/** The key deliberately excludes metric values, making replayed source snapshots idempotent. */
export function historicalMetricId(scope: ReportingScope, input: HistoricalMetricInput): string {
  assertReportingScope(scope);
  const identity = [
    scope.tenantId,
    scope.workspaceId,
    input.accountId,
    input.campaignId ?? "",
    input.adSetId ?? "",
    input.adId ?? "",
    input.contentId ?? "",
    input.contentType ?? "",
    input.date,
    input.level,
    input.currency,
    input.timezone,
    input.attributionWindow ?? "",
    stableObject(input.breakdowns ?? {}),
  ].join("\u001f");
  return createHash("sha256").update(identity).digest("hex");
}

function queryIsValid(query: HistoricalMetricQuery): void {
  assertIsoDate(query.startDate, "startDate");
  assertIsoDate(query.endDate, "endDate");
  if (query.startDate > query.endDate) {
    throw new Error("startDate must be on or before endDate");
  }
}

function matches(row: HistoricalMetricRow, query: HistoricalMetricQuery): boolean {
  return (
    row.date >= query.startDate &&
    row.date <= query.endDate &&
    (!query.level || row.level === query.level) &&
    (!query.accountIds || query.accountIds.includes(row.accountId))
  );
}

export class InMemoryHistoricalDataRepository implements HistoricalDataRepository {
  private readonly rows = new Map<string, HistoricalMetricRow>();

  async upsert(scope: ReportingScope, input: HistoricalMetricInput): Promise<HistoricalMetricRow> {
    const id = historicalMetricId(scope, input);
    const existing = this.rows.get(`${scope.tenantId}:${scope.workspaceId}:${id}`);
    const row = normalizeHistoricalMetric(scope, input, id, existing);
    this.rows.set(`${scope.tenantId}:${scope.workspaceId}:${id}`, row);
    return structuredClone(row);
  }

  async upsertMany(
    scope: ReportingScope,
    inputs: readonly HistoricalMetricInput[],
  ): Promise<HistoricalMetricRow[]> {
    const rows: HistoricalMetricRow[] = [];
    for (const input of inputs) rows.push(await this.upsert(scope, input));
    return rows;
  }

  async list(scope: ReportingScope, query: HistoricalMetricQuery): Promise<HistoricalMetricRow[]> {
    assertReportingScope(scope);
    queryIsValid(query);
    return [...this.rows.values()]
      .filter((row) => row.tenantId === scope.tenantId && row.workspaceId === scope.workspaceId)
      .filter((row) => matches(row, query))
      .sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id))
      .map((row) => structuredClone(row));
  }
}

export { matchesHistoricalMetricQuery, validateHistoricalMetricQuery };
const matchesHistoricalMetricQuery = matches;
const validateHistoricalMetricQuery = queryIsValid;

import type { HistoricalMetricRow, MetricName } from "../historical-data/types.js";

export function mixedActionTypes(rows: readonly HistoricalMetricRow[], name: MetricName): boolean {
  const types = new Set<string>();
  for (const row of rows) {
    const definitions = row.rawData.metricDefinitions as { actionTypes?: Record<string, unknown> } | undefined;
    const actionType = definitions?.actionTypes?.[name];
    if (row.metrics[name] !== null && typeof actionType === "string") types.add(actionType);
  }
  return types.size > 1;
}

export function uniqueReach(rows: readonly HistoricalMetricRow[]): number | null {
  // A union of people cannot be derived from counts of overlapping sets.
  return rows.length === 1 ? rows[0].metrics.reach : null;
}

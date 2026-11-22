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

export function completeMetricCoverage(
  rows: readonly HistoricalMetricRow[],
  ...names: readonly MetricName[]
): boolean {
  return rows.length > 0 && rows.every((row) => names.every((name) => row.metrics[name] !== null));
}

export function metricRatio(
  rows: readonly HistoricalMetricRow[],
  numeratorName: MetricName,
  denominatorName: MetricName,
  numerator: number | null,
  denominator: number | null,
  multiplier = 1,
): number | null {
  if (!completeMetricCoverage(rows, numeratorName, denominatorName) ||
    numerator === null || denominator === null || denominator === 0) return null;
  return numerator / denominator * multiplier;
}

const RATIO_INPUTS: Readonly<Record<string, readonly [MetricName, MetricName]>> = {
  CTR: ["clicks", "impressions"], CPC: ["spend", "clicks"],
  CPM: ["spend", "impressions"], CPL: ["spend", "leads"],
  "Conversion rate": ["conversions", "clicks"], Frecuencia: ["impressions", "reach"],
};

export function ratioCoverageLimitations(rows: readonly HistoricalMetricRow[]): string[] {
  return Object.entries(RATIO_INPUTS)
    .filter(([, names]) => rows.some((row) => names.some((name) => row.metrics[name] !== null)) &&
      !completeMetricCoverage(rows, ...names))
    .map(([name]) => `${name}: N/D; cobertura incompleta de sus métricas fuente.`);
}

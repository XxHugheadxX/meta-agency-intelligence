import { assertReportingScope, type HistoricalMetricRow, type ReportingScope } from "../historical-data/index.js";
import { buildSegmentationRecommendations } from "../recommendations/index.js";
import { completeMetricCoverage, metricRatio, mixedActionTypes, ratioCoverageLimitations, uniqueReach } from "../analytics/metric-definitions.js";
import type {
  SegmentPerformance,
  SegmentationAnalysis,
  SegmentationDimension,
  SegmentationMetrics,
  SegmentationOptions,
  SegmentationThresholds,
} from "./types.js";

export const DEFAULT_SEGMENTATION_THRESHOLDS: SegmentationThresholds = {
  highCtr: 1.5,
  lowCtr: 0.75,
  badCplMultiplier: 1.25,
  goodCplMultiplier: 0.8,
  saturatedFrequency: 3,
  minimumCtrGap: 0.5,
};

export const DEFAULT_SEGMENTATION_DIMENSIONS: readonly SegmentationDimension[] = [
  "location", "age", "gender", "interest", "placement", "device", "audience", "campaign", "adSet", "creative",
];

const BREAKDOWN_KEYS: Readonly<Record<Exclude<SegmentationDimension, "campaign" | "adSet" | "creative">, readonly string[]>> = {
  location: ["location", "region", "country", "geo", "dma"],
  age: ["age"],
  gender: ["gender"],
  interest: ["interest", "interests"],
  placement: ["placement", "publisher_platform", "platform_position"],
  device: ["device", "impression_device", "device_platform"],
  audience: ["audience", "custom_audience", "audience_name"],
};

interface ResolvedOptions {
  readonly dimensions: readonly SegmentationDimension[];
  readonly minimumRows: number;
  readonly minimumImpressions: number;
  readonly maxRecommendations: number;
  readonly thresholds: SegmentationThresholds;
}

function resolveOptions(options: SegmentationOptions = {}): ResolvedOptions {
  const dimensions = options.dimensions ?? DEFAULT_SEGMENTATION_DIMENSIONS;
  const allowedDimensions = new Set<SegmentationDimension>(DEFAULT_SEGMENTATION_DIMENSIONS);
  if (dimensions.some((dimension) => !allowedDimensions.has(dimension))) {
    throw new Error("dimensions contains an unsupported segmentation dimension");
  }
  if (!Number.isInteger(options.minimumRows ?? 3) || (options.minimumRows ?? 3) < 1) throw new Error("minimumRows must be a positive integer");
  if (!Number.isFinite(options.minimumImpressions ?? 100) || (options.minimumImpressions ?? 100) < 0) throw new Error("minimumImpressions must be a non-negative number");
  if (!Number.isInteger(options.maxRecommendations ?? 30) || (options.maxRecommendations ?? 30) < 1) throw new Error("maxRecommendations must be a positive integer");
  const thresholds = { ...DEFAULT_SEGMENTATION_THRESHOLDS, ...options.thresholds };
  if (Object.values(thresholds).some((value) => !Number.isFinite(value) || value < 0)) throw new Error("segmentation thresholds must be finite non-negative numbers");
  return { dimensions: [...new Set(dimensions)], minimumRows: options.minimumRows ?? 3, minimumImpressions: options.minimumImpressions ?? 100, maxRecommendations: options.maxRecommendations ?? 30, thresholds };
}

function sum(rows: readonly HistoricalMetricRow[], name: "spend" | "reach" | "impressions" | "clicks" | "messages" | "leads" | "conversions"): number | null {
  if (mixedActionTypes(rows, name)) return null;
  let total = 0;
  let found = false;
  for (const row of rows) {
    const value = row.metrics[name];
    if (value !== null) { total += value; found = true; }
  }
  return found ? total : null;
}

export function segmentationMetrics(rows: readonly HistoricalMetricRow[]): SegmentationMetrics {
  const spend = sum(rows, "spend");
  const reach = uniqueReach(rows);
  const impressions = sum(rows, "impressions");
  const clicks = sum(rows, "clicks");
  const leads = sum(rows, "leads");
  return {
    spend, reach, impressions, clicks,
    messages: sum(rows, "messages"), leads, conversions: sum(rows, "conversions"),
    ctr: metricRatio(rows, "clicks", "impressions", clicks, impressions, 100),
    cpc: metricRatio(rows, "spend", "clicks", spend, clicks),
    cpl: metricRatio(rows, "spend", "leads", spend, leads),
    conversionRate: metricRatio(rows, "conversions", "clicks", sum(rows, "conversions"), clicks, 100),
    frequency: metricRatio(rows, "impressions", "reach", impressions, reach),
  };
}

interface SegmentIdentity {
  readonly id: string;
  readonly name: string;
}

function breakdownValue(row: HistoricalMetricRow, dimension: SegmentationDimension): SegmentIdentity | null {
  if (dimension === "campaign") {
    return row.campaignId ? { id: row.campaignId, name: row.campaignName ?? row.campaignId } : null;
  }
  if (dimension === "adSet") {
    return row.adSetId ? { id: row.adSetId, name: row.adSetName ?? row.adSetId } : null;
  }
  if (dimension === "creative") {
    return row.creativeId ? { id: row.creativeId, name: row.creativeId } : null;
  }
  for (const key of BREAKDOWN_KEYS[dimension]) {
    const value = row.breakdowns[key];
    if (value !== null && value !== undefined && String(value).trim()) {
      const segment = String(value).trim();
      return { id: segment, name: segment };
    }
  }
  return null;
}

function performance(
  dimension: SegmentationDimension,
  segmentId: string,
  segment: string,
  currency: string,
  rows: readonly HistoricalMetricRow[],
  options: ResolvedOptions,
): SegmentPerformance {
  const metrics = segmentationMetrics(rows);
  const caveats: string[] = ratioCoverageLimitations(rows);
  if (rows.length < options.minimumRows) caveats.push(`Muestra pequeña: ${rows.length}/${options.minimumRows} filas mínimas.`);
  if ((metrics.impressions ?? 0) < options.minimumImpressions) caveats.push(`Impresiones insuficientes: ${metrics.impressions ?? 0}/${options.minimumImpressions} mínimas.`);
  if (metrics.spend === null) caveats.push("Sin gasto disponible; no se evalúan CPC ni CPL.");
  if (metrics.ctr === null) caveats.push("Sin impresiones o clics válidos; no se calcula CTR.");
  if (metrics.reach === null) caveats.push("Alcance y frecuencia: N/D sin un snapshot de alcance único; no se deduplican personas sumando filas.");
  return {
    dimension,
    segmentId,
    segment,
    currency,
    rowCount: rows.length,
    metrics,
    sampleEligible:
      rows.length >= options.minimumRows &&
      (metrics.impressions ?? 0) >= options.minimumImpressions &&
      completeMetricCoverage(rows, "spend", "impressions", "clicks", "leads"),
    caveats,
  };
}

function scopedRows(scope: ReportingScope, rows: readonly HistoricalMetricRow[]): { owned: HistoricalMetricRow[]; excluded: number } {
  const owned = rows.filter((row) => row.tenantId === scope.tenantId && row.workspaceId === scope.workspaceId);
  return { owned, excluded: rows.length - owned.length };
}

export function analyzeSegmentation(
  scope: ReportingScope,
  rows: readonly HistoricalMetricRow[],
  inputOptions: SegmentationOptions = {},
): SegmentationAnalysis {
  assertReportingScope(scope);
  const options = resolveOptions(inputOptions);
  const scoped = scopedRows(scope, rows);
  const datasets = new Set(scoped.owned.map((row) => JSON.stringify([
    row.level, Object.keys(row.breakdowns).sort(), row.attributionWindow, row.apiVersion, row.schemaVersion,
  ])));
  if (datasets.size > 1) throw new Error("Segmentation requires one homogeneous source dataset");
  const groups = new Map<string, HistoricalMetricRow[]>();
  const available = new Set<SegmentationDimension>();
  for (const row of scoped.owned) {
    for (const dimension of options.dimensions) {
      const identity = breakdownValue(row, dimension);
      if (identity === null) continue;
      available.add(dimension);
      const key = `${dimension}\u0000${identity.id}\u0000${identity.name}\u0000${row.currency}`;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
  }
  const performances = [...groups.entries()].map(([key, entries]) => {
    const [dimension, segmentId, segment, currency] = key.split("\u0000") as [
      SegmentationDimension,
      string,
      string,
      string,
    ];
    return performance(dimension, segmentId, segment, currency, entries, options);
  }).sort(
    (left, right) =>
      left.dimension.localeCompare(right.dimension) ||
      left.segment.localeCompare(right.segment) ||
      left.segmentId.localeCompare(right.segmentId) ||
      left.currency.localeCompare(right.currency),
  );
  const baselineGroups = new Map<string, HistoricalMetricRow[]>();
  for (const row of scoped.owned) {
    const group = baselineGroups.get(row.currency) ?? [];
    group.push(row);
    baselineGroups.set(row.currency, group);
  }
  const baselines = Object.fromEntries([...baselineGroups.entries()].map(([currency, entries]) => [currency, segmentationMetrics(entries)]));
  const unavailableDimensions = options.dimensions.filter((dimension) => !available.has(dimension));
  const recommendations = buildSegmentationRecommendations(performances, baselines, options);
  return { ruleVersion: "segmentation-v3", scope: { ...scope }, analyzedRows: scoped.owned.length, excludedRows: scoped.excluded, performances, baselines, unavailableDimensions, recommendations };
}

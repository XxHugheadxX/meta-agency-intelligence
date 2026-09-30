import type { HistoricalMetricRow, ReportingScope } from "../historical-data/index.js";

export type SegmentationDimension =
  | "location"
  | "age"
  | "gender"
  | "interest"
  | "placement"
  | "device"
  | "audience"
  | "campaign"
  | "adSet"
  | "creative";

export interface SegmentationThresholds {
  readonly highCtr: number;
  readonly lowCtr: number;
  readonly badCplMultiplier: number;
  readonly goodCplMultiplier: number;
  readonly saturatedFrequency: number;
  readonly minimumCtrGap: number;
}

export interface SegmentationOptions {
  readonly dimensions?: readonly SegmentationDimension[];
  readonly minimumRows?: number;
  readonly minimumImpressions?: number;
  readonly maxRecommendations?: number;
  readonly thresholds?: Partial<SegmentationThresholds>;
}

export interface SegmentationMetrics {
  readonly spend: number | null;
  readonly reach: number | null;
  readonly impressions: number | null;
  readonly clicks: number | null;
  readonly messages: number | null;
  readonly leads: number | null;
  readonly conversions: number | null;
  readonly ctr: number | null;
  readonly cpc: number | null;
  readonly cpl: number | null;
  /** conversions / clicks; null when the click denominator is absent or zero. */
  readonly conversionRate: number | null;
  readonly frequency: number | null;
}

export interface SegmentPerformance {
  readonly dimension: SegmentationDimension;
  readonly segmentId: string;
  readonly segment: string;
  readonly currency: string;
  readonly rowCount: number;
  readonly metrics: SegmentationMetrics;
  readonly sampleEligible: boolean;
  readonly caveats: readonly string[];
}

export type RecommendationKind =
  | "good_ctr_bad_cpl"
  | "low_ctr"
  | "saturated_audience"
  | "best_location"
  | "budget_redistribution"
  | "ab_test";

export type RecommendationSeverity = "info" | "opportunity" | "warning";
export type RecommendationConfidence = "low" | "medium" | "high";

export interface RecommendationEvidence {
  readonly dimension: SegmentationDimension;
  readonly segmentId: string;
  readonly segment: string;
  readonly currency: string;
  readonly rowCount: number;
  readonly metrics: SegmentationMetrics;
  readonly baseline: SegmentationMetrics;
}

export interface SegmentationRecommendation {
  readonly id: string;
  readonly kind: RecommendationKind;
  readonly severity: RecommendationSeverity;
  readonly confidence: RecommendationConfidence;
  readonly title: string;
  readonly recommendation: string;
  readonly evidence: RecommendationEvidence;
  readonly caveats: readonly string[];
}

export interface SegmentationAnalysis {
  readonly ruleVersion: string;
  readonly period?: { readonly startDate: string; readonly endDate: string };
  readonly scope: ReportingScope;
  readonly analyzedRows: number;
  readonly excludedRows: number;
  readonly performances: readonly SegmentPerformance[];
  readonly baselines: Readonly<Record<string, SegmentationMetrics>>;
  readonly unavailableDimensions: readonly SegmentationDimension[];
  readonly recommendations: readonly SegmentationRecommendation[];
}

export interface ScopedSegmentationInput {
  readonly scope: ReportingScope;
  readonly rows: readonly HistoricalMetricRow[];
  readonly options?: SegmentationOptions;
}

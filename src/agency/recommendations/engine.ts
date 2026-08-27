import type { SegmentPerformance, SegmentationMetrics, SegmentationOptions, SegmentationRecommendation } from "../segmentation/types.js";
import { DEFAULT_SEGMENTATION_THRESHOLDS } from "../segmentation/analyzer.js";

type ResolvedRecommendationOptions = Required<Pick<SegmentationOptions, "maxRecommendations">> & { thresholds: typeof DEFAULT_SEGMENTATION_THRESHOLDS };

function resolved(options: SegmentationOptions): ResolvedRecommendationOptions {
  return { maxRecommendations: options.maxRecommendations ?? 30, thresholds: { ...DEFAULT_SEGMENTATION_THRESHOLDS, ...options.thresholds } };
}

function evidence(performance: SegmentPerformance, baseline: SegmentationMetrics) {
  return { dimension: performance.dimension, segmentId: performance.segmentId, segment: performance.segment, currency: performance.currency, rowCount: performance.rowCount, metrics: performance.metrics, baseline };
}

function confidence(performance: SegmentPerformance): "low" | "medium" | "high" {
  if (performance.rowCount >= 10 && (performance.metrics.impressions ?? 0) >= 1000) return "high";
  if (performance.rowCount >= 5 && (performance.metrics.impressions ?? 0) >= 500) return "medium";
  return "low";
}

function make(
  kind: SegmentationRecommendation["kind"], severity: SegmentationRecommendation["severity"], performance: SegmentPerformance, baseline: SegmentationMetrics, title: string, recommendation: string, caveats: readonly string[] = performance.caveats,
): SegmentationRecommendation {
  return { id: `${kind}:${performance.dimension}:${performance.segmentId}:${performance.currency}`.replace(/\s+/g, "-"), kind, severity, confidence: confidence(performance), title, recommendation, evidence: evidence(performance, baseline), caveats };
}

/** Pure recommendation engine: it never writes campaigns, budgets, audiences, or Meta resources. */
export function buildSegmentationRecommendations(
  performances: readonly SegmentPerformance[],
  baselines: Readonly<Record<string, SegmentationMetrics>>,
  options: SegmentationOptions = {},
): readonly SegmentationRecommendation[] {
  const settings = resolved(options);
  const eligible = performances.filter((performance) => performance.sampleEligible);
  const recommendations: SegmentationRecommendation[] = [];
  for (const performance of eligible) {
    const baseline = baselines[performance.currency];
    if (!baseline) continue;
    if (performance.metrics.ctr !== null && performance.metrics.ctr >= settings.thresholds.highCtr && performance.metrics.cpl !== null && baseline.cpl !== null && performance.metrics.cpl > baseline.cpl * settings.thresholds.badCplMultiplier) {
      recommendations.push(make("good_ctr_bad_cpl", "warning", performance, baseline, `CTR alto pero CPL desfavorable: ${performance.segment}`, "Revisar la calidad del tráfico, el formulario y la intención antes de escalar este segmento."));
    }
    if (performance.metrics.ctr !== null && baseline.ctr !== null && performance.metrics.ctr < Math.min(settings.thresholds.lowCtr, baseline.ctr * 0.75)) {
      recommendations.push(make("low_ctr", "warning", performance, baseline, `CTR bajo: ${performance.segment}`, "Probar una nueva combinación de creativo, mensaje y segmentación; no aumentar presupuesto hasta validar la hipótesis."));
    }
    if (performance.dimension === "audience" && performance.metrics.frequency !== null && performance.metrics.frequency >= settings.thresholds.saturatedFrequency) {
      recommendations.push(make("saturated_audience", "warning", performance, baseline, `Audiencia potencialmente saturada: ${performance.segment}`, "Renovar creativos, ampliar la audiencia o reducir la presión de entrega; confirmar tendencia en el siguiente período."));
    }
    if (performance.dimension === "location" && performance.metrics.ctr !== null && baseline.ctr !== null && performance.metrics.ctr > baseline.ctr && performance.metrics.leads !== null && performance.metrics.leads > 0) {
      recommendations.push(make("best_location", "opportunity", performance, baseline, `Ubicación con rendimiento destacado: ${performance.segment}`, "Priorizar esta ubicación en el próximo experimento controlado y comparar contra una ubicación de referencia."));
    }
  }
  const byDimensionCurrency = new Map<string, SegmentPerformance[]>();
  for (const performance of eligible) {
    const key = `${performance.dimension}\u0000${performance.currency}`;
    const group = byDimensionCurrency.get(key) ?? [];
    group.push(performance);
    byDimensionCurrency.set(key, group);
  }
  for (const group of byDimensionCurrency.values()) {
    const baseline = baselines[group[0].currency];
    if (!baseline || group.length < 2) continue;
    const byCpl = group.filter((performance) => performance.metrics.cpl !== null).sort((left, right) => (left.metrics.cpl ?? Infinity) - (right.metrics.cpl ?? Infinity));
    if (byCpl.length >= 2 && (byCpl[0].metrics.cpl ?? Infinity) < (byCpl.at(-1)?.metrics.cpl ?? -Infinity) * settings.thresholds.goodCplMultiplier) {
      recommendations.push(make("budget_redistribution", "opportunity", byCpl[0], baseline, `Posible redistribución: ${byCpl[0].segment}`, `Considerar una prueba gradual desde ${byCpl.at(-1)?.segment ?? "el segmento menos eficiente"} hacia ${byCpl[0].segment}; no aplicar cambios automáticos.`));
    }
    const byCtr = group.filter((performance) => performance.metrics.ctr !== null).sort((left, right) => (right.metrics.ctr ?? -Infinity) - (left.metrics.ctr ?? -Infinity));
    if (byCtr.length >= 2 && (byCtr[0].metrics.ctr ?? 0) - (byCtr.at(-1)?.metrics.ctr ?? 0) >= settings.thresholds.minimumCtrGap) {
      recommendations.push(make("ab_test", "info", byCtr[0], baseline, `Oportunidad de A/B test en ${byCtr[0].dimension}`, `Probar ${byCtr[0].segment} frente a ${byCtr.at(-1)?.segment ?? "la variante de menor CTR"} con presupuesto y ventana de atribución constantes.`));
    }
  }
  const rank = { warning: 0, opportunity: 1, info: 2 } as const;
  return recommendations.sort((left, right) => rank[left.severity] - rank[right.severity] || left.title.localeCompare(right.title)).slice(0, settings.maxRecommendations);
}

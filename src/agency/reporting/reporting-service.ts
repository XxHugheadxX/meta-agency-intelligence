import {
  assertIsoDate,
  METRIC_NAMES,
  type HistoricalDataRepository,
  type HistoricalMetricLevel,
  type HistoricalMetricRow,
  type MetricName,
  type MetricValues,
  type PaidHistoricalMetricLevel,
  type ReportingScope,
} from "../historical-data/index.js";

export interface ReportPeriod {
  kind: "week" | "month" | "custom";
  startDate: string;
  endDate: string;
}

export interface MetricComparison {
  current: number | null;
  previous: number | null;
  absoluteChange: number | null;
  percentageChange: number | null;
}

export interface AggregateMetrics {
  metrics: MetricValues;
  rowCount: number;
  currencies: readonly string[];
  currencyBreakdown: Readonly<Record<string, MetricValues>>;
  qualityCounts: Readonly<Record<HistoricalMetricRow["quality"], number>>;
}

export interface RankingEntry {
  id: string;
  name: string;
  metrics: MetricValues;
  rowCount: number;
}

export interface AgencyReportDataset {
  granularity: HistoricalMetricLevel;
  current: AggregateMetrics;
  previous: AggregateMetrics;
  comparison: Readonly<Record<MetricName, MetricComparison>>;
  rawRows: readonly HistoricalMetricRow[];
}

export interface AgencyReportSources {
  paid: AgencyReportDataset;
  organicAccount: AgencyReportDataset;
  content: AgencyReportDataset;
}

export interface AgencyReport {
  scope: ReportingScope;
  period: ReportPeriod;
  previousPeriod: ReportPeriod;
  granularity: HistoricalMetricLevel;
  current: AggregateMetrics;
  previous: AggregateMetrics;
  comparison: Readonly<Record<MetricName, MetricComparison>>;
  accountRanking: readonly RankingEntry[];
  agentRanking: readonly RankingEntry[];
  rawRows: readonly HistoricalMetricRow[];
  /** Present for unified workbooks. Source datasets stay separate to prevent double counting. */
  sources?: AgencyReportSources;
}

export interface CreateReportInput {
  period: ReportPeriod;
  granularity?: HistoricalMetricLevel;
  rankBy?: MetricName;
}

export interface CreateUnifiedReportInput {
  period: ReportPeriod;
  paidGranularity?: PaidHistoricalMetricLevel;
  rankBy?: MetricName;
}

function emptyMetrics(): MetricValues {
  return Object.fromEntries(METRIC_NAMES.map((name) => [name, null])) as MetricValues;
}

function sumMetric(rows: readonly HistoricalMetricRow[], name: MetricName): number | null {
  if (name === "ctr" || name === "cpc" || name === "cpm" || name === "cpl" || name === "frequency") {
    return null;
  }
  if (name === "followerCount") {
    const latestByAccount = new Map<string, HistoricalMetricRow>();
    for (const row of rows) {
      if (row.metrics.followerCount === null) continue;
      const previous = latestByAccount.get(row.accountId);
      if (!previous || row.date > previous.date || (row.date === previous.date && row.id > previous.id)) {
        latestByAccount.set(row.accountId, row);
      }
    }
    if (latestByAccount.size === 0) return null;
    return [...latestByAccount.values()].reduce(
      (total, row) => total + (row.metrics.followerCount ?? 0),
      0,
    );
  }
  let sum = 0;
  let found = false;
  for (const row of rows) {
    const value = row.metrics[name];
    if (value !== null) {
      sum += value;
      found = true;
    }
  }
  return found ? sum : null;
}

function ratio(numerator: number | null, denominator: number | null, multiplier = 1): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return (numerator / denominator) * multiplier;
}

/** Ratios are always derived from aggregate totals; source row ratios are not averaged. */
function calculateMetrics(rows: readonly HistoricalMetricRow[]): MetricValues {
  const metrics = emptyMetrics();
  for (const name of METRIC_NAMES) metrics[name] = sumMetric(rows, name);
  metrics.ctr = ratio(metrics.clicks, metrics.impressions, 100);
  metrics.cpc = ratio(metrics.spend, metrics.clicks);
  metrics.cpm = ratio(metrics.spend, metrics.impressions, 1000);
  metrics.cpl = ratio(metrics.spend, metrics.leads);
  metrics.frequency = ratio(metrics.impressions, metrics.reach);
  return metrics;
}

export function aggregateRows(rows: readonly HistoricalMetricRow[]): AggregateMetrics {
  const currencies = [...new Set(rows.map((row) => row.currency))].sort();
  const metrics = calculateMetrics(rows);
  const currencyBreakdown = Object.fromEntries(
    currencies.map((currency) => [
      currency,
      calculateMetrics(rows.filter((row) => row.currency === currency)),
    ]),
  );
  if (currencies.length > 1) {
    metrics.spend = null;
    metrics.cpc = null;
    metrics.cpm = null;
    metrics.cpl = null;
  }

  const qualityCounts: Record<HistoricalMetricRow["quality"], number> = {
    complete: 0,
    partial: 0,
    late: 0,
    estimated: 0,
  };
  for (const row of rows) qualityCounts[row.quality] += 1;
  return {
    metrics,
    rowCount: rows.length,
    currencies,
    currencyBreakdown,
    qualityCounts,
  };
}

function compare(current: MetricValues, previous: MetricValues): Readonly<Record<MetricName, MetricComparison>> {
  return Object.fromEntries(
    METRIC_NAMES.map((name) => {
      const currentValue = current[name];
      const previousValue = previous[name];
      const absoluteChange =
        currentValue === null || previousValue === null ? null : currentValue - previousValue;
      return [
        name,
        {
          current: currentValue,
          previous: previousValue,
          absoluteChange,
          percentageChange:
            absoluteChange === null || previousValue === null || previousValue === 0
              ? null
              : (absoluteChange / previousValue) * 100,
        },
      ];
    }),
  ) as Record<MetricName, MetricComparison>;
}

function addDays(date: string, days: number): string {
  const instant = new Date(`${date}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

function daysBetween(startDate: string, endDate: string): number {
  return Math.round(
    (Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / 86_400_000,
  );
}

export function previousPeriod(period: ReportPeriod): ReportPeriod {
  assertIsoDate(period.startDate, "startDate");
  assertIsoDate(period.endDate, "endDate");
  if (period.startDate > period.endDate) {
    throw new Error("startDate must be on or before endDate");
  }
  const length = daysBetween(period.startDate, period.endDate) + 1;
  return {
    kind: period.kind,
    startDate: addDays(period.startDate, -length),
    endDate: addDays(period.startDate, -1),
  };
}

export function weeklyPeriod(containingDate: string): ReportPeriod {
  assertIsoDate(containingDate, "containingDate");
  const instant = new Date(`${containingDate}T00:00:00.000Z`);
  const mondayOffset = (instant.getUTCDay() + 6) % 7;
  const startDate = addDays(containingDate, -mondayOffset);
  return { kind: "week", startDate, endDate: addDays(startDate, 6) };
}

export function monthlyPeriod(year: number, month: number): ReportPeriod {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("year and month must identify a valid calendar month");
  }
  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { kind: "month", startDate, endDate: `${year}-${String(month).padStart(2, "0")}-${lastDay}` };
}

function ranking(
  rows: readonly HistoricalMetricRow[],
  key: "account" | "agent",
  rankBy: MetricName,
): RankingEntry[] {
  const groups = new Map<string, HistoricalMetricRow[]>();
  for (const row of rows) {
    const id = key === "account" ? row.accountId : row.agentId;
    if (!id) continue;
    const group = groups.get(id) ?? [];
    group.push(row);
    groups.set(id, group);
  }
  return [...groups.entries()]
    .map(([id, group]) => ({
      id,
      name: key === "account" ? group[0].accountName : (group[0].agentName ?? id),
      metrics: aggregateRows(group).metrics,
      rowCount: group.length,
    }))
    .sort((left, right) => (right.metrics[rankBy] ?? -Infinity) - (left.metrics[rankBy] ?? -Infinity) || left.name.localeCompare(right.name));
}

async function reportDataset(
  historicalData: HistoricalDataRepository,
  scope: ReportingScope,
  period: ReportPeriod,
  before: ReportPeriod,
  granularity: HistoricalMetricLevel,
): Promise<AgencyReportDataset> {
  const [currentRows, previousRows] = await Promise.all([
    historicalData.list(scope, { ...period, level: granularity }),
    historicalData.list(scope, { ...before, level: granularity }),
  ]);
  const current = aggregateRows(currentRows);
  const previous = aggregateRows(previousRows);
  return {
    granularity,
    current,
    previous,
    comparison: compare(current.metrics, previous.metrics),
    rawRows: currentRows,
  };
}

export class AgencyReportingService {
  constructor(private readonly historicalData: HistoricalDataRepository) {}

  async createReport(scope: ReportingScope, input: CreateReportInput): Promise<AgencyReport> {
    const granularity = input.granularity ?? "ad";
    const before = previousPeriod(input.period);
    const dataset = await reportDataset(
      this.historicalData,
      scope,
      input.period,
      before,
      granularity,
    );
    const rankBy = input.rankBy ?? "leads";
    return {
      scope: { ...scope },
      period: { ...input.period },
      previousPeriod: before,
      granularity,
      current: dataset.current,
      previous: dataset.previous,
      comparison: dataset.comparison,
      accountRanking: ranking(dataset.rawRows, "account", rankBy),
      agentRanking: ranking(dataset.rawRows, "agent", rankBy),
      rawRows: dataset.rawRows,
    };
  }

  async createUnifiedReport(
    scope: ReportingScope,
    input: CreateUnifiedReportInput,
  ): Promise<AgencyReport> {
    const paidGranularity = input.paidGranularity ?? "ad";
    const before = previousPeriod(input.period);
    const [paid, organicAccount, content] = await Promise.all([
      reportDataset(this.historicalData, scope, input.period, before, paidGranularity),
      reportDataset(this.historicalData, scope, input.period, before, "organic_account"),
      reportDataset(this.historicalData, scope, input.period, before, "content"),
    ]);
    const rankBy = input.rankBy ?? "leads";
    return {
      scope: { ...scope },
      period: { ...input.period },
      previousPeriod: before,
      granularity: paidGranularity,
      current: paid.current,
      previous: paid.previous,
      comparison: paid.comparison,
      accountRanking: ranking(paid.rawRows, "account", rankBy),
      agentRanking: ranking(paid.rawRows, "agent", rankBy),
      rawRows: paid.rawRows,
      sources: { paid, organicAccount, content },
    };
  }

  createWeeklyReport(scope: ReportingScope, containingDate: string, granularity?: HistoricalMetricLevel): Promise<AgencyReport> {
    return this.createReport(scope, { period: weeklyPeriod(containingDate), granularity });
  }

  createMonthlyReport(scope: ReportingScope, year: number, month: number, granularity?: HistoricalMetricLevel): Promise<AgencyReport> {
    return this.createReport(scope, { period: monthlyPeriod(year, month), granularity });
  }

  createUnifiedWeeklyReport(
    scope: ReportingScope,
    containingDate: string,
    paidGranularity?: PaidHistoricalMetricLevel,
  ): Promise<AgencyReport> {
    return this.createUnifiedReport(scope, {
      period: weeklyPeriod(containingDate),
      paidGranularity,
    });
  }

  createUnifiedMonthlyReport(
    scope: ReportingScope,
    year: number,
    month: number,
    paidGranularity?: PaidHistoricalMetricLevel,
  ): Promise<AgencyReport> {
    return this.createUnifiedReport(scope, {
      period: monthlyPeriod(year, month),
      paidGranularity,
    });
  }
}

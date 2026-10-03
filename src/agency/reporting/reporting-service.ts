import {
  assertIsoDate,
  METRIC_NAMES,
  type HistoricalDataRepository,
  type HistoricalMetricLevel,
  type HistoricalMetricQuery,
  type HistoricalMetricRow,
  type MetricName,
  type MetricValues,
  type PaidHistoricalMetricLevel,
  type ReportingScope,
} from "../historical-data/index.js";
import { analyzeSegmentation, type SegmentationAnalysis } from "../segmentation/index.js";
import { metricRatio, mixedActionTypes, ratioCoverageLimitations, uniqueReach } from "../analytics/metric-definitions.js";

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
  limitations?: readonly string[];
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
  segmentation?: SegmentationAnalysis;
}

export type ReportDatasetSelection = Pick<HistoricalMetricQuery,
  "breakdownKeys" | "attributionWindow" | "apiVersion" | "schemaVersion">;

export interface CreateReportInput {
  period: ReportPeriod;
  granularity?: HistoricalMetricLevel;
  rankBy?: MetricName;
  dataset?: ReportDatasetSelection;
}

export interface CreateUnifiedReportInput {
  period: ReportPeriod;
  paidGranularity?: PaidHistoricalMetricLevel;
  rankBy?: MetricName;
  sourceAccountIds?: AgencyReportSourceAccountIds;
  paidDataset?: ReportDatasetSelection;
}

export interface AgencyReportSourceAccountIds {
  readonly paid?: readonly string[];
  readonly organicAccount?: readonly string[];
  readonly content?: readonly string[];
}

function validatedAccountIds(
  values: readonly string[] | undefined,
  field: string,
): readonly string[] | undefined {
  if (values === undefined) return undefined;
  if (values.length > 100) throw new Error(`${field} cannot exceed 100 account IDs`);
  if (values.some((value) => !/^(?:act_)?\d{1,32}$/.test(value))) {
    throw new Error(`${field} contains an invalid Meta account or asset ID`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`${field} cannot contain duplicate IDs`);
  }
  return [...values].sort();
}

function emptyMetrics(): MetricValues {
  return Object.fromEntries(METRIC_NAMES.map((name) => [name, null])) as MetricValues;
}

function sumMetric(rows: readonly HistoricalMetricRow[], name: MetricName): number | null {
  if (mixedActionTypes(rows, name)) return null;
  if (name === "reach") return uniqueReach(rows);
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

/** Ratios are always derived from aggregate totals; source row ratios are not averaged. */
function calculateMetrics(rows: readonly HistoricalMetricRow[]): MetricValues {
  const metrics = emptyMetrics();
  for (const name of METRIC_NAMES) metrics[name] = sumMetric(rows, name);
  metrics.ctr = metricRatio(rows, "clicks", "impressions", metrics.clicks, metrics.impressions, 100);
  metrics.cpc = metricRatio(rows, "spend", "clicks", metrics.spend, metrics.clicks);
  metrics.cpm = metricRatio(rows, "spend", "impressions", metrics.spend, metrics.impressions, 1000);
  metrics.cpl = metricRatio(rows, "spend", "leads", metrics.spend, metrics.leads);
  metrics.frequency = metricRatio(rows, "impressions", "reach", metrics.impressions, metrics.reach);
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
    limitations: [
      ...ratioCoverageLimitations(rows),
      ...METRIC_NAMES.filter((name) => mixedActionTypes(rows, name))
        .map((name) => `${name}: N/D; las filas usan tipos de acción diferentes.`),
      ...(rows.length === 0 ? ["Sin filas disponibles para el período seleccionado."] : []),
      ...(rows.length > 1 && rows.some((row) => row.metrics.reach !== null)
        ? ["Alcance único y frecuencia del período: N/D; no se suman personas entre días, anuncios o cuentas."] : []),
      ...(METRIC_NAMES.some((name) => rows.some((row) => row.metrics[name] === null) &&
        rows.some((row) => row.metrics[name] !== null))
        ? ["Cobertura parcial: algunas métricas sólo incluyen filas con valores disponibles."] : []),
    ],
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
  if (period.kind === "month") {
    const instant = new Date(`${period.startDate}T00:00:00.000Z`);
    const current = monthlyPeriod(instant.getUTCFullYear(), instant.getUTCMonth() + 1);
    if (period.startDate !== current.startDate || period.endDate !== current.endDate) {
      throw new Error("A monthly report must cover a complete calendar month");
    }
    return monthlyPeriod(instant.getUTCMonth() === 0 ? instant.getUTCFullYear() - 1 : instant.getUTCFullYear(),
      instant.getUTCMonth() === 0 ? 12 : instant.getUTCMonth());
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
  accountIds?: readonly string[],
  selection: ReportDatasetSelection = {},
): Promise<AgencyReportDataset> {
  const paid = ["account", "campaign", "ad_set", "ad"].includes(granularity);
  const query = { ...selection, ...(paid ? { breakdownKeys: selection.breakdownKeys ?? [] } : {}) };
  const [currentRows, previousRows] = await Promise.all([
    historicalData.list(scope, { ...period, level: granularity, accountIds, ...query }),
    historicalData.list(scope, { ...before, level: granularity, accountIds, ...query }),
  ]);
  if (paid) {
    for (const field of ["attributionWindow", "apiVersion", "schemaVersion"] as const) {
      if (new Set([...currentRows, ...previousRows].map((row) => row[field])).size > 1) {
        throw new Error(`Paid reporting requires a homogeneous ${field} dataset`);
      }
    }
    const timezones = new Map<string, string>();
    const identities = new Set<string>();
    for (const row of [...currentRows, ...previousRows]) {
      if (timezones.has(row.accountId) && timezones.get(row.accountId) !== row.timezone) {
        throw new Error("Paid reporting requires a stable timezone per account");
      }
      timezones.set(row.accountId, row.timezone);
      const identity = JSON.stringify([row.accountId, row.campaignId, row.adSetId, row.adId,
        row.date, row.currency, Object.entries(row.breakdowns).sort()]);
      if (identities.has(identity)) throw new Error("Duplicate paid source snapshots require migration before reporting");
      identities.add(identity);
    }
  }
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
      undefined,
      input.dataset,
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
      ...(["account", "campaign", "ad_set", "ad"].includes(granularity) ? {
        segmentation: { ...analyzeSegmentation(scope, dataset.rawRows), period: { ...input.period } },
      } : {}),
    };
  }

  async createUnifiedReport(
    scope: ReportingScope,
    input: CreateUnifiedReportInput,
  ): Promise<AgencyReport> {
    const paidGranularity = input.paidGranularity ?? "ad";
    const before = previousPeriod(input.period);
    const sourceAccountIds = input.sourceAccountIds ? {
      paid: validatedAccountIds(input.sourceAccountIds.paid, "paid source filter"),
      organicAccount: validatedAccountIds(
        input.sourceAccountIds.organicAccount,
        "organic source filter",
      ),
      content: validatedAccountIds(input.sourceAccountIds.content, "content source filter"),
    } : undefined;
    const [paid, organicAccount, content] = await Promise.all([
      reportDataset(
        this.historicalData,
        scope,
        input.period,
        before,
        paidGranularity,
        sourceAccountIds?.paid,
        input.paidDataset,
      ),
      reportDataset(
        this.historicalData,
        scope,
        input.period,
        before,
        "organic_account",
        sourceAccountIds?.organicAccount,
      ),
      reportDataset(
        this.historicalData,
        scope,
        input.period,
        before,
        "content",
        sourceAccountIds?.content,
      ),
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
      segmentation: { ...analyzeSegmentation(scope, paid.rawRows), period: { ...input.period } },
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

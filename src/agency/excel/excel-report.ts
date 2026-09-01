import {
  aggregateRows,
  type AgencyReport,
  type AgencyReportDataset,
} from "../reporting/index.js";
import {
  type HistoricalMetricRow,
  type MetricName,
  type MetricValues,
} from "../historical-data/index.js";

export const EXCEL_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const EXCEL_REPORT_SHEETS = [
  "Resumen Ejecutivo",
  "Dashboard Visual",
  "Rendimiento Semanal",
  "Rendimiento Mensual",
  "Campañas",
  "Ad Sets",
  "Ads",
  "Contenido",
  "Métricas Digitales",
  "Raw Data",
] as const;

export interface AgencyExcelReport {
  readonly filename: string;
  readonly contentType: typeof EXCEL_CONTENT_TYPE;
  readonly bytes: Uint8Array;
}

export interface GenerateExcelReportOptions {
  /** Supplying this makes exported workbooks reproducible in tests and scheduled runs. */
  readonly generatedAt?: string;
  readonly filename?: string;
}

type CellValue = string | number | boolean | null | undefined;
type Cell = { readonly value?: CellValue; readonly formula?: string; readonly style?: number };
type Row = readonly Cell[];
type Sheet = {
  readonly name: string;
  readonly rows: readonly Row[];
  readonly drawing?: boolean;
  readonly hiddenFromColumn?: number;
  readonly freezeRows?: number;
  readonly freezeColumns?: number;
  readonly autoFilter?: boolean;
  /** One-based column indexes with widths that differ from the sheet defaults. */
  readonly columnWidths?: Readonly<Record<number, number>>;
};
type ChartKind = "line" | "bar";

interface ChartSeries {
  readonly name: string;
  readonly values: readonly (number | null)[];
}

interface ChartDefinition {
  readonly title: string;
  readonly kind: ChartKind;
  readonly categories: readonly string[];
  readonly series: readonly ChartSeries[];
}

const METRIC_LABELS: readonly [MetricName, string, number][] = [
  ["reach", "Alcance", 2],
  ["impressions", "Impresiones", 2],
  ["clicks", "Clics", 2],
  ["messages", "Mensajes", 2],
  ["conversations", "Conversaciones", 2],
  ["leads", "Leads", 2],
  ["profileVisits", "Visitas al perfil", 2],
  ["interactions", "Interacciones", 2],
  ["newFollowers", "Nuevos seguidores", 2],
  ["followerCount", "Seguidores", 2],
  ["views", "Visualizaciones", 2],
  ["saves", "Guardados", 2],
  ["shares", "Compartidos", 2],
  ["spend", "Inversión", 3],
  ["cpc", "CPC", 3],
  ["cpl", "CPL", 3],
  ["cpm", "CPM", 3],
  ["ctr", "CTR", 4],
  ["conversions", "Conversiones", 2],
  ["frequency", "Frecuencia", 2],
];

const REDACTED_KEY = /(?:token|secret|authorization|password|api[_-]?key|private[_-]?key|credential|cookie|session)/i;
const REDACTED_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~-]+|\bEAA[A-Za-z0-9_-]{12,}|(?:access_token|refresh_token|id_token|client_secret)=[^&\s]+)/i;
const FORMULA_PREFIX = /^[=+\-@]/;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cleanText(value: unknown): string {
  const text = String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  return FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

/** Retains analytical raw values while excluding credential-shaped keys from exports. */
function redactRawData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactRawData);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        REDACTED_KEY.test(key) ? "[REDACTED]" : redactRawData(child),
      ]),
    );
  }
  if (typeof value === "string" && REDACTED_VALUE.test(value)) return "[REDACTED]";
  return value;
}

function columnName(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function metricValue(value: number | null | undefined): CellValue {
  return value === null || value === undefined ? "—" : value;
}

function excelMetricValue(metric: MetricName, value: number | null | undefined): CellValue {
  const normalized = metricValue(value);
  return metric === "ctr" && typeof normalized === "number" ? normalized / 100 : normalized;
}

function cellXml(cell: Cell, rowNumber: number, columnIndex: number): string {
  const reference = `${columnName(columnIndex)}${rowNumber}`;
  const style = cell.style === undefined ? "" : ` s=\"${cell.style}\"`;
  if (cell.formula) {
    const cached = typeof cell.value === "number" ? `<v>${cell.value}</v>` : "";
    return `<c r=\"${reference}\"${style}><f>${escapeXml(cell.formula)}</f>${cached}</c>`;
  }
  if (cell.value === null || cell.value === undefined) return "";
  if (typeof cell.value === "number") return `<c r=\"${reference}\"${style}><v>${cell.value}</v></c>`;
  if (typeof cell.value === "boolean") return `<c r=\"${reference}\" t=\"b\"${style}><v>${cell.value ? 1 : 0}</v></c>`;
  const text = escapeXml(cleanText(cell.value));
  return `<c r=\"${reference}\" t=\"inlineStr\"${style}><is><t xml:space=\"preserve\">${text}</t></is></c>`;
}

function sheetXml(sheet: Sheet): string {
  const rows = sheet.rows
    .map((row, index) => {
      const cells = row.map((cell, column) => cellXml(cell, index + 1, column)).join("");
      return `<row r=\"${index + 1}\">${cells}</row>`;
    })
    .join("");
  const drawing = sheet.drawing ? `<drawing r:id=\"rId1\"/>` : "";
  const columnCount = Math.max(1, ...sheet.rows.map((row) => row.length));
  const visibleEnd = sheet.hiddenFromColumn
    ? sheet.hiddenFromColumn - 1
    : Math.max(40, columnCount);
  const visibleColumns: string[] = [];
  let firstColumn = 1;
  let width = sheet.columnWidths?.[1] ?? 26;
  for (let column = 2; column <= visibleEnd + 1; column += 1) {
    const nextWidth = column <= visibleEnd
      ? sheet.columnWidths?.[column] ?? 16
      : null;
    if (nextWidth === width) continue;
    visibleColumns.push(`<col min=\"${firstColumn}\" max=\"${column - 1}\" width=\"${width}\" customWidth=\"1\"/>`);
    firstColumn = column;
    width = nextWidth ?? 16;
  }
  const hiddenColumns = sheet.hiddenFromColumn
    ? `<col min=\"${sheet.hiddenFromColumn}\" max=\"16384\" width=\"2\" hidden=\"1\" customWidth=\"1\"/>`
    : "";
  const freezeRows = sheet.freezeRows ?? 0;
  const freezeColumns = sheet.freezeColumns ?? 0;
  const topLeftCell = `${columnName(freezeColumns)}${freezeRows + 1}`;
  const activePane = freezeRows > 0 && freezeColumns > 0
    ? "bottomRight"
    : freezeRows > 0 ? "bottomLeft" : "topRight";
  const paneSplits = `${freezeColumns > 0 ? ` xSplit=\"${freezeColumns}\"` : ""}${freezeRows > 0 ? ` ySplit=\"${freezeRows}\"` : ""}`;
  const view = freezeRows > 0 || freezeColumns > 0
    ? `<pane${paneSplits} topLeftCell=\"${topLeftCell}\" activePane=\"${activePane}\" state=\"frozen\"/><selection pane=\"${activePane}\" activeCell=\"${topLeftCell}\" sqref=\"${topLeftCell}\"/>`
    : `<selection activeCell=\"A1\" sqref=\"A1\"/>`;
  const autoFilter = sheet.autoFilter
    ? `<autoFilter ref=\"A1:${columnName(columnCount - 1)}${Math.max(1, sheet.rows.length)}\"/>`
    : "";
  return `<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheetViews><sheetView workbookViewId=\"0\">${view}</sheetView></sheetViews><sheetFormatPr defaultRowHeight=\"15\"/><cols>${visibleColumns.join("")}${hiddenColumns}</cols><sheetData>${rows}</sheetData>${autoFilter}${drawing}</worksheet>`;
}

function stylesXml(): string {
  return `<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><numFmts count=\"3\"><numFmt numFmtId=\"164\" formatCode=\"#,##0.00\"/><numFmt numFmtId=\"165\" formatCode=\"#,##0.00;[Red]-#,##0.00\"/><numFmt numFmtId=\"166\" formatCode=\"0.00%\"/></numFmts><fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Aptos\"/></font><font><b/><sz val=\"11\"/><color rgb=\"FFFFFFFF\"/><name val=\"Aptos Display\"/></font></fonts><fills count=\"3\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill><fill><patternFill patternType=\"solid\"><fgColor rgb=\"FF1F4E78\"/><bgColor indexed=\"64\"/></patternFill></fill></fills><borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs><cellXfs count=\"5\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/><xf numFmtId=\"0\" fontId=\"1\" fillId=\"2\" borderId=\"0\" applyFont=\"1\" applyFill=\"1\" xfId=\"0\"/><xf numFmtId=\"164\" fontId=\"0\" fillId=\"0\" borderId=\"0\" applyNumberFormat=\"1\" xfId=\"0\"/><xf numFmtId=\"165\" fontId=\"0\" fillId=\"0\" borderId=\"0\" applyNumberFormat=\"1\" xfId=\"0\"/><xf numFmtId=\"166\" fontId=\"0\" fillId=\"0\" borderId=\"0\" applyNumberFormat=\"1\" xfId=\"0\"/></cellXfs></styleSheet>`;
}

function aggregateBy<T extends string>(
  rows: readonly HistoricalMetricRow[],
  getKey: (row: HistoricalMetricRow) => T,
  getName: (row: HistoricalMetricRow) => string,
): Array<{ id: T; name: string; metrics: MetricValues; currencies: readonly string[]; rows: number }> {
  const groups = new Map<T, HistoricalMetricRow[]>();
  for (const row of rows) {
    const key = getKey(row);
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }
  return [...groups.entries()]
    .map(([id, entries]) => {
      const aggregate = aggregateRows(entries);
      return { id, name: getName(entries[0]), metrics: aggregate.metrics, currencies: aggregate.currencies, rows: entries.length };
    })
    .sort((left, right) => (right.metrics.leads ?? -1) - (left.metrics.leads ?? -1) || left.name.localeCompare(right.name));
}

function metricRows(metrics: MetricValues): Row[] {
  return METRIC_LABELS.map(([metric, label, style]) => [
    { value: label },
    { value: excelMetricValue(metric, metrics[metric]), style },
  ]);
}

function metricTableRows(report: AgencyReport): Row[] {
  return comparisonRows(report.comparison);
}

function comparisonRows(
  comparison: AgencyReport["comparison"],
): Row[] {
  return [
    [{ value: "Métrica", style: 1 }, { value: "Actual", style: 1 }, { value: "Anterior", style: 1 }, { value: "Variación", style: 1 }, { value: "Variación %", style: 1 }],
    ...METRIC_LABELS.map(([metric, label, style]) => {
      const change = comparison[metric];
      return [
        { value: label },
        { value: excelMetricValue(metric, change.current), style },
        { value: excelMetricValue(metric, change.previous), style },
        { value: excelMetricValue(metric, change.absoluteChange), style },
        { value: metricValue(change.percentageChange === null ? null : change.percentageChange / 100), style: 4 },
      ];
    }),
  ];
}

function reportSourceRows(report: AgencyReport): {
  paid: readonly HistoricalMetricRow[];
  organicAccount: readonly HistoricalMetricRow[];
  content: readonly HistoricalMetricRow[];
  all: readonly HistoricalMetricRow[];
} {
  const paid = report.sources?.paid.rawRows ?? (
    report.granularity === "organic_account" || report.granularity === "content" ? [] : report.rawRows
  );
  const organicAccount = report.sources?.organicAccount.rawRows ?? (
    report.granularity === "organic_account" ? report.rawRows : []
  );
  const content = report.sources?.content.rawRows ?? (
    report.granularity === "content" ? report.rawRows : []
  );
  const all = [...paid, ...organicAccount, ...content]
    .sort((left, right) =>
      left.date.localeCompare(right.date) ||
      left.level.localeCompare(right.level) ||
      left.id.localeCompare(right.id));
  return { paid, organicAccount, content, all };
}

function datasetSection(title: string, dataset: AgencyReportDataset): Row[] {
  return [
    [{ value: title, style: 1 }, { value: `Nivel: ${dataset.granularity}` }],
    ...comparisonRows(dataset.comparison),
    [],
  ];
}

function digitalMetricRows(report: AgencyReport): Row[] {
  if (!report.sources) return metricTableRows(report);
  return [
    [{ value: "Métricas Digitales", style: 1 }, { value: "Datasets separados; no sumar alcance entre fuentes." }],
    [],
    ...datasetSection("Meta Ads", report.sources.paid),
    ...datasetSection("Orgánico de cuenta", report.sources.organicAccount),
    ...datasetSection("Contenido orgánico publicado", report.sources.content),
  ];
}

function weekStart(date: string): string {
  const instant = new Date(`${date}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() - ((instant.getUTCDay() + 6) % 7));
  return instant.toISOString().slice(0, 10);
}

function periodRows(report: AgencyReport, grouping: "week" | "month"): Row[] {
  const groups = new Map<string, HistoricalMetricRow[]>();
  for (const row of report.rawRows) {
    const key = grouping === "week" ? weekStart(row.date) : row.date.slice(0, 7);
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }
  const entries = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  return [
    [
      { value: grouping === "week" ? "Semana desde" : "Mes", style: 1 },
      { value: "Monedas", style: 1 },
      ...METRIC_LABELS.map(([, label]) => ({ value: label, style: 1 })),
    ],
    ...entries.map(([date, rows]) => {
      const aggregate = aggregateRows(rows);
      return [
        { value: date },
        { value: aggregate.currencies.join(", ") },
        ...METRIC_LABELS.map(([metric, , style]) => ({
          value: excelMetricValue(metric, aggregate.metrics[metric]),
          style,
        })),
      ];
    }),
  ];
}

function dimensionRows(
  rows: readonly HistoricalMetricRow[],
  type: "campaign" | "adSet" | "ad",
): Row[] {
  const columnLabel = type === "campaign" ? "Campaña" : type === "adSet" ? "Ad Set" : "Ad";
  const grouped = aggregateBy(
    rows.filter((row) => (type === "campaign" ? row.campaignId : type === "adSet" ? row.adSetId : row.adId) !== null),
    (row) => (type === "campaign" ? row.campaignId : type === "adSet" ? row.adSetId : row.adId) ?? "sin-id",
    (row) => (type === "campaign" ? row.campaignName : type === "adSet" ? row.adSetName : row.adName) ?? "Sin nombre",
  );
  return [
    [
      { value: `${columnLabel} ID`, style: 1 },
      { value: columnLabel, style: 1 },
      { value: "Monedas", style: 1 },
      { value: "Filas", style: 1 },
      ...METRIC_LABELS.map(([, label]) => ({ value: label, style: 1 })),
    ],
    ...grouped.map((entry) => [
      { value: entry.id },
      { value: entry.name },
      { value: entry.currencies.join(", ") },
      { value: entry.rows, style: 2 },
      ...METRIC_LABELS.map(([metric, , style]) => ({
        value: excelMetricValue(metric, entry.metrics[metric]),
        style,
      })),
    ]),
  ];
}

function contentRows(rows: readonly HistoricalMetricRow[]): Row[] {
  return [
    [
      { value: "Fecha", style: 1 }, { value: "Contenido ID", style: 1 }, { value: "Contenido", style: 1 },
      { value: "Tipo", style: 1 }, { value: "Campaña", style: 1 }, { value: "Ad Set", style: 1 }, { value: "Moneda", style: 1 },
      { value: "Alcance", style: 1 }, { value: "Interacciones", style: 1 }, { value: "Guardados", style: 1 },
      { value: "Compartidos", style: 1 }, { value: "Clics", style: 1 }, { value: "Leads", style: 1 },
    ],
    ...rows.map((row) => [
      { value: row.date }, { value: row.contentId ?? row.adId ?? "" }, { value: row.contentName ?? row.adName ?? "" },
      { value: row.contentType ?? (row.adId ? "ad" : "") }, { value: row.campaignName ?? "" }, { value: row.adSetName ?? "" }, { value: row.currency },
      { value: metricValue(row.metrics.reach), style: 2 }, { value: metricValue(row.metrics.interactions), style: 2 },
      { value: metricValue(row.metrics.saves ?? asMetric(row.rawData, "saves")), style: 2 }, { value: metricValue(row.metrics.shares ?? asMetric(row.rawData, "shares")), style: 2 },
      { value: metricValue(row.metrics.clicks), style: 2 }, { value: metricValue(row.metrics.leads), style: 2 },
    ]),
  ];
}

function asMetric(raw: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = raw[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rawRows(rows: readonly HistoricalMetricRow[]): Row[] {
  return [
    [
      { value: "tenant_scope", style: 1 }, { value: "workspace_scope", style: 1 }, { value: "id", style: 1 },
      { value: "date", style: 1 }, { value: "level", style: 1 }, { value: "account_id", style: 1 },
      { value: "account_name", style: 1 }, { value: "campaign_id", style: 1 }, { value: "campaign_name", style: 1 },
      { value: "adset_id", style: 1 }, { value: "adset_name", style: 1 }, { value: "ad_id", style: 1 },
      { value: "ad_name", style: 1 }, { value: "content_id", style: 1 }, { value: "content_name", style: 1 },
      { value: "content_type", style: 1 }, { value: "agent_id", style: 1 }, { value: "agent_name", style: 1 },
      { value: "currency", style: 1 }, { value: "timezone", style: 1 }, { value: "quality", style: 1 },
      ...METRIC_LABELS.map(([, label]) => ({ value: label, style: 1 })),
      { value: "breakdowns_json", style: 1 }, { value: "raw_data_json", style: 1 },
    ],
    ...rows.map((row) => [
      { value: "scoped" }, { value: "scoped" }, { value: row.id }, { value: row.date }, { value: row.level },
      { value: row.accountId }, { value: row.accountName }, { value: row.campaignId ?? "" }, { value: row.campaignName ?? "" },
      { value: row.adSetId ?? "" }, { value: row.adSetName ?? "" }, { value: row.adId ?? "" }, { value: row.adName ?? "" },
      { value: row.contentId ?? "" }, { value: row.contentName ?? "" }, { value: row.contentType ?? "" },
      { value: row.agentId ?? "" }, { value: row.agentName ?? "" }, { value: row.currency }, { value: row.timezone }, { value: row.quality },
      ...METRIC_LABELS.map(([metric, , style]) => ({
        value: excelMetricValue(metric, row.metrics[metric]),
        style,
      })),
      { value: JSON.stringify(redactRawData(row.breakdowns)) }, { value: JSON.stringify(redactRawData(row.rawData)) },
    ]),
  ];
}

function categorySeries(rows: readonly HistoricalMetricRow[]): { categories: string[]; aggregates: MetricValues[] } {
  const byDate = new Map<string, HistoricalMetricRow[]>();
  for (const row of rows) {
    const current = byDate.get(row.date) ?? [];
    current.push(row);
    byDate.set(row.date, current);
  }
  const categories = [...byDate.keys()].sort();
  return { categories, aggregates: categories.map((date) => aggregateRows(byDate.get(date) ?? []).metrics) };
}

function topContent(rows: readonly HistoricalMetricRow[]): Array<{ name: string; value: number | null }> {
  return aggregateBy(
    rows.filter((row) => row.contentId !== null || row.adId !== null),
    (row) => row.contentId ?? row.adId ?? "sin-id",
    (row) => row.contentName ?? row.adName ?? "Sin nombre",
  )
    .sort(
      (left, right) =>
        (right.metrics.interactions ?? -1) - (left.metrics.interactions ?? -1) ||
        left.name.localeCompare(right.name),
    )
    .slice(0, 10)
    .map((entry) => ({ name: entry.name, value: entry.metrics.interactions }));
}

function chartsFor(
  report: AgencyReport,
  contentRowsForReport: readonly HistoricalMetricRow[] = [],
): ChartDefinition[] {
  const daily = categorySeries(report.rawRows);
  const weekGroups = new Map<string, HistoricalMetricRow[]>();
  for (const row of report.rawRows) {
    const day = new Date(`${row.date}T00:00:00.000Z`).getUTCDay();
    const mondayOffset = (day + 6) % 7;
    const start = new Date(`${row.date}T00:00:00.000Z`);
    start.setUTCDate(start.getUTCDate() - mondayOffset);
    const week = start.toISOString().slice(0, 10);
    const current = weekGroups.get(week) ?? [];
    current.push(row);
    weekGroups.set(week, current);
  }
  const weeks = [...weekGroups.keys()].sort();
  const weekly = weeks.map((week) => aggregateRows(weekGroups.get(week) ?? []).metrics);
  const campaigns = aggregateBy(report.rawRows.filter((row) => row.campaignId !== null), (row) => row.campaignId ?? "sin-id", (row) => row.campaignName ?? "Sin nombre").slice(0, 10);
  const contents = topContent(contentRowsForReport.length > 0 ? contentRowsForReport : report.rawRows);
  const currencyUnit = report.current.currencies.length === 1
    ? report.current.currencies[0]
    : "moneda de cada cuenta";
  const charts: ChartDefinition[] = [
    { title: "Alcance diario", kind: "line", categories: daily.categories, series: [{ name: "Alcance", values: daily.aggregates.map((metric) => metric.reach) }] },
    { title: "Clics diarios", kind: "line", categories: daily.categories, series: [{ name: "Clics", values: daily.aggregates.map((metric) => metric.clicks) }] },
    { title: "Mensajes vs leads", kind: "line", categories: daily.categories, series: [{ name: "Mensajes", values: daily.aggregates.map((metric) => metric.messages) }, { name: "Leads", values: daily.aggregates.map((metric) => metric.leads) }] },
    { title: `Inversión semanal (${currencyUnit})`, kind: "bar", categories: weeks, series: [{ name: "Inversión", values: weekly.map((metric) => metric.spend) }] },
    { title: "Leads semanales", kind: "bar", categories: weeks, series: [{ name: "Leads", values: weekly.map((metric) => metric.leads) }] },
    { title: "Evolución de CTR (%)", kind: "line", categories: daily.categories, series: [{ name: "CTR (%)", values: daily.aggregates.map((metric) => metric.ctr) }] },
    { title: `Evolución de CPC/CPL (${currencyUnit})`, kind: "line", categories: daily.categories, series: [{ name: "CPC", values: daily.aggregates.map((metric) => metric.cpc) }, { name: "CPL", values: daily.aggregates.map((metric) => metric.cpl) }] },
    { title: "Top campañas", kind: "bar", categories: campaigns.map((entry) => entry.name), series: [{ name: "Leads", values: campaigns.map((entry) => entry.metrics.leads) }] },
    { title: "Top contenidos", kind: "bar", categories: contents.map((entry) => entry.name), series: [{ name: "Interacciones", values: contents.map((entry) => entry.value) }] },
    { title: "Funnel", kind: "bar", categories: ["Alcance", "Visita", "Clic", "Mensaje", "Lead"], series: [{ name: "Usuarios", values: [report.current.metrics.reach, report.current.metrics.profileVisits, report.current.metrics.clicks, report.current.metrics.messages, report.current.metrics.leads] }] },
  ];
  return charts.map((chart) => chart.categories.length > 0
    ? chart
    : { ...chart, categories: ["Sin datos"], series: chart.series.map((series) => ({ ...series, values: [null] })) });
}

function cachePoints(values: readonly (number | null)[]): string {
  const points = values.flatMap((value, index) => value === null ? [] : [`<c:pt idx=\"${index}\"><c:v>${value}</c:v></c:pt>`]);
  return `<c:ptCount val=\"${values.length}\"/>${points.join("")}`;
}

function stringCache(values: readonly string[]): string {
  return `<c:ptCount val=\"${values.length}\"/>${values.map((value, index) => `<c:pt idx=\"${index}\"><c:v>${escapeXml(value)}</c:v></c:pt>`).join("")}`;
}

function chartXml(chart: ChartDefinition, sourceColumns: { category: string; values: readonly string[] }): string {
  const axisOne = 123456 + sourceColumns.values.length;
  const axisTwo = 234567 + sourceColumns.values.length;
  const categoryFormula = `'Dashboard Visual'!$${sourceColumns.category}$3:$${sourceColumns.category}$${chart.categories.length + 2}`;
  const series = chart.series.map((entry, index) => {
    const valueColumn = sourceColumns.values[index];
    const valueFormula = `'Dashboard Visual'!$${valueColumn}$3:$${valueColumn}$${entry.values.length + 2}`;
    const common = `<c:idx val=\"${index}\"/><c:order val=\"${index}\"/><c:tx><c:v>${escapeXml(entry.name)}</c:v></c:tx><c:cat><c:strRef><c:f>${escapeXml(categoryFormula)}</c:f><c:strCache>${stringCache(chart.categories)}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>${escapeXml(valueFormula)}</c:f><c:numCache>${cachePoints(entry.values)}</c:numCache></c:numRef></c:val>`;
    return `<c:ser>${common}</c:ser>`;
  }).join("");
  const plot = chart.kind === "bar"
    ? `<c:barChart><c:barDir val=\"col\"/><c:grouping val=\"clustered\"/><c:varyColors val=\"0\"/>${series}<c:axId val=\"${axisOne}\"/><c:axId val=\"${axisTwo}\"/></c:barChart>`
    : `<c:lineChart><c:grouping val=\"standard\"/><c:varyColors val=\"0\"/>${series}<c:axId val=\"${axisOne}\"/><c:axId val=\"${axisTwo}\"/></c:lineChart>`;
  return `<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><c:chartSpace xmlns:c=\"http://schemas.openxmlformats.org/drawingml/2006/chart\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang=\"es-BO\"/><a:t>${escapeXml(chart.title)}</a:t></a:r></a:p></c:rich></c:tx><c:layout/></c:title><c:autoTitleDeleted val=\"0\"/><c:plotArea><c:layout/>${plot}<c:catAx><c:axId val=\"${axisOne}\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling><c:axPos val=\"b\"/><c:tickLblPos val=\"nextTo\"/><c:crossAx val=\"${axisTwo}\"/><c:crosses val=\"autoZero\"/></c:catAx><c:valAx><c:axId val=\"${axisTwo}\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling><c:axPos val=\"l\"/><c:majorGridlines/><c:tickLblPos val=\"nextTo\"/><c:crossAx val=\"${axisOne}\"/><c:crosses val=\"autoZero\"/></c:valAx></c:plotArea><c:legend><c:legendPos val=\"r\"/><c:layout/></c:legend><c:plotVisOnly val=\"0\"/></c:chart></c:chartSpace>`;
}

function drawingXml(chartCount: number): string {
  const anchors = Array.from({ length: chartCount }, (_, index) => {
    const column = index % 2 === 0 ? 0 : 9;
    const row = Math.floor(index / 2) * 18 + 20;
    return `<xdr:twoCellAnchor editAs=\"oneCell\"><xdr:from><xdr:col>${column}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${column + 8}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row + 16}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id=\"${index + 2}\" name=\"Chart ${index + 1}\"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/><a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/chart\"><c:chart r:id=\"rId${index + 1}\"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
  }).join("");
  return `<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><xdr:wsDr xmlns:xdr=\"http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:c=\"http://schemas.openxmlformats.org/drawingml/2006/chart\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">${anchors}</xdr:wsDr>`;
}

function relationshipsXml(relationships: readonly { id: string; type: string; target: string }[]): string {
  return `<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">${relationships.map((relationship) => `<Relationship Id=\"${relationship.id}\" Type=\"${relationship.type}\" Target=\"${relationship.target}\"/>`).join("")}</Relationships>`;
}

function contentTypesXml(sheetCount: number, chartCount: number): string {
  const sheets = Array.from({ length: sheetCount }, (_, index) => `<Override PartName=\"/xl/worksheets/sheet${index + 1}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>`).join("");
  const charts = Array.from({ length: chartCount }, (_, index) => `<Override PartName=\"/xl/charts/chart${index + 1}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.drawingml.chart+xml\"/>`).join("");
  return `<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/><Override PartName=\"/xl/drawings/drawing1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.drawing+xml\"/><Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/><Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/>${sheets}${charts}</Types>`;
}

function workbookXml(sheets: readonly Sheet[]): string {
  return `<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><fileVersion appName=\"xl\"/><workbookPr/><bookViews><workbookView xWindow=\"0\" yWindow=\"0\" windowWidth=\"24000\" windowHeight=\"12000\"/></bookViews><sheets>${sheets.map((sheet, index) => `<sheet name=\"${escapeXml(sheet.name)}\" sheetId=\"${index + 1}\" r:id=\"rId${index + 1}\"/>`).join("")}</sheets><calcPr calcId=\"191029\" calcMode=\"auto\" fullCalcOnLoad=\"1\" forceFullCalc=\"1\"/></workbook>`;
}

function corePropertiesXml(generatedAt: string): string {
  return `<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" xmlns:dcmitype=\"http://purl.org/dc/dcmitype/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"><dc:creator>Meta Agency Intelligence</dc:creator><dc:title>Reporte de agencia</dc:title><dc:description>Reporte read-only; no contiene credenciales.</dc:description><dcterms:created xsi:type=\"dcterms:W3CDTF\">${escapeXml(generatedAt)}</dcterms:created><dcterms:modified xsi:type=\"dcterms:W3CDTF\">${escapeXml(generatedAt)}</dcterms:modified></cp:coreProperties>`;
}

function appPropertiesXml(): string {
  return `<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\" xmlns:vt=\"http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes\"><Application>Meta Agency Intelligence</Application></Properties>`;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function u16(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}

function u32(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function joinBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** Minimal ZIP writer using stored entries; XLSX remains an ordinary editable OOXML package. */
function zip(files: ReadonlyMap<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const entries = [...files.entries()].map(([name, content]) => ({ name: encoder.encode(name), content: encoder.encode(content) }));
  let offset = 0;
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  for (const entry of entries) {
    const checksum = crc32(entry.content);
    const local = joinBytes([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(checksum), u32(entry.content.length), u32(entry.content.length), u16(entry.name.length), u16(0), entry.name, entry.content]);
    locals.push(local);
    central.push(joinBytes([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(checksum), u32(entry.content.length), u32(entry.content.length), u16(entry.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), entry.name]));
    offset += local.length;
  }
  const centralBytes = joinBytes(central);
  const trailer = joinBytes([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(centralBytes.length), u32(offset), u16(0)]);
  return joinBytes([...locals, centralBytes, trailer]);
}

function sourceDataRows(charts: readonly ChartDefinition[]): { rows: Row[]; columns: Array<{ category: string; values: readonly string[] }> } {
  const columns: Array<{ category: string; values: readonly string[] }> = [];
  let startColumn = 15;
  for (const chart of charts) {
    const category = columnName(startColumn);
    const valueColumns = chart.series.map((_, index) => columnName(startColumn + index + 1));
    columns.push({ category, values: valueColumns });
    startColumn += Math.max(3, chart.series.length + 1);
  }
  const width = startColumn - 15;
  const output: Cell[][] = [];
  const maxRows = Math.max(...charts.map((chart) => chart.categories.length + 2), 1);
  for (let row = 0; row < maxRows; row += 1) output.push(Array.from({ length: width }, () => ({})));
  let offset = 0;
  for (const chart of charts) {
    output[0][offset] = { value: chart.title, style: 1 };
    output[1][offset] = { value: "Categoría", style: 1 };
    chart.series.forEach((series, index) => { output[1][offset + index + 1] = { value: series.name, style: 1 }; });
    for (let index = 0; index < chart.categories.length; index += 1) {
      output[index + 2][offset] = { value: chart.categories[index] };
      chart.series.forEach((series, seriesIndex) => { output[index + 2][offset + seriesIndex + 1] = { value: metricValue(series.values[index]), style: 2 }; });
    }
    offset += Math.max(3, chart.series.length + 1);
  }
  return { rows: output, columns };
}

export class AgencyExcelReportGenerator {
  generate(report: AgencyReport, options: GenerateExcelReportOptions = {}): AgencyExcelReport {
    if (!report.scope.tenantId.trim() || !report.scope.workspaceId.trim()) throw new Error("Excel reports require a tenant-scoped report");
    const generatedAt = options.generatedAt ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(generatedAt))) throw new Error("generatedAt must be an ISO timestamp");
    const filename = options.filename ?? `meta-agency-report-${report.period.startDate}-to-${report.period.endDate}.xlsx`;
    if (!/^[a-zA-Z0-9._-]+\.xlsx$/.test(filename)) throw new Error("filename must be a safe .xlsx filename");

    const sourceRows = reportSourceRows(report);
    const charts = chartsFor(report, sourceRows.content);
    const sources = sourceDataRows(charts);
    const organicMetrics = report.sources?.organicAccount.current.metrics;
    const dashboardKpis: Row[] = [
      [
        { value: "Dashboard Visual", style: 1 },
        { value: `Periodo: ${report.period.startDate} a ${report.period.endDate}` },
        {},
        { value: "Orgánico de cuenta", style: 1 },
      ],
      [
        { value: "Métrica Ads", style: 1 }, { value: "Valor", style: 1 }, { value: "Auditoría", style: 1 },
        { value: "Métrica orgánica", style: 1 }, { value: "Valor", style: 1 }, { value: "Auditoría", style: 1 },
      ],
      ...METRIC_LABELS.map(([metric, label, style], index) => [
        { value: label },
        {
          formula: `'Resumen Ejecutivo'!B${index + 5}`,
          value: excelMetricValue(metric, report.current.metrics[metric]),
          style,
        },
        { value: "Vinculado a Resumen Ejecutivo" },
        { value: label },
        { value: excelMetricValue(metric, organicMetrics?.[metric]), style },
        { value: report.sources ? "Dataset organic_account; no sumado con Ads" : "Sin dataset orgánico" },
      ]),
    ];
    const dashboardRows = Array.from({ length: Math.max(dashboardKpis.length, sources.rows.length) }, (_, index) => [
      ...(dashboardKpis[index] ?? Array.from({ length: 6 }, () => ({}))),
      ...Array.from({ length: 9 }, () => ({})),
      ...((sources.rows[index] ?? []) as Row),
    ]);
    const currencyNote = report.current.currencies.length > 1
      ? "Inversión y ratios monetarios se muestran por moneda; no se suman monedas distintas."
      : `Moneda: ${report.current.currencies[0] ?? "sin datos"}.`;
    const summary: Row[] = [
      [{ value: "Resumen Ejecutivo", style: 1 }, { value: "Reporte de rendimiento de agencia" }],
      [{ value: "Periodo", style: 1 }, { value: `${report.period.startDate} a ${report.period.endDate}` }],
      [{ value: "Nota de moneda", style: 1 }, { value: currencyNote }],
      [{ value: "Métrica", style: 1 }, { value: "Actual", style: 1 }],
      ...metricRows(report.current.metrics),
      [],
      [{ value: "Desglose por moneda", style: 1 }],
      [{ value: "Moneda", style: 1 }, { value: "Inversión", style: 1 }, { value: "CPC", style: 1 }, { value: "CPM", style: 1 }, { value: "CPL", style: 1 }],
      ...Object.entries(report.current.currencyBreakdown).map(([currency, metrics]) => [{ value: currency }, { value: metricValue(metrics.spend), style: 3 }, { value: metricValue(metrics.cpc), style: 3 }, { value: metricValue(metrics.cpm), style: 3 }, { value: metricValue(metrics.cpl), style: 3 }]),
      ...(report.sources ? [
        [] as Row,
        [{ value: "Orgánico de cuenta", style: 1 }, { value: "No se suma con Ads para evitar doble conteo." }] as Row,
        [{ value: "Métrica", style: 1 }, { value: "Actual", style: 1 }] as Row,
        ...metricRows(report.sources.organicAccount.current.metrics),
        [] as Row,
        [{ value: "Contenido orgánico publicado", style: 1 }, { value: "Snapshots lifetime por fecha de publicación." }] as Row,
        [{ value: "Métrica", style: 1 }, { value: "Actual", style: 1 }] as Row,
        ...metricRows(report.sources.content.current.metrics),
      ] : []),
    ];
    const sheets: Sheet[] = [
      { name: EXCEL_REPORT_SHEETS[0], rows: summary, freezeRows: 4, columnWidths: { 1: 30, 2: 30 } },
      {
        name: EXCEL_REPORT_SHEETS[1],
        rows: dashboardRows,
        drawing: true,
        hiddenFromColumn: 16,
        freezeRows: 2,
        columnWidths: { 1: 24, 3: 30, 4: 24, 6: 42 },
      },
      { name: EXCEL_REPORT_SHEETS[2], rows: periodRows(report, "week"), freezeRows: 1, freezeColumns: 2, autoFilter: true, columnWidths: { 1: 16, 2: 14 } },
      { name: EXCEL_REPORT_SHEETS[3], rows: periodRows(report, "month"), freezeRows: 1, freezeColumns: 2, autoFilter: true, columnWidths: { 1: 16, 2: 14 } },
      { name: EXCEL_REPORT_SHEETS[4], rows: dimensionRows(sourceRows.paid, "campaign"), freezeRows: 1, freezeColumns: 2, autoFilter: true, columnWidths: { 1: 20, 2: 30, 3: 12, 4: 10 } },
      { name: EXCEL_REPORT_SHEETS[5], rows: dimensionRows(sourceRows.paid, "adSet"), freezeRows: 1, freezeColumns: 2, autoFilter: true, columnWidths: { 1: 20, 2: 28, 3: 12, 4: 10 } },
      { name: EXCEL_REPORT_SHEETS[6], rows: dimensionRows(sourceRows.paid, "ad"), freezeRows: 1, freezeColumns: 2, autoFilter: true, columnWidths: { 1: 20, 2: 30, 3: 12, 4: 10 } },
      { name: EXCEL_REPORT_SHEETS[7], rows: contentRows([...sourceRows.paid, ...sourceRows.content]), freezeRows: 1, freezeColumns: 3, autoFilter: true, columnWidths: { 1: 14, 2: 20, 3: 32, 4: 20, 5: 30, 6: 26, 7: 12 } },
      { name: EXCEL_REPORT_SHEETS[8], rows: digitalMetricRows(report), freezeRows: report.sources ? 4 : 1, columnWidths: { 1: 28, 2: 20, 3: 20, 4: 20, 5: 20 } },
      { name: EXCEL_REPORT_SHEETS[9], rows: rawRows(sourceRows.all), freezeRows: 1, freezeColumns: 6, autoFilter: true, columnWidths: { 1: 16, 2: 18, 3: 30, 4: 14, 5: 16, 6: 16, 7: 26, 9: 28, 11: 24, 13: 30, 15: 30 } },
    ];
    const files = new Map<string, string>();
    files.set("[Content_Types].xml", contentTypesXml(sheets.length, charts.length));
    files.set("_rels/.rels", relationshipsXml([{ id: "rId1", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument", target: "xl/workbook.xml" }, { id: "rId2", type: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", target: "docProps/core.xml" }, { id: "rId3", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties", target: "docProps/app.xml" }]));
    files.set("docProps/core.xml", corePropertiesXml(generatedAt));
    files.set("docProps/app.xml", appPropertiesXml());
    files.set("xl/workbook.xml", workbookXml(sheets));
    files.set("xl/_rels/workbook.xml.rels", relationshipsXml([...sheets.map((_, index) => ({ id: `rId${index + 1}`, type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet", target: `worksheets/sheet${index + 1}.xml` })), { id: `rId${sheets.length + 1}`, type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles", target: "styles.xml" }]));
    files.set("xl/styles.xml", stylesXml());
    sheets.forEach((sheet, index) => files.set(`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet)));
    files.set("xl/worksheets/_rels/sheet2.xml.rels", relationshipsXml([{ id: "rId1", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing", target: "../drawings/drawing1.xml" }]));
    files.set("xl/drawings/drawing1.xml", drawingXml(charts.length));
    files.set("xl/drawings/_rels/drawing1.xml.rels", relationshipsXml(charts.map((_, index) => ({ id: `rId${index + 1}`, type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart", target: `../charts/chart${index + 1}.xml` }))));
    charts.forEach((chart, index) => files.set(`xl/charts/chart${index + 1}.xml`, chartXml(chart, sources.columns[index])));
    return { filename, contentType: EXCEL_CONTENT_TYPE, bytes: zip(files) };
  }
}

export function generateAgencyExcelReport(report: AgencyReport, options?: GenerateExcelReportOptions): AgencyExcelReport {
  return new AgencyExcelReportGenerator().generate(report, options);
}

import {
  AgencyExcelReportGenerator,
  type AgencyExcelReport,
  type GenerateExcelReportOptions,
} from "../excel/excel-report.js";
import {
  AgencyInsightsIngestionService,
  type InsightsIngestionRequest,
  type InsightsIngestionResult,
} from "../ingestion/index.js";
import {
  AgencyReportingService,
  type AgencyReport,
  type ReportPeriod,
} from "../reporting/reporting-service.js";

export interface GenerateReadOnlyReportInput {
  readonly ingestion: InsightsIngestionRequest;
  readonly period: ReportPeriod;
  readonly excel?: GenerateExcelReportOptions;
}

export interface ReadOnlyReportingResult {
  readonly ingestion: InsightsIngestionResult;
  readonly report: AgencyReport;
  readonly excel: AgencyExcelReport;
}

export class AgencyReadOnlyReportingPipeline {
  constructor(
    private readonly ingestion: AgencyInsightsIngestionService,
    private readonly reporting: AgencyReportingService,
    private readonly excel = new AgencyExcelReportGenerator(),
  ) {}

  async run(input: GenerateReadOnlyReportInput): Promise<ReadOnlyReportingResult> {
    if (
      input.period.startDate < input.ingestion.startDate ||
      input.period.endDate > input.ingestion.endDate
    ) {
      throw new Error("The ingestion window must fully cover the requested report period");
    }
    const ingestion = await this.ingestion.run(input.ingestion);
    const report = await this.reporting.createUnifiedReport(input.ingestion.scope, {
      period: input.period,
      paidGranularity: input.ingestion.level,
    });
    const excel = this.excel.generate(report, input.excel);
    return { ingestion, report, excel };
  }
}

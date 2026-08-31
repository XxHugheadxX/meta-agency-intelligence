import {
  AgencyExcelReportGenerator,
  type AgencyExcelReport,
  type GenerateExcelReportOptions,
} from "../excel/excel-report.js";
import {
  AgencyInsightsIngestionService,
  AgencyOrganicContentIngestionService,
  AgencyOrganicIngestionService,
  type OrganicContentIngestionRequest,
  type OrganicContentIngestionResult,
  type OrganicIngestionRequest,
  type OrganicIngestionResult,
  type InsightsIngestionRequest,
  type InsightsIngestionResult,
} from "../ingestion/index.js";
import {
  AgencyReportingService,
  type AgencyReport,
  type AgencyReportSourceAccountIds,
  type ReportPeriod,
} from "../reporting/reporting-service.js";

export interface GenerateReadOnlyReportInput {
  readonly ingestion: InsightsIngestionRequest;
  readonly organicIngestions?: readonly OrganicIngestionRequest[];
  readonly contentIngestions?: readonly OrganicContentIngestionRequest[];
  readonly reportSourceAccountIds?: AgencyReportSourceAccountIds;
  readonly period: ReportPeriod;
  readonly excel?: GenerateExcelReportOptions;
}

export interface ReadOnlyReportingResult {
  readonly ingestion: InsightsIngestionResult;
  readonly organicIngestions: readonly OrganicIngestionResult[];
  readonly contentIngestions: readonly OrganicContentIngestionResult[];
  readonly report: AgencyReport;
  readonly excel: AgencyExcelReport;
}

export class AgencyReadOnlyReportingPipeline {
  constructor(
    private readonly ingestion: AgencyInsightsIngestionService,
    private readonly reporting: AgencyReportingService,
    private readonly excel = new AgencyExcelReportGenerator(),
    private readonly organicIngestion?: AgencyOrganicIngestionService,
    private readonly contentIngestion?: AgencyOrganicContentIngestionService,
  ) {}

  async run(input: GenerateReadOnlyReportInput): Promise<ReadOnlyReportingResult> {
    if (
      input.period.startDate < input.ingestion.startDate ||
      input.period.endDate > input.ingestion.endDate
    ) {
      throw new Error("The ingestion window must fully cover the requested report period");
    }
    const ingestion = await this.ingestion.run(input.ingestion);
    const organicIngestions: OrganicIngestionResult[] = [];
    for (const request of input.organicIngestions ?? []) {
      if (!this.organicIngestion) throw new Error("Organic ingestion service is not configured");
      organicIngestions.push(await this.organicIngestion.run(request));
    }
    const contentIngestions: OrganicContentIngestionResult[] = [];
    for (const request of input.contentIngestions ?? []) {
      if (!this.contentIngestion) throw new Error("Organic content ingestion service is not configured");
      contentIngestions.push(await this.contentIngestion.run(request));
    }
    const report = await this.reporting.createUnifiedReport(input.ingestion.scope, {
      period: input.period,
      paidGranularity: input.ingestion.level,
      sourceAccountIds: input.reportSourceAccountIds,
    });
    const excel = this.excel.generate(report, input.excel);
    return { ingestion, organicIngestions, contentIngestions, report, excel };
  }
}

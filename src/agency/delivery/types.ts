import type { AgencyExcelReport } from "../excel/index.js";
import type { ReportPeriod } from "../reporting/index.js";
import type { ReportingScope } from "../historical-data/index.js";

export interface StoreReportArtifactInput {
  readonly jobId: string;
  readonly period: ReportPeriod;
  readonly report: AgencyExcelReport;
  readonly createdAt: string;
  readonly retentionDays: number;
}

export interface StoredReportArtifact extends ReportingScope {
  readonly artifactId: string;
  readonly jobId: string;
  readonly period: ReportPeriod;
  readonly filename: string;
  readonly contentType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ReportArtifactStore {
  store(
    scope: ReportingScope,
    input: StoreReportArtifactInput,
  ): Promise<StoredReportArtifact>;
  getMetadata(
    scope: ReportingScope,
    artifactId: string,
  ): Promise<StoredReportArtifact | null>;
}

export interface ReportObjectStore {
  putObject(input: {
    readonly objectKey: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
  }): Promise<void>;
}

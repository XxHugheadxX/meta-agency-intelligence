import { randomUUID } from "node:crypto";
import {
  assertIsoDate,
  assertReportingScope,
  type HistoricalDataRepository,
} from "../historical-data/index.js";
import { normalizeOrganicInsights } from "./organic-normalizer.js";
import type {
  OrganicAssetPolicy,
  OrganicIngestionRequest,
  OrganicIngestionResult,
  OrganicInsightRecord,
  OrganicInsightsPageReader,
} from "./organic-types.js";

const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_RECORDS = 100;

function integerWithin(value: number | undefined, fallback: number, min: number, max: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return resolved;
}

function validateRequest(request: OrganicIngestionRequest): void {
  assertReportingScope(request.scope);
  assertIsoDate(request.startDate, "startDate");
  assertIsoDate(request.endDate, "endDate");
  if (request.startDate > request.endDate) throw new Error("startDate must be on or before endDate");
  if (!/^\d{1,32}$/.test(request.asset.assetId)) {
    throw new Error("Organic ingestion requires a numeric Meta assetId");
  }
  if (!request.asset.assetName.trim() || !request.asset.currency.trim() || !request.asset.timezone.trim()) {
    throw new Error("Organic asset name, currency, and timezone are required");
  }
  if (!/^v\d+\.\d+$/.test(request.apiVersion)) {
    throw new Error("apiVersion must use the Meta v<major>.<minor> format");
  }
}

export class AgencyOrganicIngestionService {
  constructor(
    private readonly reader: OrganicInsightsPageReader,
    private readonly historicalData: HistoricalDataRepository,
    private readonly assetPolicy: OrganicAssetPolicy,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(request: OrganicIngestionRequest): Promise<OrganicIngestionResult> {
    validateRequest(request);
    await this.assetPolicy.assertAssetAllowed(
      request.scope,
      request.asset.platform,
      request.asset.assetId,
    );

    const maxPages = integerWithin(request.maxPages, DEFAULT_MAX_PAGES, 1, 100, "maxPages");
    const maxRecords = integerWithin(request.maxRecords, DEFAULT_MAX_RECORDS, 1, 1_000, "maxRecords");
    const extractedAt = this.now();
    if (Number.isNaN(Date.parse(extractedAt))) throw new Error("Ingestion clock must return an ISO timestamp");
    const runId = request.runId ?? randomUUID();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(runId)) throw new Error("runId contains unsupported characters");

    let after: string | undefined;
    let pagesRead = 0;
    const records: OrganicInsightRecord[] = [];
    const seenCursors = new Set<string>();
    while (true) {
      if (pagesRead >= maxPages) throw new Error("Meta organic pagination exceeded maxPages");
      const page = await this.reader.readPage({
        asset: request.asset,
        startDate: request.startDate,
        endDate: request.endDate,
        after,
      });
      pagesRead += 1;
      if (!Array.isArray(page.data)) throw new Error("Meta organic response data must be an array");
      if (records.length + page.data.length > maxRecords) {
        throw new Error("Meta organic ingestion exceeded maxRecords");
      }
      records.push(...page.data);

      const nextCursor = page.paging?.cursors?.after;
      const hasNext = Boolean(page.paging?.next || nextCursor);
      if (!hasNext) break;
      if (!nextCursor) throw new Error("Meta organic pagination advertised a next page without an after cursor");
      if (seenCursors.has(nextCursor)) throw new Error("Meta organic pagination repeated an after cursor");
      seenCursors.add(nextCursor);
      after = nextCursor;
    }

    const inputs = normalizeOrganicInsights(records, {
      asset: request.asset,
      startDate: request.startDate,
      endDate: request.endDate,
      apiVersion: request.apiVersion,
      extractedAt,
      runId,
    });
    await this.historicalData.upsertMany(request.scope, inputs);
    return {
      scope: { ...request.scope },
      platform: request.asset.platform,
      assetId: request.asset.assetId,
      startDate: request.startDate,
      endDate: request.endDate,
      pagesRead,
      rowsWritten: inputs.length,
      runId,
    };
  }
}

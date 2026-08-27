import { randomUUID } from "node:crypto";
import {
  assertIsoDate,
  assertReportingScope,
  type HistoricalDataRepository,
} from "../historical-data/index.js";
import { normalizeMetaInsight } from "./normalizer.js";
import type {
  IngestionCheckpointKey,
  IngestionCheckpointRepository,
  IngestionAssetPolicy,
  InsightsIngestionRequest,
  InsightsIngestionResult,
  InsightsPageReader,
} from "./types.js";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_ROWS = 10_000;

function integerWithin(value: number | undefined, fallback: number, min: number, max: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return resolved;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function checkpointKey(request: InsightsIngestionRequest, breakdowns: readonly string[]): IngestionCheckpointKey {
  return {
    accountId: request.account.accountId,
    level: request.level,
    attributionWindow: request.attributionWindow ?? null,
    breakdowns,
    apiVersion: request.apiVersion,
  };
}

function validateRequest(request: InsightsIngestionRequest): void {
  assertReportingScope(request.scope);
  assertIsoDate(request.startDate, "startDate");
  assertIsoDate(request.endDate, "endDate");
  if (request.startDate > request.endDate) {
    throw new Error("startDate must be on or before endDate");
  }
  if (!/^act_\d+$/.test(request.account.accountId)) {
    throw new Error("Meta ingestion requires an act_<digits> accountId");
  }
  if (!request.account.accountName.trim() || !request.account.currency.trim() || !request.account.timezone.trim()) {
    throw new Error("Ingestion account name, currency, and timezone are required");
  }
  if (!/^v\d+\.\d+$/.test(request.apiVersion)) {
    throw new Error("apiVersion must use the Meta v<major>.<minor> format");
  }
}

export class AgencyInsightsIngestionService {
  constructor(
    private readonly reader: InsightsPageReader,
    private readonly historicalData: HistoricalDataRepository,
    private readonly checkpoints: IngestionCheckpointRepository,
    private readonly assetPolicy: IngestionAssetPolicy,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(request: InsightsIngestionRequest): Promise<InsightsIngestionResult> {
    validateRequest(request);
    await this.assetPolicy.assertAccountAllowed(request.scope, request.account.accountId);

    const breakdowns = [...new Set(request.breakdowns ?? [])].sort();
    const mode = request.mode ?? "backfill";
    const pageSize = integerWithin(request.pageSize, DEFAULT_PAGE_SIZE, 1, 500, "pageSize");
    const maxPages = integerWithin(request.maxPages, DEFAULT_MAX_PAGES, 1, 1_000, "maxPages");
    const maxRows = integerWithin(request.maxRows, DEFAULT_MAX_ROWS, 1, 100_000, "maxRows");
    const lookbackDays = integerWithin(request.lookbackDays, 2, 1, 30, "lookbackDays");
    const key = checkpointKey(request, breakdowns);
    const prior = await this.checkpoints.get(request.scope, key);
    const incrementalStart = prior ? addDays(prior.watermarkDate, -(lookbackDays - 1)) : request.startDate;
    const effectiveStartDate = mode === "incremental"
      ? incrementalStart < request.startDate ? request.startDate : incrementalStart
      : request.startDate;
    const extractedAt = this.now();
    if (Number.isNaN(Date.parse(extractedAt))) throw new Error("Ingestion clock must return an ISO timestamp");
    const runId = request.runId ?? randomUUID();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(runId)) throw new Error("runId contains unsupported characters");

    if (effectiveStartDate > request.endDate) {
      return {
        scope: { ...request.scope },
        accountId: request.account.accountId,
        requestedStartDate: request.startDate,
        effectiveStartDate,
        endDate: request.endDate,
        mode,
        rowsWritten: 0,
        pagesRead: 0,
        watermarkDate: prior?.watermarkDate ?? request.endDate,
        runId,
      };
    }

    let after: string | undefined;
    let pagesRead = 0;
    let rowsWritten = 0;
    const seenCursors = new Set<string>();

    while (true) {
      if (pagesRead >= maxPages) throw new Error("Meta insights pagination exceeded maxPages");
      const pageNumber = pagesRead + 1;
      const page = await this.reader.readPage({
        account: request.account,
        startDate: effectiveStartDate,
        endDate: request.endDate,
        level: request.level,
        attributionWindow: request.attributionWindow ?? null,
        breakdowns,
        pageSize,
        after,
      });
      pagesRead = pageNumber;
      if (!Array.isArray(page.data)) throw new Error("Meta insights response data must be an array");
      if (rowsWritten + page.data.length > maxRows) {
        throw new Error("Meta insights ingestion exceeded maxRows");
      }
      const inputs = page.data.map((record) => {
        if (record.date_start < effectiveStartDate || record.date_start > request.endDate) {
          throw new Error("Meta insight date_start falls outside the requested ingestion window");
        }
        return normalizeMetaInsight(record, {
          account: request.account,
          level: request.level,
          attributionWindow: request.attributionWindow ?? null,
          breakdowns,
          apiVersion: request.apiVersion,
          extractedAt,
          runId,
          pageNumber,
        });
      });
      await this.historicalData.upsertMany(request.scope, inputs);
      rowsWritten += inputs.length;

      const nextCursor = page.paging?.cursors?.after;
      const hasNext = Boolean(page.paging?.next || nextCursor);
      if (!hasNext) break;
      if (!nextCursor) throw new Error("Meta insights pagination advertised a next page without an after cursor");
      if (seenCursors.has(nextCursor)) throw new Error("Meta insights pagination repeated an after cursor");
      seenCursors.add(nextCursor);
      after = nextCursor;
    }

    await this.checkpoints.save(request.scope, {
      ...request.scope,
      ...key,
      watermarkDate:
        prior && prior.watermarkDate > request.endDate ? prior.watermarkDate : request.endDate,
      completedAt: extractedAt,
      rowsWritten,
    });

    return {
      scope: { ...request.scope },
      accountId: request.account.accountId,
      requestedStartDate: request.startDate,
      effectiveStartDate,
      endDate: request.endDate,
      mode,
      rowsWritten,
      pagesRead,
      watermarkDate:
        prior && prior.watermarkDate > request.endDate ? prior.watermarkDate : request.endDate,
      runId,
    };
  }
}

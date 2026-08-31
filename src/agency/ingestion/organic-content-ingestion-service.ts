import { randomUUID } from "node:crypto";
import {
  assertIsoDate,
  assertReportingScope,
  type HistoricalDataRepository,
} from "../historical-data/index.js";
import {
  normalizeFacebookPost,
  normalizeFacebookPostInsights,
  normalizeInstagramContent,
  normalizeInstagramContentInsights,
} from "./organic-content-normalizer.js";
import type {
  OrganicContentIngestionRequest,
  OrganicContentIngestionResult,
  OrganicContentItem,
  OrganicContentReader,
} from "./organic-content-types.js";
import type { OrganicAssetPolicy } from "./organic-types.js";

const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_CONTENT = 100;

function integerWithin(value: number | undefined, fallback: number, min: number, max: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return resolved;
}

function validateRequest(request: OrganicContentIngestionRequest): void {
  assertReportingScope(request.scope);
  assertIsoDate(request.startDate, "startDate");
  assertIsoDate(request.endDate, "endDate");
  if (request.startDate > request.endDate) throw new Error("startDate must be on or before endDate");
  if (!/^\d{1,32}$/.test(request.asset.assetId)) {
    throw new Error("Organic content ingestion requires a numeric assetId");
  }
  if (!request.asset.assetName.trim() || !request.asset.currency.trim() || !request.asset.timezone.trim()) {
    throw new Error("Organic asset name, currency, and timezone are required");
  }
  if (!/^v\d+\.\d+$/.test(request.apiVersion)) {
    throw new Error("apiVersion must use the Meta v<major>.<minor> format");
  }
}

export class AgencyOrganicContentIngestionService {
  constructor(
    private readonly reader: OrganicContentReader,
    private readonly historicalData: HistoricalDataRepository,
    private readonly assetPolicy: OrganicAssetPolicy,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(request: OrganicContentIngestionRequest): Promise<OrganicContentIngestionResult> {
    validateRequest(request);
    await this.assetPolicy.assertAssetAllowed(request.scope, request.asset.platform, request.asset.assetId);

    const maxPages = integerWithin(request.maxPages, DEFAULT_MAX_PAGES, 1, 100, "maxPages");
    const maxContent = integerWithin(request.maxContent, DEFAULT_MAX_CONTENT, 1, 500, "maxContent");
    const extractedAt = this.now();
    if (Number.isNaN(Date.parse(extractedAt))) throw new Error("Ingestion clock must return an ISO timestamp");
    const runId = request.runId ?? randomUUID();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(runId)) throw new Error("runId contains unsupported characters");

    let after: string | undefined;
    let pagesRead = 0;
    const contents: OrganicContentItem[] = [];
    const seenContent = new Set<string>();
    const seenCursors = new Set<string>();
    while (true) {
      if (pagesRead >= maxPages) throw new Error("Organic content pagination exceeded maxPages");
      const page = await this.reader.readContentPage({
        asset: request.asset,
        startDate: request.startDate,
        endDate: request.endDate,
        after,
      });
      pagesRead += 1;
      if (!Array.isArray(page.data)) throw new Error("Organic content response data must be an array");
      if (contents.length + page.data.length > maxContent) {
        throw new Error("Organic content ingestion exceeded maxContent");
      }
      for (const record of page.data) {
        const content = request.asset.platform === "instagram"
          ? normalizeInstagramContent(record)
          : normalizeFacebookPost(record);
        const publishedDate = content.publishedAt.slice(0, 10);
        if (publishedDate < request.startDate || publishedDate > request.endDate) {
          throw new Error("Organic content timestamp falls outside the requested ingestion window");
        }
        if (seenContent.has(content.contentId)) {
          throw new Error("Organic content pagination repeated a contentId");
        }
        seenContent.add(content.contentId);
        contents.push(content);
      }

      const nextCursor = page.paging?.cursors?.after;
      const hasNext = Boolean(page.paging?.next || nextCursor);
      if (!hasNext) break;
      if (!nextCursor) throw new Error("Organic content pagination advertised a next page without an after cursor");
      if (seenCursors.has(nextCursor)) throw new Error("Organic content pagination repeated an after cursor");
      seenCursors.add(nextCursor);
      after = nextCursor;
    }

    const inputs = [];
    for (const content of contents) {
      const response = await this.reader.readInsights({ asset: request.asset, content });
      if (!Array.isArray(response.data)) {
        throw new Error("Organic content insights data must be an array");
      }
      if (response.paging?.next || response.paging?.cursors?.after) {
        throw new Error("Organic content insights unexpectedly returned pagination");
      }
      if (response.data.length > 20) {
        throw new Error("Organic content insights exceeded its metric limit");
      }
      const context = {
        asset: request.asset,
        apiVersion: request.apiVersion,
        extractedAt,
        runId,
      };
      inputs.push(request.asset.platform === "instagram"
        ? normalizeInstagramContentInsights(content, response.data, context)
        : normalizeFacebookPostInsights(content, response.data, context));
    }

    await this.historicalData.upsertMany(request.scope, inputs);
    return {
      scope: { ...request.scope },
      platform: request.asset.platform,
      assetId: request.asset.assetId,
      startDate: request.startDate,
      endDate: request.endDate,
      pagesRead,
      contentsRead: contents.length,
      rowsWritten: inputs.length,
      runId,
    };
  }
}

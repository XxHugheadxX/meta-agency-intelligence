import type { RequestHandler } from "express";
import { reportingScopeFromRequest } from "../delivery/http-download.js";
import type { ReportArtifactStore } from "../delivery/index.js";
import type { ReportingBatchRepository } from "./reporting-batch-coordinator.js";

interface AuthenticatedRequest {
  readonly auth?: { readonly extra?: Record<string, unknown> };
}

export function createReportingBatchListHandler(
  batches: Pick<ReportingBatchRepository, "listRecent">,
): RequestHandler {
  return async (request, response) => {
    response.setHeader("Cache-Control", "private, no-store, max-age=0");
    const scope = reportingScopeFromRequest(request as AuthenticatedRequest);
    if (!scope) {
      response.status(401).json({ error: "Authenticated tenant context is required" });
      return;
    }
    const rawLimit = request.query.limit;
    const limit = rawLimit === undefined ? 20 :
      typeof rawLimit === "string" && /^(?:[1-9]|[1-4][0-9]|50)$/.test(rawLimit)
        ? Number(rawLimit)
        : null;
    if (limit === null) {
      response.status(400).json({ error: "Invalid reporting batch list limit" });
      return;
    }
    try {
      const reports = (await batches.listRecent(scope, limit)).map((batch) => ({
        batchId: batch.batchId,
        status: batch.status,
        period: { kind: batch.reportKind, startDate: batch.startDate, endDate: batch.endDate },
        progress: { completedAccounts: batch.completedAccounts, expectedAccounts: batch.expectedAccounts },
        detailPath: `/agency/reporting/batches/${batch.batchId}`,
      }));
      response.status(200).json({ reports });
    } catch {
      response.status(503).json({ error: "Reporting batch list is temporarily unavailable" });
    }
  };
}

export function createReportingBatchStatusHandler(
  batches: Pick<ReportingBatchRepository, "get">,
  artifacts: Pick<ReportArtifactStore, "getMetadata">,
): RequestHandler {
  return async (request, response) => {
    response.setHeader("Cache-Control", "private, no-store, max-age=0");
    const scope = reportingScopeFromRequest(request as AuthenticatedRequest);
    if (!scope) {
      response.status(401).json({ error: "Authenticated tenant context is required" });
      return;
    }
    const batchId = request.params.batchId;
    if (typeof batchId !== "string" || !/^batch-[a-f0-9]{40}$/.test(batchId)) {
      response.status(404).json({ error: "Reporting batch not found" });
      return;
    }
    try {
      const batch = await batches.get(scope, batchId);
      if (!batch) {
        response.status(404).json({ error: "Reporting batch not found" });
        return;
      }
      const artifact = batch.artifactId
        ? await artifacts.getMetadata(scope, batch.artifactId)
        : null;
      if (batch.status === "complete" && (
        !artifact ||
        artifact.tenantId !== scope.tenantId ||
        artifact.workspaceId !== scope.workspaceId ||
        artifact.artifactId !== batch.artifactId ||
        artifact.jobId !== batchId ||
        artifact.period.kind !== batch.reportKind ||
        artifact.period.startDate !== batch.startDate ||
        artifact.period.endDate !== batch.endDate
      )) {
        response.status(503).json({ error: "Consolidated report is temporarily unavailable" });
        return;
      }
      response.status(200).json({
        batchId: batch.batchId,
        status: batch.status,
        period: { kind: batch.reportKind, startDate: batch.startDate, endDate: batch.endDate },
        progress: { completedAccounts: batch.completedAccounts, expectedAccounts: batch.expectedAccounts },
        artifact: artifact ? {
          artifactId: artifact.artifactId,
          filename: artifact.filename,
          byteLength: artifact.byteLength,
          createdAt: artifact.createdAt,
          expiresAt: artifact.expiresAt,
          downloadPath: `/agency/reports/${artifact.artifactId}`,
        } : null,
      });
    } catch {
      response.status(503).json({ error: "Reporting batch status is temporarily unavailable" });
    }
  };
}

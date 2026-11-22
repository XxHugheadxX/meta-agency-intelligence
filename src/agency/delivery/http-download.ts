import type { RequestHandler, Response } from "express";
import { assertReportingScope, type ReportingScope } from "../historical-data/index.js";
import type { ReportArtifactStore } from "./types.js";

interface AuthenticatedRequest {
  readonly auth?: { readonly extra?: Record<string, unknown> };
}

export function reportingScopeFromRequest(request: AuthenticatedRequest): ReportingScope | null {
  const tenantId = request.auth?.extra?.tenantId;
  const workspaceId = request.auth?.extra?.workspaceId;
  if (typeof tenantId !== "string" || typeof workspaceId !== "string") return null;
  const scope = { tenantId, workspaceId };
  try {
    assertReportingScope(scope);
    return scope;
  } catch {
    return null;
  }
}

function sendDownload(response: Response, filename: string, bytes: Uint8Array): void {
  if (!/^[a-zA-Z0-9._-]+\.xlsx$/.test(filename)) {
    throw new Error("Stored report filename is invalid");
  }
  response.status(200);
  response.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  response.setHeader("Content-Length", String(bytes.length));
  response.setHeader("Cache-Control", "private, no-store, max-age=0");
  response.setHeader("Pragma", "no-cache");
  response.send(Buffer.from(bytes));
}

export function createReportDownloadHandler(
  artifacts: ReportArtifactStore,
): RequestHandler {
  return async (request, response) => {
    const scope = reportingScopeFromRequest(request as AuthenticatedRequest);
    if (!scope) {
      response.status(401).json({ error: "Authenticated tenant context is required" });
      return;
    }
    const artifactId = request.params.artifactId;
    if (typeof artifactId !== "string") {
      response.status(404).json({ error: "Report not found" });
      return;
    }
    if (!/^[a-f0-9]{64}$/.test(artifactId)) {
      response.status(404).json({ error: "Report not found" });
      return;
    }
    try {
      const artifact = await artifacts.read(scope, artifactId);
      if (!artifact) {
        response.status(404).json({ error: "Report not found" });
        return;
      }
      if (
        artifact.metadata.tenantId !== scope.tenantId ||
        artifact.metadata.workspaceId !== scope.workspaceId ||
        artifact.metadata.artifactId !== artifactId ||
        artifact.bytes.length !== artifact.metadata.byteLength ||
        artifact.bytes.length > 25 * 1024 * 1024
      ) {
        response.status(404).json({ error: "Report not found" });
        return;
      }
      sendDownload(response, artifact.metadata.filename, artifact.bytes);
    } catch {
      response.status(503).json({ error: "Report delivery is temporarily unavailable" });
    }
  };
}

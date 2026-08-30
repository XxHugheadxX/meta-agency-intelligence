import express, {
  type ErrorRequestHandler,
  type RequestHandler,
  type Router,
} from "express";
import type { AgencyReportingWorker } from "./reporting-worker.js";
import type { IngestionJobEnvelope, WorkloadIdentityVerifier } from "./types.js";
import { assertSchedulerIdentity } from "./worker.js";

const MAX_AUTHORIZATION_BYTES = 16 * 1024;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_SIGNATURE_BYTES = 1024;
const MAX_BODY_BYTES = 20 * 1024;

export type ReportingJobWorker = Pick<AgencyReportingWorker, "run">;

export interface ReportingJobEndpointDependencies {
  readonly worker: ReportingJobWorker;
  readonly identities: WorkloadIdentityVerifier;
}

function setNoStore(response: { setHeader(name: string, value: string): unknown }): void {
  response.setHeader("Cache-Control", "no-store");
}

function authorizationFromRequest(request: { headers: { authorization?: string | string[] } }): string | null {
  const authorization = request.headers.authorization;
  if (
    typeof authorization !== "string" ||
    Buffer.byteLength(authorization, "utf8") > MAX_AUTHORIZATION_BYTES ||
    !/^Bearer \S+$/.test(authorization)
  ) {
    return null;
  }
  return authorization;
}

function envelopeFromBody(value: unknown, authorization: string): IngestionJobEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const fields = Object.keys(body);
  if (
    fields.length !== 2 ||
    !fields.includes("payload") ||
    !fields.includes("signature") ||
    typeof body.payload !== "string" ||
    typeof body.signature !== "string" ||
    Buffer.byteLength(body.payload, "utf8") === 0 ||
    Buffer.byteLength(body.payload, "utf8") > MAX_PAYLOAD_BYTES ||
    Buffer.byteLength(body.signature, "utf8") === 0 ||
    Buffer.byteLength(body.signature, "utf8") > MAX_SIGNATURE_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(body.signature)
  ) {
    return null;
  }
  return { authorization, payload: body.payload, signature: body.signature };
}

function unauthorized(response: { status(code: number): { json(body: unknown): unknown }; setHeader(name: string, value: string): unknown }): void {
  setNoStore(response);
  response.status(401).json({ error: "Unauthorized reporting job request" });
}

function invalidRequest(response: { status(code: number): { json(body: unknown): unknown }; setHeader(name: string, value: string): unknown }): void {
  setNoStore(response);
  response.status(400).json({ error: "Invalid reporting job request" });
}

function authenticateReportingJobRequest(
  identities: WorkloadIdentityVerifier,
): RequestHandler {
  return async (request, response, next) => {
    const authorization = authorizationFromRequest(request);
    if (!authorization) {
      unauthorized(response);
      return;
    }
    try {
      assertSchedulerIdentity(await identities.verify(authorization));
      next();
    } catch {
      unauthorized(response);
    }
  };
}

function executeReportingJob(worker: ReportingJobWorker): RequestHandler {
  return async (request, response) => {
    const authorization = authorizationFromRequest(request);
    const envelope = authorization ? envelopeFromBody(request.body, authorization) : null;
    if (!envelope) {
      invalidRequest(response);
      return;
    }
    try {
      const result = await worker.run(envelope);
      setNoStore(response);
      response.status(200).json({
        status: "completed",
        jobId: result.jobId,
        artifactId: result.artifact.artifactId,
      });
    } catch {
      invalidRequest(response);
    }
  };
}

const malformedBody: ErrorRequestHandler = (_error, _request, response, _next) => {
  invalidRequest(response);
};

export function createReportingJobHttpRouter(
  worker: ReportingJobWorker,
  identities: WorkloadIdentityVerifier,
): Router {
  const router = express.Router();
  router.post(
    "/",
    authenticateReportingJobRequest(identities),
    express.json({ limit: MAX_BODY_BYTES, strict: true }),
    executeReportingJob(worker),
    malformedBody,
  );
  return router;
}

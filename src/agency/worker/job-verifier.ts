import { createPublicKey, KeyObject, verify } from "node:crypto";
import type { IngestionJobPayload, IngestionJobVerifier } from "./types.js";

const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_SIGNATURE_BYTES = 1024;
const ALLOWED_FIELDS = new Set([
  "tenantId",
  "workspaceId",
  "jobId",
  "accountId",
  "startDate",
  "endDate",
  "level",
  "apiVersion",
  "attributionWindow",
  "breakdowns",
  "mode",
  "lookbackDays",
]);

function parsePayload(payload: string): IngestionJobPayload {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new Error("Signed ingestion payload is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Signed ingestion payload must be an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((field) => !ALLOWED_FIELDS.has(field))) {
    throw new Error("Signed ingestion payload contains unsupported fields");
  }
  const requiredStrings = [
    "tenantId",
    "workspaceId",
    "jobId",
    "accountId",
    "startDate",
    "endDate",
    "level",
    "apiVersion",
  ] as const;
  if (requiredStrings.some((field) => typeof record[field] !== "string")) {
    throw new Error("Signed ingestion payload is missing required fields");
  }
  if (
    record.breakdowns !== undefined &&
    (!Array.isArray(record.breakdowns) ||
      record.breakdowns.some((item) => typeof item !== "string"))
  ) {
    throw new Error("Signed ingestion breakdowns must be an array of strings");
  }
  return structuredClone(record) as unknown as IngestionJobPayload;
}

export class PublicKeyIngestionJobVerifier implements IngestionJobVerifier {
  private readonly publicKey: KeyObject;

  constructor(publicKey: string | Buffer | KeyObject) {
    this.publicKey = publicKey instanceof KeyObject ? publicKey : createPublicKey(publicKey);
    if (this.publicKey.type !== "public") {
      throw new Error("Ingestion job verifier requires a public key");
    }
  }

  async verify(payload: string, signature: string): Promise<IngestionJobPayload> {
    const payloadBytes = Buffer.byteLength(payload, "utf8");
    if (payloadBytes === 0 || payloadBytes > MAX_PAYLOAD_BYTES) {
      throw new Error("Signed ingestion payload exceeds its size limit");
    }
    if (!/^[A-Za-z0-9_-]+$/.test(signature)) {
      throw new Error("Ingestion job signature is not base64url");
    }
    const signatureBytes = Buffer.from(signature, "base64url");
    if (signatureBytes.length === 0 || signatureBytes.length > MAX_SIGNATURE_BYTES) {
      throw new Error("Ingestion job signature exceeds its size limit");
    }
    if (!verify("sha256", Buffer.from(payload, "utf8"), this.publicKey, signatureBytes)) {
      throw new Error("Ingestion job signature is invalid");
    }
    return parsePayload(payload);
  }
}

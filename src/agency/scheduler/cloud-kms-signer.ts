import { createHash } from "node:crypto";
import {
  MetadataServerAccessTokenProvider,
  type GoogleAccessTokenProvider,
} from "../delivery/index.js";
import type { ReportingPayloadSigner } from "./reporting-fan-out.js";

const KMS_ORIGIN = "https://cloudkms.googleapis.com";
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_SIGNATURE_BYTES = 1024;
const CRC32C_POLYNOMIAL = 0x82f63b78;

function validateKeyVersionName(value: string): void {
  if (!/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z0-9-]{1,63}\/keyRings\/[A-Za-z0-9_-]{1,63}\/cryptoKeys\/[A-Za-z0-9_-]{1,63}\/cryptoKeyVersions\/[1-9][0-9]{0,18}$/.test(value)) {
    throw new Error("Invalid Cloud KMS signing key version name");
  }
}

function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (-(crc & 1) & CRC32C_POLYNOMIAL);
    }
  }
  return (~crc) >>> 0;
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) throw new Error("Cloud KMS response exceeds its size limit");
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.length;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Cloud KMS response exceeds its size limit");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("Cloud KMS returned an invalid response");
  }
}

function decodeCanonicalSignature(value: unknown): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil(MAX_SIGNATURE_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error("Cloud KMS returned an invalid signature");
  }
  const signature = Buffer.from(value, "base64");
  if (
    signature.length === 0 ||
    signature.length > MAX_SIGNATURE_BYTES ||
    signature.toString("base64") !== value
  ) {
    throw new Error("Cloud KMS returned an invalid signature");
  }
  return signature;
}

function parseSignResponse(value: unknown, keyVersionName: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cloud KMS returned an invalid signing response");
  }
  const record = value as Record<string, unknown>;
  const signature = decodeCanonicalSignature(record.signature);
  if (record.name !== keyVersionName) {
    throw new Error("Cloud KMS signing response failed resource verification");
  }
  if (
    record.verifiedDigestCrc32c !== true ||
    typeof record.signatureCrc32c !== "string" ||
    !/^[0-9]{1,10}$/.test(record.signatureCrc32c) ||
    Number(record.signatureCrc32c) !== crc32c(signature)
  ) {
    throw new Error("Cloud KMS signing response failed integrity verification");
  }
  return Buffer.from(signature).toString("base64url");
}

export class CloudKmsReportingPayloadSigner implements ReportingPayloadSigner {
  private readonly endpoint: URL;

  constructor(
    private readonly keyVersionName: string,
    private readonly tokens: GoogleAccessTokenProvider =
      new MetadataServerAccessTokenProvider(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    validateKeyVersionName(keyVersionName);
    this.endpoint = new URL(`/v1/${keyVersionName}:asymmetricSign`, KMS_ORIGIN);
  }

  async sign(payload: string): Promise<string> {
    const payloadBytes = Buffer.from(payload, "utf8");
    if (payloadBytes.length === 0 || payloadBytes.length > MAX_PAYLOAD_BYTES) {
      throw new Error("Reporting payload exceeds its signing size limit");
    }
    const digest = createHash("sha256").update(payloadBytes).digest();
    const body = JSON.stringify({
      digest: { sha256: digest.toString("base64") },
      digestCrc32c: String(crc32c(digest)),
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.tokens.getAccessToken(attempt > 0);
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new Error("Cloud KMS signing service is unavailable");
      }
      if (response.status === 401 && attempt === 0) continue;
      if (!response.ok) throw new Error("Cloud KMS rejected the signing request");
      return parseSignResponse(await readLimitedJson(response), this.keyVersionName);
    }
    throw new Error("Cloud KMS signing authentication failed");
  }
}

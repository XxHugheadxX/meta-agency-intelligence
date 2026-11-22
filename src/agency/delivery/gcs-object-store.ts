import { createHash } from "node:crypto";
import type { ReportObjectStore } from "./types.js";

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const STORAGE_ORIGIN = "https://storage.googleapis.com";
const MAX_OBJECT_BYTES = 25 * 1024 * 1024;

export interface GoogleAccessTokenProvider {
  getAccessToken(forceRefresh?: boolean): Promise<string>;
}

interface CachedAccessToken {
  readonly value: string;
  readonly expiresAt: number;
}

function readTokenResponse(value: unknown): { accessToken: string; expiresIn: number } {
  if (!value || typeof value !== "object") {
    throw new Error("Workload access token response is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.access_token !== "string" ||
    !record.access_token.trim() ||
    typeof record.expires_in !== "number" ||
    !Number.isFinite(record.expires_in) ||
    record.expires_in <= 0
  ) {
    throw new Error("Workload access token response is incomplete");
  }
  return { accessToken: record.access_token, expiresIn: record.expires_in };
}

export class MetadataServerAccessTokenProvider implements GoogleAccessTokenProvider {
  private cached?: CachedAccessToken;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cached && this.cached.expiresAt > this.now() + 60_000) {
      return this.cached.value;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(METADATA_TOKEN_URL, {
        method: "GET",
        headers: { "Metadata-Flavor": "Google" },
        redirect: "error",
        signal: AbortSignal.timeout(3_000),
      });
    } catch {
      throw new Error("Workload identity metadata service is unavailable");
    }
    if (!response.ok) {
      throw new Error("Workload identity metadata service rejected the request");
    }
    const token = readTokenResponse(await response.json().catch(() => null));
    this.cached = {
      value: token.accessToken,
      expiresAt: this.now() + token.expiresIn * 1_000,
    };
    return token.accessToken;
  }
}

function validateBucketName(bucket: string): void {
  if (
    bucket.length < 3 ||
    bucket.length > 63 ||
    !/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(bucket) ||
    /\.\.|^goog/i.test(bucket) ||
    /^\d+\.\d+\.\d+\.\d+$/.test(bucket)
  ) {
    throw new Error("Invalid private report bucket name");
  }
}

function validateObjectKey(objectKey: string): void {
  if (!/^agency-reports\/[a-f0-9]{64}\/[a-f0-9]{64}\.xlsx$/.test(objectKey)) {
    throw new Error("Invalid report object key");
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > maxBytes) throw new Error("Stored report object exceeds its size limit");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.length;
    if (length > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Stored report object exceeds its size limit");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

interface ExistingObjectMetadata {
  readonly size?: string;
  readonly contentType?: string;
  readonly metadata?: { readonly sha256?: string };
}

export class GcsReportObjectStore implements ReportObjectStore {
  constructor(
    private readonly bucket: string,
    private readonly tokens: GoogleAccessTokenProvider =
      new MetadataServerAccessTokenProvider(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    validateBucketName(bucket);
  }

  private async request(url: URL, init: RequestInit): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.tokens.getAccessToken(attempt > 0);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init.headers).entries()),
            Authorization: `Bearer ${token}`,
          },
          redirect: "error",
          signal: init.signal ?? AbortSignal.timeout(30_000),
        });
      } catch {
        throw new Error("Private report storage is unavailable");
      }
      if (response.status !== 401 || attempt > 0) return response;
    }
    throw new Error("Private report storage authentication failed");
  }

  private objectUrl(objectKey: string, media = false): URL {
    const url = new URL(
      `/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(objectKey)}`,
      STORAGE_ORIGIN,
    );
    if (media) url.searchParams.set("alt", "media");
    return url;
  }

  private async existingObjectMatches(
    objectKey: string,
    expected: { readonly bytes: Uint8Array; readonly contentType: string; readonly sha256: string },
  ): Promise<boolean> {
    const response = await this.request(this.objectUrl(objectKey), { method: "GET" });
    if (!response.ok) return false;
    const metadata = await response.json().catch(() => null) as ExistingObjectMetadata | null;
    return Boolean(
      metadata &&
      metadata.size === String(expected.bytes.length) &&
      metadata.contentType === expected.contentType &&
      metadata.metadata?.sha256 === expected.sha256,
    );
  }

  async putObject(input: {
    readonly objectKey: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
    readonly sha256: string;
  }): Promise<void> {
    validateObjectKey(input.objectKey);
    if (
      input.bytes.length === 0 ||
      input.bytes.length > MAX_OBJECT_BYTES ||
      !/^[a-f0-9]{64}$/.test(input.sha256) ||
      sha256(input.bytes) !== input.sha256
    ) {
      throw new Error("Invalid report object integrity metadata");
    }
    const initiateUrl = new URL(
      `/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o`,
      STORAGE_ORIGIN,
    );
    initiateUrl.searchParams.set("uploadType", "resumable");
    initiateUrl.searchParams.set("ifGenerationMatch", "0");
    const initiation = await this.request(initiateUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Upload-Content-Type": input.contentType,
        "X-Upload-Content-Length": String(input.bytes.length),
      },
      body: JSON.stringify({
        name: input.objectKey,
        contentType: input.contentType,
        metadata: { sha256: input.sha256 },
      }),
    });
    if (initiation.status === 412) {
      if (await this.existingObjectMatches(input.objectKey, input)) return;
      throw new Error("Private report object already exists with different content");
    }
    if (!initiation.ok) {
      throw new Error("Private report storage rejected object creation");
    }
    const location = initiation.headers.get("location");
    let uploadUrl: URL;
    try {
      uploadUrl = new URL(location ?? "");
    } catch {
      throw new Error("Private report storage returned an invalid upload location");
    }
    if (
      uploadUrl.origin !== STORAGE_ORIGIN ||
      uploadUrl.username ||
      uploadUrl.password
    ) {
      throw new Error("Private report storage returned an unsafe upload location");
    }
    const upload = await this.request(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": input.contentType,
        "Content-Length": String(input.bytes.length),
      },
      body: input.bytes.slice().buffer as ArrayBuffer,
    });
    if (!upload.ok) throw new Error("Private report storage rejected object upload");
  }

  async getObject(input: {
    readonly objectKey: string;
    readonly maxBytes: number;
  }): Promise<Uint8Array | null> {
    validateObjectKey(input.objectKey);
    if (
      !Number.isInteger(input.maxBytes) ||
      input.maxBytes < 1 ||
      input.maxBytes > MAX_OBJECT_BYTES
    ) {
      throw new Error("Invalid report object download limit");
    }
    const response = await this.request(this.objectUrl(input.objectKey, true), {
      method: "GET",
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("Private report storage rejected object download");
    return readLimitedBody(response, input.maxBytes);
  }
}

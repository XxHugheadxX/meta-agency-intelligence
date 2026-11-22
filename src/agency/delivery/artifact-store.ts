import { createHash } from "node:crypto";
import type { Firestore } from "@google-cloud/firestore";
import { EXCEL_CONTENT_TYPE } from "../excel/index.js";
import {
  assertIsoDate,
  assertReportingScope,
  type ReportingScope,
} from "../historical-data/index.js";
import type {
  ReportArtifactStore,
  ReportArtifactContent,
  ReportObjectStore,
  StoredReportArtifact,
  StoreReportArtifactInput,
} from "./types.js";

const ARTIFACT_COLLECTION = "report_artifacts";
const MAX_REPORT_BYTES = 25 * 1024 * 1024;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 365;

interface StoredArtifactDocument extends StoredReportArtifact {
  readonly objectKey: string;
  readonly status: "pending" | "ready";
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateInput(scope: ReportingScope, input: StoreReportArtifactInput): void {
  assertReportingScope(scope);
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.jobId)) {
    throw new Error("Invalid report artifact jobId");
  }
  if (!/^[a-zA-Z0-9._-]+\.xlsx$/.test(input.report.filename)) {
    throw new Error("Report artifact filename must be a safe .xlsx filename");
  }
  if (input.report.contentType !== EXCEL_CONTENT_TYPE) {
    throw new Error("Report artifact content type must be XLSX");
  }
  assertIsoDate(input.period.startDate, "period.startDate");
  assertIsoDate(input.period.endDate, "period.endDate");
  if (
    (input.period.kind !== "week" && input.period.kind !== "month") ||
    input.period.startDate > input.period.endDate
  ) {
    throw new Error("Report artifact period is invalid");
  }
  if (input.report.bytes.length === 0 || input.report.bytes.length > MAX_REPORT_BYTES) {
    throw new Error("Report artifact exceeds its allowed size");
  }
  if (input.report.bytes[0] !== 0x50 || input.report.bytes[1] !== 0x4b) {
    throw new Error("Report artifact is not an OOXML package");
  }
  if (!Number.isInteger(input.retentionDays) ||
      input.retentionDays < MIN_RETENTION_DAYS ||
      input.retentionDays > MAX_RETENTION_DAYS) {
    throw new Error("Report artifact retentionDays is invalid");
  }
  if (
    Number.isNaN(Date.parse(input.createdAt)) ||
    new Date(input.createdAt).toISOString() !== input.createdAt
  ) {
    throw new Error("Report artifact createdAt must be an ISO timestamp");
  }
}

function createArtifact(
  scope: ReportingScope,
  input: StoreReportArtifactInput,
): { metadata: StoredReportArtifact; objectKey: string } {
  validateInput(scope, input);
  const sha256 = hash(input.report.bytes);
  const artifactId = hash([
    scope.tenantId,
    scope.workspaceId,
    input.jobId,
    input.period.kind,
    input.period.startDate,
    input.period.endDate,
    sha256,
  ].join("\u001f"));
  const namespace = hash(`${scope.tenantId}\u001f${scope.workspaceId}`);
  const expiresAt = new Date(
    Date.parse(input.createdAt) + input.retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  return {
    metadata: {
      ...scope,
      artifactId,
      jobId: input.jobId,
      period: structuredClone(input.period),
      filename: input.report.filename,
      contentType: input.report.contentType,
      byteLength: input.report.bytes.length,
      sha256,
      createdAt: input.createdAt,
      expiresAt,
    },
    objectKey: `agency-reports/${namespace}/${artifactId}.xlsx`,
  };
}

function publicMetadata(document: StoredArtifactDocument): StoredReportArtifact {
  return structuredClone({
    tenantId: document.tenantId,
    workspaceId: document.workspaceId,
    artifactId: document.artifactId,
    jobId: document.jobId,
    period: document.period,
    filename: document.filename,
    contentType: document.contentType,
    byteLength: document.byteLength,
    sha256: document.sha256,
    createdAt: document.createdAt,
    expiresAt: document.expiresAt,
  });
}

export class InMemoryReportArtifactStore implements ReportArtifactStore {
  private readonly artifacts = new Map<string, StoredReportArtifact>();
  private readonly bytes = new Map<string, Uint8Array>();

  constructor(private readonly now: () => number = Date.now) {}

  async store(
    scope: ReportingScope,
    input: StoreReportArtifactInput,
  ): Promise<StoredReportArtifact> {
    const { metadata } = createArtifact(scope, input);
    const key = `${scope.tenantId}\u001f${scope.workspaceId}\u001f${metadata.artifactId}`;
    this.artifacts.set(key, structuredClone(metadata));
    this.bytes.set(key, input.report.bytes.slice());
    return structuredClone(metadata);
  }

  async getMetadata(
    scope: ReportingScope,
    artifactId: string,
  ): Promise<StoredReportArtifact | null> {
    assertReportingScope(scope);
    const artifact = this.artifacts.get(
      `${scope.tenantId}\u001f${scope.workspaceId}\u001f${artifactId}`,
    );
    return artifact ? structuredClone(artifact) : null;
  }

  readBytes(scope: ReportingScope, artifactId: string): Uint8Array | null {
    assertReportingScope(scope);
    const bytes = this.bytes.get(
      `${scope.tenantId}\u001f${scope.workspaceId}\u001f${artifactId}`,
    );
    return bytes?.slice() ?? null;
  }

  async read(
    scope: ReportingScope,
    artifactId: string,
  ): Promise<ReportArtifactContent | null> {
    const metadata = await this.getMetadata(scope, artifactId);
    if (!metadata || Date.parse(metadata.expiresAt) <= this.now()) return null;
    const bytes = this.readBytes(scope, artifactId);
    return bytes ? { metadata, bytes } : null;
  }
}

export class FirestoreReportArtifactStore implements ReportArtifactStore {
  constructor(
    private readonly db: Firestore,
    private readonly objects: ReportObjectStore,
    private readonly now: () => number = Date.now,
  ) {}

  private collection(scope: ReportingScope) {
    assertReportingScope(scope);
    return this.db
      .collection("agency_tenants")
      .doc(scope.tenantId)
      .collection("workspaces")
      .doc(scope.workspaceId)
      .collection(ARTIFACT_COLLECTION);
  }

  async store(
    scope: ReportingScope,
    input: StoreReportArtifactInput,
  ): Promise<StoredReportArtifact> {
    const { metadata, objectKey } = createArtifact(scope, input);
    const reference = this.collection(scope).doc(metadata.artifactId);
    const pending: StoredArtifactDocument = { ...metadata, objectKey, status: "pending" };
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (snapshot.exists) {
        const existing = snapshot.data() as StoredArtifactDocument;
        if (
          existing.sha256 !== metadata.sha256 ||
          existing.jobId !== metadata.jobId ||
          existing.objectKey !== objectKey ||
          existing.filename !== metadata.filename ||
          existing.contentType !== metadata.contentType ||
          existing.byteLength !== metadata.byteLength
        ) {
          throw new Error("Report artifact identity collision");
        }
        if (existing.status === "ready") return;
      }
      transaction.set(reference, pending, { merge: false });
    });

    const current = await reference.get();
    const currentDocument = current.data() as StoredArtifactDocument | undefined;
    if (currentDocument?.status === "ready") {
      return publicMetadata(currentDocument);
    }
    try {
      await this.objects.putObject({
        objectKey,
        contentType: input.report.contentType,
        bytes: input.report.bytes.slice(),
        sha256: metadata.sha256,
      });
      await reference.update({ status: "ready" });
      return metadata;
    } catch {
      throw new Error("Report artifact could not be stored");
    }
  }

  async getMetadata(
    scope: ReportingScope,
    artifactId: string,
  ): Promise<StoredReportArtifact | null> {
    assertReportingScope(scope);
    if (!/^[a-f0-9]{64}$/.test(artifactId)) return null;
    const snapshot = await this.collection(scope).doc(artifactId).get();
    if (!snapshot.exists) return null;
    const document = snapshot.data() as StoredArtifactDocument;
    if (
      document.status !== "ready" ||
      document.tenantId !== scope.tenantId ||
      document.workspaceId !== scope.workspaceId ||
      document.artifactId !== artifactId
    ) {
      return null;
    }
    return publicMetadata(document);
  }

  async read(
    scope: ReportingScope,
    artifactId: string,
  ): Promise<ReportArtifactContent | null> {
    assertReportingScope(scope);
    if (!/^[a-f0-9]{64}$/.test(artifactId)) return null;
    const snapshot = await this.collection(scope).doc(artifactId).get();
    if (!snapshot.exists) return null;
    const document = snapshot.data() as StoredArtifactDocument;
    if (
      document.status !== "ready" ||
      document.tenantId !== scope.tenantId ||
      document.workspaceId !== scope.workspaceId ||
      document.artifactId !== artifactId ||
      Date.parse(document.expiresAt) <= this.now()
    ) {
      return null;
    }
    const bytes = await this.objects.getObject({
      objectKey: document.objectKey,
      maxBytes: MAX_REPORT_BYTES,
    });
    if (
      !bytes ||
      bytes.length !== document.byteLength ||
      hash(bytes) !== document.sha256
    ) {
      throw new Error("Stored report artifact failed its integrity check");
    }
    return { metadata: publicMetadata(document), bytes };
  }
}

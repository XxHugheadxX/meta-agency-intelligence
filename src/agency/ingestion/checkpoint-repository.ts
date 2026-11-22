import { createHash } from "node:crypto";
import type { Firestore } from "@google-cloud/firestore";
import {
  assertIsoDate,
  assertReportingScope,
  type ReportingScope,
} from "../historical-data/index.js";
import type {
  IngestionCheckpoint,
  IngestionCheckpointKey,
  IngestionCheckpointRepository,
} from "./types.js";

function canonicalBreakdowns(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function ingestionCheckpointId(
  scope: ReportingScope,
  key: IngestionCheckpointKey,
): string {
  assertReportingScope(scope);
  return createHash("sha256")
    .update([
      scope.tenantId,
      scope.workspaceId,
      key.accountId,
      key.level,
      key.attributionWindow ?? "",
      canonicalBreakdowns(key.breakdowns).join(","),
      key.apiVersion,
    ].join("\u001f"))
    .digest("hex");
}

function validateCheckpoint(scope: ReportingScope, checkpoint: IngestionCheckpoint): void {
  assertReportingScope(scope);
  assertIsoDate(checkpoint.watermarkDate, "watermarkDate");
  if (checkpoint.tenantId !== scope.tenantId || checkpoint.workspaceId !== scope.workspaceId) {
    throw new Error("Ingestion checkpoint scope does not match the requested tenant/workspace");
  }
  if (!/^act_\d+$/.test(checkpoint.accountId)) {
    throw new Error("Ingestion checkpoint requires an act_<digits> accountId");
  }
  if (!Number.isInteger(checkpoint.rowsWritten) || checkpoint.rowsWritten < 0) {
    throw new Error("Ingestion checkpoint rowsWritten must be a non-negative integer");
  }
  if (Number.isNaN(Date.parse(checkpoint.completedAt))) {
    throw new Error("Ingestion checkpoint completedAt must be an ISO timestamp");
  }
}

function isNewerCheckpoint(
  candidate: IngestionCheckpoint,
  existing: IngestionCheckpoint,
): boolean {
  return candidate.watermarkDate > existing.watermarkDate || (
    candidate.watermarkDate === existing.watermarkDate &&
    candidate.completedAt > existing.completedAt
  );
}

function readStoredCheckpoint(
  scope: ReportingScope,
  id: string,
  data: unknown,
): IngestionCheckpoint {
  if (!data || typeof data !== "object") {
    throw new Error("Stored ingestion checkpoint is not an object");
  }
  const checkpoint = data as IngestionCheckpoint;
  validateCheckpoint(scope, checkpoint);
  if (ingestionCheckpointId(scope, checkpoint) !== id) {
    throw new Error("Stored ingestion checkpoint identity does not match the requested key");
  }
  return checkpoint;
}

export class InMemoryIngestionCheckpointRepository implements IngestionCheckpointRepository {
  private readonly checkpoints = new Map<string, IngestionCheckpoint>();

  async get(
    scope: ReportingScope,
    key: IngestionCheckpointKey,
  ): Promise<IngestionCheckpoint | null> {
    const checkpoint = this.checkpoints.get(ingestionCheckpointId(scope, key));
    return checkpoint ? structuredClone(checkpoint) : null;
  }

  async save(scope: ReportingScope, checkpoint: IngestionCheckpoint): Promise<void> {
    validateCheckpoint(scope, checkpoint);
    const id = ingestionCheckpointId(scope, checkpoint);
    const existing = this.checkpoints.get(id);
    if (!existing || isNewerCheckpoint(checkpoint, existing)) {
      this.checkpoints.set(id, structuredClone(checkpoint));
    }
  }
}

export class FirestoreIngestionCheckpointRepository implements IngestionCheckpointRepository {
  constructor(private readonly db: Firestore) {}

  private collection(scope: ReportingScope) {
    assertReportingScope(scope);
    return this.db
      .collection("agency_tenants")
      .doc(scope.tenantId)
      .collection("workspaces")
      .doc(scope.workspaceId)
      .collection("ingestion_checkpoints");
  }

  async get(
    scope: ReportingScope,
    key: IngestionCheckpointKey,
  ): Promise<IngestionCheckpoint | null> {
    const snapshot = await this.collection(scope).doc(ingestionCheckpointId(scope, key)).get();
    if (!snapshot.exists) return null;
    const checkpoint = readStoredCheckpoint(
      scope,
      ingestionCheckpointId(scope, key),
      snapshot.data(),
    );
    return structuredClone(checkpoint);
  }

  async save(scope: ReportingScope, checkpoint: IngestionCheckpoint): Promise<void> {
    validateCheckpoint(scope, checkpoint);
    const id = ingestionCheckpointId(scope, checkpoint);
    const reference = this.collection(scope).doc(id);
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (snapshot.exists) {
        const existing = readStoredCheckpoint(scope, id, snapshot.data());
        if (!isNewerCheckpoint(checkpoint, existing)) return;
      }
      transaction.set(reference, checkpoint, { merge: false });
    });
  }
}

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
    this.checkpoints.set(ingestionCheckpointId(scope, checkpoint), structuredClone(checkpoint));
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
    const checkpoint = snapshot.data() as IngestionCheckpoint;
    validateCheckpoint(scope, checkpoint);
    if (ingestionCheckpointId(scope, checkpoint) !== ingestionCheckpointId(scope, key)) {
      throw new Error("Stored ingestion checkpoint identity does not match the requested key");
    }
    return structuredClone(checkpoint);
  }

  async save(scope: ReportingScope, checkpoint: IngestionCheckpoint): Promise<void> {
    validateCheckpoint(scope, checkpoint);
    await this.collection(scope)
      .doc(ingestionCheckpointId(scope, checkpoint))
      .set(checkpoint, { merge: false });
  }
}

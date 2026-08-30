import { randomUUID } from "node:crypto";
import type { Firestore } from "@google-cloud/firestore";
import {
  assertReportingScope,
  type ReportingScope,
} from "../historical-data/index.js";
import type {
  AgencyAccountConnection,
  AgencyAccountConnectionRepository,
  TenantWorkspacePolicy,
} from "./connection-resolver.js";
import type { IngestionAuditEvent, IngestionAuditSink } from "./types.js";

const WORKSPACE_FIELDS = ["active", "schemaVersion", "tenantId", "workspaceId"];
const ACCOUNT_FIELDS = [
  "accountId", "accountName", "active", "agentId", "agentName", "currency",
  "schemaVersion", "tenantId", "timezone", "tokenName", "workspaceId",
];

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

function safeIdentifier(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f/]/.test(value)
  ) {
    throw new Error(`${field} is invalid`);
  }
}

function safeText(value: unknown, field: string, maxLength = 200): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${field} is invalid`);
  }
}

function workspaceReference(db: Firestore, scope: ReportingScope) {
  assertReportingScope(scope);
  safeIdentifier(scope.tenantId, "tenantId");
  safeIdentifier(scope.workspaceId, "workspaceId");
  return db.collection("agency_tenants").doc(scope.tenantId)
    .collection("workspaces").doc(scope.workspaceId);
}

export class FirestoreTenantWorkspacePolicy implements TenantWorkspacePolicy {
  constructor(private readonly db: Firestore) {}

  async assertWorkspaceOwned(scope: ReportingScope): Promise<void> {
    const snapshot = await workspaceReference(this.db, scope).get();
    if (!snapshot.exists) throw new Error("Workspace is not assigned to this tenant");
    const data = snapshot.data();
    if (
      !data ||
      !exactKeys(data, WORKSPACE_FIELDS) ||
      data.schemaVersion !== 1 ||
      data.active !== true ||
      data.tenantId !== scope.tenantId ||
      data.workspaceId !== scope.workspaceId
    ) {
      throw new Error("Stored workspace ownership is invalid");
    }
  }
}

export class FirestoreAgencyAccountConnectionRepository
implements AgencyAccountConnectionRepository {
  constructor(private readonly db: Firestore) {}

  async get(scope: ReportingScope, accountId: string): Promise<AgencyAccountConnection | null> {
    safeIdentifier(accountId, "accountId");
    if (!/^act_\d+$/.test(accountId)) throw new Error("accountId is invalid");
    const snapshot = await workspaceReference(this.db, scope)
      .collection("account_connections").doc(accountId).get();
    if (!snapshot.exists) return null;
    const data = snapshot.data();
    if (!data || !exactKeys(data, ACCOUNT_FIELDS)) {
      throw new Error("Stored agency account connection has unsupported fields");
    }
    if (
      data.schemaVersion !== 1 ||
      data.tenantId !== scope.tenantId ||
      data.workspaceId !== scope.workspaceId ||
      data.accountId !== accountId ||
      typeof data.active !== "boolean"
    ) {
      throw new Error("Stored agency account connection identity is invalid");
    }
    safeText(data.accountName, "accountName");
    safeIdentifier(data.tokenName, "tokenName");
    if (typeof data.currency !== "string" || !/^[A-Z]{3}$/.test(data.currency)) {
      throw new Error("currency is invalid");
    }
    safeText(data.timezone, "timezone", 100);
    if (data.agentId !== null) safeIdentifier(data.agentId, "agentId");
    if (data.agentName !== null) safeText(data.agentName, "agentName");
    return {
      tenantId: data.tenantId,
      workspaceId: data.workspaceId,
      accountId: data.accountId,
      accountName: data.accountName,
      currency: data.currency,
      timezone: data.timezone,
      agentId: data.agentId,
      agentName: data.agentName,
      tokenName: data.tokenName,
      active: data.active,
    };
  }
}

export class FirestoreIngestionAuditSink implements IngestionAuditSink {
  constructor(private readonly db: Firestore) {}

  async record(event: IngestionAuditEvent): Promise<void> {
    const scope = { tenantId: event.tenantId, workspaceId: event.workspaceId };
    const reference = workspaceReference(this.db, scope)
      .collection("reporting_audit_events").doc(randomUUID());
    safeIdentifier(event.jobId, "jobId");
    safeIdentifier(event.accountId, "accountId");
    safeIdentifier(event.workloadSubject, "workloadSubject");
    if (!/^(started|succeeded|rejected|failed)$/.test(event.outcome)) {
      throw new Error("Audit outcome is invalid");
    }
    if (event.code !== undefined) safeIdentifier(event.code, "audit code");
    const occurredAt = new Date(event.occurredAt);
    if (Number.isNaN(occurredAt.getTime()) || occurredAt.toISOString() !== event.occurredAt) {
      throw new Error("Audit timestamp is invalid");
    }
    await reference.create({ schemaVersion: 1, ...event, occurredAt });
  }
}

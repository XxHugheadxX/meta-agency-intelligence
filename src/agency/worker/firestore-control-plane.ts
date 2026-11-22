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
import type {
  ScheduledReportingAccount,
  ScheduledReportingAccountSource,
} from "../scheduler/index.js";
import type { IngestionAuditEvent, IngestionAuditSink } from "./types.js";

const WORKSPACE_FIELDS = ["active", "schemaVersion", "tenantId", "workspaceId"];
const ACCOUNT_FIELDS = [
  "accountId", "accountName", "active", "agentId", "agentName", "currency",
  "schemaVersion", "tenantId", "timezone", "tokenName", "workspaceId",
];
const SCHEDULE_ACCOUNT_FIELDS = [
  "accountId", "active", "schemaVersion", "tenantId", "workspaceId",
] as const;
const MAX_SCHEDULE_ACCOUNT_RESULTS = 101;

export interface ProvisionAgencyWorkspaceInput extends ReportingScope {
  readonly active: boolean;
}

export type ProvisionAgencyAccountInput = AgencyAccountConnection;

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

function assertWorkspaceDocument(
  scope: ReportingScope,
  data: Record<string, unknown> | undefined,
  requireActive: boolean,
): void {
  if (
    !data ||
    !exactKeys(data, WORKSPACE_FIELDS) ||
    data.schemaVersion !== 1 ||
    typeof data.active !== "boolean" ||
    (requireActive && data.active !== true) ||
    data.tenantId !== scope.tenantId ||
    data.workspaceId !== scope.workspaceId
  ) {
    throw new Error("Stored workspace ownership is invalid");
  }
}

function accountDocument(input: ProvisionAgencyAccountInput) {
  assertReportingScope(input);
  safeIdentifier(input.tenantId, "tenantId");
  safeIdentifier(input.workspaceId, "workspaceId");
  safeIdentifier(input.accountId, "accountId");
  if (!/^act_\d+$/.test(input.accountId)) throw new Error("accountId is invalid");
  safeText(input.accountName, "accountName");
  safeIdentifier(input.tokenName, "tokenName");
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error("currency is invalid");
  safeText(input.timezone, "timezone", 100);
  if (input.agentId !== null && input.agentId !== undefined) safeIdentifier(input.agentId, "agentId");
  if (input.agentName !== null && input.agentName !== undefined) safeText(input.agentName, "agentName");
  if (typeof input.active !== "boolean") throw new Error("active must be boolean");
  return {
    schemaVersion: 1,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    accountName: input.accountName,
    currency: input.currency,
    timezone: input.timezone,
    agentId: input.agentId ?? null,
    agentName: input.agentName ?? null,
    tokenName: input.tokenName,
    active: input.active,
  } as const;
}

export class FirestoreTenantWorkspacePolicy implements TenantWorkspacePolicy {
  constructor(private readonly db: Firestore) {}

  async assertWorkspaceOwned(scope: ReportingScope): Promise<void> {
    const snapshot = await workspaceReference(this.db, scope).get();
    if (!snapshot.exists) throw new Error("Workspace is not assigned to this tenant");
    const data = snapshot.data();
    assertWorkspaceDocument(scope, data, true);
  }
}

export class FirestoreAgencyControlPlaneProvisioner {
  constructor(
    private readonly db: Firestore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private occurredAt(): Date {
    const occurredAt = this.now();
    if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
      throw new Error("Control plane clock returned an invalid date");
    }
    return new Date(occurredAt.getTime());
  }

  async provisionWorkspace(
    input: ProvisionAgencyWorkspaceInput,
    actorSubject: string,
  ): Promise<void> {
    safeIdentifier(actorSubject, "actorSubject");
    if (typeof input.active !== "boolean") throw new Error("active must be boolean");
    const reference = workspaceReference(this.db, input);
    const auditReference = reference.collection("control_plane_audit").doc(randomUUID());
    const occurredAt = this.occurredAt();
    await this.db.runTransaction(async (transaction) => {
      const existing = await transaction.get(reference);
      if (existing.exists) assertWorkspaceDocument(input, existing.data(), false);
      transaction.set(reference, {
        schemaVersion: 1,
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        active: input.active,
      }, { merge: false });
      transaction.create(auditReference, {
        schemaVersion: 1,
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        action: "workspace.provisioned",
        actorSubject,
        targetAccountId: null,
        occurredAt,
      });
    });
  }

  async provisionAccount(
    input: ProvisionAgencyAccountInput,
    actorSubject: string,
  ): Promise<void> {
    safeIdentifier(actorSubject, "actorSubject");
    const document = accountDocument(input);
    const workspace = workspaceReference(this.db, input);
    const reference = workspace.collection("account_connections").doc(input.accountId);
    const auditReference = workspace.collection("control_plane_audit").doc(randomUUID());
    const occurredAt = this.occurredAt();
    await this.db.runTransaction(async (transaction) => {
      const workspaceSnapshot = await transaction.get(workspace);
      assertWorkspaceDocument(input, workspaceSnapshot.data(), true);
      const existing = await transaction.get(reference);
      if (existing.exists) {
        const data = existing.data();
        if (
          !data ||
          !exactKeys(data, ACCOUNT_FIELDS) ||
          data.tenantId !== input.tenantId ||
          data.workspaceId !== input.workspaceId ||
          data.accountId !== input.accountId
        ) {
          throw new Error("Existing agency account identity is invalid");
        }
      }
      transaction.set(reference, document, { merge: false });
      transaction.create(auditReference, {
        schemaVersion: 1,
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        action: "account.provisioned",
        actorSubject,
        targetAccountId: input.accountId,
        occurredAt,
      });
    });
  }
}

export class FirestoreAgencyAccountConnectionRepository
implements AgencyAccountConnectionRepository, ScheduledReportingAccountSource {
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

  async listActive(scope: ReportingScope): Promise<readonly ScheduledReportingAccount[]> {
    const workspace = workspaceReference(this.db, scope);
    const workspaceSnapshot = await workspace.get();
    if (!workspaceSnapshot.exists) throw new Error("Workspace is not assigned to this tenant");
    assertWorkspaceDocument(scope, workspaceSnapshot.data(), true);

    const snapshot = await workspace.collection("account_connections")
      .where("active", "==", true)
      .select(...SCHEDULE_ACCOUNT_FIELDS)
      .limit(MAX_SCHEDULE_ACCOUNT_RESULTS)
      .get();
    return snapshot.docs.map((document) => {
      const data = document.data();
      if (!data || !exactKeys(data, SCHEDULE_ACCOUNT_FIELDS)) {
        throw new Error("Stored scheduled account has unsupported fields");
      }
      if (
        data.schemaVersion !== 1 ||
        data.active !== true ||
        data.tenantId !== scope.tenantId ||
        data.workspaceId !== scope.workspaceId ||
        data.accountId !== document.id
      ) {
        throw new Error("Stored scheduled account identity is invalid");
      }
      safeIdentifier(data.accountId, "accountId");
      if (!/^act_\d+$/.test(data.accountId)) throw new Error("accountId is invalid");
      return {
        tenantId: data.tenantId,
        workspaceId: data.workspaceId,
        accountId: data.accountId,
      };
    });
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

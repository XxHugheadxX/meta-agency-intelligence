import type { Firestore } from "@google-cloud/firestore";
import { describe, expect, it, vi } from "vitest";
import {
  FirestoreAgencyAccountConnectionRepository,
  FirestoreAgencyControlPlaneProvisioner,
  FirestoreIngestionAuditSink,
  FirestoreTenantWorkspacePolicy,
} from "../../src/agency/worker/index.js";
import { tenantA } from "./fixtures.js";

interface FakeReference {
  readonly path: string;
  collection(name: string): { doc(id: string): FakeReference };
}

function provisioningFirestore(initial: Record<string, Record<string, unknown>> = {}) {
  const documents = new Map(Object.entries(initial));
  const reference = (path: string): FakeReference => ({
    path,
    collection: (name) => ({ doc: (id) => reference(`${path}/${name}/${id}`) }),
  });
  const db = {
    collection: (name: string) => ({ doc: (id: string) => reference(`${name}/${id}`) }),
    runTransaction: async (operation: (transaction: unknown) => Promise<void>) => operation({
      get: async (ref: FakeReference) => ({
        exists: documents.has(ref.path),
        data: () => documents.get(ref.path),
      }),
      set: (ref: FakeReference, data: Record<string, unknown>) => {
        documents.set(ref.path, structuredClone(data));
      },
      create: (ref: FakeReference, data: Record<string, unknown>) => {
        if (documents.has(ref.path)) throw new Error("document exists");
        documents.set(ref.path, structuredClone(data));
      },
    }),
  } as unknown as Firestore;
  return { db, documents };
}

function fakeFirestore(input: {
  workspace?: Record<string, unknown>;
  account?: Record<string, unknown>;
  auditCreate?: ReturnType<typeof vi.fn>;
}): Firestore {
  const snapshot = (data?: Record<string, unknown>) => ({
    exists: data !== undefined,
    data: () => data,
  });
  const auditCreate = input.auditCreate ?? vi.fn().mockResolvedValue(undefined);
  const workspaceDocument = {
    get: vi.fn().mockResolvedValue(snapshot(input.workspace)),
    collection: vi.fn((name: string) => ({
      doc: vi.fn(() => name === "account_connections"
        ? { get: vi.fn().mockResolvedValue(snapshot(input.account)) }
        : { create: auditCreate }),
    })),
  };
  return {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({
        collection: vi.fn(() => ({ doc: vi.fn(() => workspaceDocument) })),
      })),
    })),
  } as unknown as Firestore;
}

const workspace = {
  schemaVersion: 1,
  ...tenantA,
  active: true,
};

const account = {
  schemaVersion: 1,
  ...tenantA,
  accountId: "act_100",
  accountName: "Inmobiliaria Norte",
  currency: "BOB",
  timezone: "America/La_Paz",
  agentId: null,
  agentName: null,
  tokenName: "reporting",
  active: true,
};

describe("Firestore agency control plane", () => {
  it("accepts only an active workspace whose identity matches its tenant path", async () => {
    await expect(
      new FirestoreTenantWorkspacePolicy(fakeFirestore({ workspace }))
        .assertWorkspaceOwned(tenantA),
    ).resolves.toBeUndefined();
    await expect(
      new FirestoreTenantWorkspacePolicy(fakeFirestore({
        workspace: { ...workspace, tenantId: "other-tenant" },
      })).assertWorkspaceOwned(tenantA),
    ).rejects.toThrow("ownership");
  });

  it("returns validated account metadata without storing a Meta token", async () => {
    const repository = new FirestoreAgencyAccountConnectionRepository(
      fakeFirestore({ account }),
    );
    await expect(repository.get(tenantA, "act_100")).resolves.toEqual({
      ...tenantA,
      accountId: "act_100",
      accountName: "Inmobiliaria Norte",
      currency: "BOB",
      timezone: "America/La_Paz",
      agentId: null,
      agentName: null,
      tokenName: "reporting",
      active: true,
    });
    await expect(
      new FirestoreAgencyAccountConnectionRepository(fakeFirestore({
        account: { ...account, accessToken: "forbidden" },
      })).get(tenantA, "act_100"),
    ).rejects.toThrow("unsupported fields");
  });

  it("creates append-only tenant-scoped audit events with a Firestore timestamp", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const audit = new FirestoreIngestionAuditSink(fakeFirestore({ auditCreate: create }));
    await audit.record({
      ...tenantA,
      jobId: "weekly-job",
      accountId: "act_100",
      workloadSubject: "123456789012345678901",
      outcome: "succeeded",
      occurredAt: "2026-08-31T08:00:00.000Z",
    });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0]).toMatchObject({
      schemaVersion: 1,
      ...tenantA,
      jobId: "weekly-job",
      outcome: "succeeded",
      occurredAt: new Date("2026-08-31T08:00:00.000Z"),
    });
    expect(JSON.stringify(create.mock.calls[0][0])).not.toContain("token");
  });

  it("provisions workspace and account metadata without accepting embedded tokens", async () => {
    const state = provisioningFirestore();
    const provisioner = new FirestoreAgencyControlPlaneProvisioner(
      state.db,
      () => new Date("2026-08-31T08:00:00.000Z"),
    );
    await provisioner.provisionWorkspace({ ...tenantA, active: true }, "admin-operator");
    await provisioner.provisionAccount({
      ...account,
      accessToken: "must-not-be-persisted",
    } as typeof account, "admin-operator");

    const workspacePath = `agency_tenants/${tenantA.tenantId}/workspaces/${tenantA.workspaceId}`;
    expect(state.documents.get(workspacePath)).toEqual(workspace);
    expect(state.documents.get(`${workspacePath}/account_connections/act_100`))
      .toEqual(account);
    expect(JSON.stringify([...state.documents.values()])).not.toContain("must-not-be-persisted");
    expect([...state.documents.keys()].filter((path) => path.includes("control_plane_audit")))
      .toHaveLength(2);
  });

  it("refuses to provision an account under an inactive workspace", async () => {
    const workspacePath = `agency_tenants/${tenantA.tenantId}/workspaces/${tenantA.workspaceId}`;
    const state = provisioningFirestore({
      [workspacePath]: { ...workspace, active: false },
    });
    const provisioner = new FirestoreAgencyControlPlaneProvisioner(state.db);
    await expect(provisioner.provisionAccount(account, "admin-operator"))
      .rejects.toThrow("ownership");
    expect(state.documents.has(`${workspacePath}/account_connections/act_100`)).toBe(false);
  });
});

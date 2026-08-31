import { getFirestore } from "./firestore.js";

export type BoundAssetKind = "ad_account" | "page" | "instagram";

export interface AssetBinding {
  kind: BoundAssetKind;
  assetId: string;
  assetName?: string;
  /** Associates an organic asset with exactly one scheduled reporting account. */
  reportingAccountId?: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SaveAssetBindingInput {
  workspaceId: string;
  kind: BoundAssetKind;
  assetId: string;
  assetName?: string;
  reportingAccountId?: string;
  active?: boolean;
}

function validateBindingInput(input: SaveAssetBindingInput): void {
  if (!input.workspaceId.trim() || !input.assetId.trim()) {
    throw new Error("Asset binding workspaceId and assetId are required");
  }
  if (input.assetName !== undefined && (!input.assetName.trim() || input.assetName.length > 200)) {
    throw new Error("Asset binding assetName is invalid");
  }
  if (
    input.reportingAccountId !== undefined &&
    (!/^act_\d+$/.test(input.reportingAccountId) || input.kind === "ad_account")
  ) {
    throw new Error("Asset binding reportingAccountId is invalid");
  }
}

export interface AssetBindingRepo {
  listActive(workspaceId: string): Promise<AssetBinding[]>;
  save(input: SaveAssetBindingInput): Promise<void>;
}

function bindingDocId(kind: BoundAssetKind, assetId: string): string {
  return Buffer.from(`${kind}:${assetId}`, "utf8").toString("base64url");
}

export class FirestoreAssetBindingRepo implements AssetBindingRepo {
  private collection(workspaceId: string) {
    return getFirestore()
      .collection("workspaces")
      .doc(workspaceId)
      .collection("asset_bindings");
  }

  async listActive(workspaceId: string): Promise<AssetBinding[]> {
    const snapshot = await this.collection(workspaceId)
      .where("active", "==", true)
      .get();
    return snapshot.docs.map((doc) => doc.data() as AssetBinding);
  }

  async save(input: SaveAssetBindingInput): Promise<void> {
    validateBindingInput(input);
    const now = Math.floor(Date.now() / 1000);
    const ref = this.collection(input.workspaceId).doc(
      bindingDocId(input.kind, input.assetId),
    );
    const existing = await ref.get();
    const existingBinding = existing.exists ? existing.data() as Partial<AssetBinding> : undefined;
    const assetName = input.assetName ?? existingBinding?.assetName;
    const reportingAccountId = input.reportingAccountId ?? existingBinding?.reportingAccountId;
    const binding: AssetBinding = {
      kind: input.kind,
      assetId: input.assetId,
      ...(assetName === undefined ? {} : { assetName: assetName.trim() }),
      ...(reportingAccountId === undefined ? {} : { reportingAccountId }),
      active: input.active ?? true,
      createdAt: existing.exists
        ? Number(existingBinding?.createdAt ?? now)
        : now,
      updatedAt: now,
    };
    await ref.set(binding, { merge: false });
  }
}

export class InMemoryAssetBindingRepo implements AssetBindingRepo {
  private readonly bindings = new Map<string, Map<string, AssetBinding>>();

  async listActive(workspaceId: string): Promise<AssetBinding[]> {
    return [...(this.bindings.get(workspaceId)?.values() ?? [])].filter(
      (binding) => binding.active,
    );
  }

  async save(input: SaveAssetBindingInput): Promise<void> {
    validateBindingInput(input);
    const now = Math.floor(Date.now() / 1000);
    let workspace = this.bindings.get(input.workspaceId);
    if (!workspace) {
      workspace = new Map();
      this.bindings.set(input.workspaceId, workspace);
    }
    const id = bindingDocId(input.kind, input.assetId);
    const existing = workspace.get(id);
    const assetName = input.assetName ?? existing?.assetName;
    const reportingAccountId = input.reportingAccountId ?? existing?.reportingAccountId;
    workspace.set(id, {
      kind: input.kind,
      assetId: input.assetId,
      ...(assetName === undefined ? {} : { assetName: assetName.trim() }),
      ...(reportingAccountId === undefined ? {} : { reportingAccountId }),
      active: input.active ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }
}

let activeRepo: AssetBindingRepo = new FirestoreAssetBindingRepo();

export function configureAssetBindingRepo(repo: AssetBindingRepo): void {
  activeRepo = repo;
}

export function resetAssetBindingRepoForTests(): void {
  activeRepo = new FirestoreAssetBindingRepo();
}

export function listActiveAssetBindings(
  workspaceId: string,
): Promise<AssetBinding[]> {
  return activeRepo.listActive(workspaceId);
}

export function saveAssetBinding(
  input: SaveAssetBindingInput,
): Promise<void> {
  return activeRepo.save(input);
}

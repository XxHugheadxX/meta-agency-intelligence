import { getFirestore } from "./firestore.js";

export type BoundAssetKind = "ad_account" | "page" | "instagram";

export interface AssetBinding {
  kind: BoundAssetKind;
  assetId: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SaveAssetBindingInput {
  workspaceId: string;
  kind: BoundAssetKind;
  assetId: string;
  active?: boolean;
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
    const now = Math.floor(Date.now() / 1000);
    const ref = this.collection(input.workspaceId).doc(
      bindingDocId(input.kind, input.assetId),
    );
    const existing = await ref.get();
    const binding: AssetBinding = {
      kind: input.kind,
      assetId: input.assetId,
      active: input.active ?? true,
      createdAt: existing.exists
        ? Number((existing.data() as Partial<AssetBinding>).createdAt ?? now)
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
    const now = Math.floor(Date.now() / 1000);
    let workspace = this.bindings.get(input.workspaceId);
    if (!workspace) {
      workspace = new Map();
      this.bindings.set(input.workspaceId, workspace);
    }
    const id = bindingDocId(input.kind, input.assetId);
    const existing = workspace.get(id);
    workspace.set(id, {
      kind: input.kind,
      assetId: input.assetId,
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

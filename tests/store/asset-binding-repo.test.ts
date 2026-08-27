import { describe, expect, it } from "vitest";
import { InMemoryAssetBindingRepo } from "../../src/store/asset-binding-repo.js";

describe("InMemoryAssetBindingRepo", () => {
  it("isolates active bindings by workspace", async () => {
    const repo = new InMemoryAssetBindingRepo();
    await repo.save({
      workspaceId: "workspace-a",
      kind: "ad_account",
      assetId: "act_100",
    });
    await repo.save({
      workspaceId: "workspace-b",
      kind: "ad_account",
      assetId: "act_200",
    });
    await repo.save({
      workspaceId: "workspace-a",
      kind: "page",
      assetId: "300",
      active: false,
    });

    await expect(repo.listActive("workspace-a")).resolves.toMatchObject([
      { kind: "ad_account", assetId: "act_100", active: true },
    ]);
    await expect(repo.listActive("workspace-b")).resolves.toMatchObject([
      { kind: "ad_account", assetId: "act_200", active: true },
    ]);
    await expect(repo.listActive("workspace-missing")).resolves.toEqual([]);
  });

  it("updates a binding without changing its creation timestamp", async () => {
    const repo = new InMemoryAssetBindingRepo();
    await repo.save({
      workspaceId: "workspace-a",
      kind: "instagram",
      assetId: "400",
    });
    const [created] = await repo.listActive("workspace-a");
    await repo.save({
      workspaceId: "workspace-a",
      kind: "instagram",
      assetId: "400",
      active: false,
    });
    expect(await repo.listActive("workspace-a")).toEqual([]);
    await repo.save({
      workspaceId: "workspace-a",
      kind: "instagram",
      assetId: "400",
    });
    const [restored] = await repo.listActive("workspace-a");
    expect(restored.createdAt).toBe(created.createdAt);
  });
});

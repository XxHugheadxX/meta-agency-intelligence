import { assertReportingScope, type ReportingScope } from "../historical-data/index.js";
import type { OrganicAssetPolicy, OrganicPlatform } from "./organic-types.js";

function scopeKey(scope: ReportingScope): string {
  assertReportingScope(scope);
  return `${scope.tenantId}\u001f${scope.workspaceId}`;
}

function assetKey(platform: OrganicPlatform, assetId: string): string {
  if (!/^\d{1,32}$/.test(assetId)) {
    throw new Error("Organic asset bindings require a numeric Meta assetId");
  }
  return `${platform}\u001f${assetId}`;
}

export class InMemoryOrganicAssetPolicy implements OrganicAssetPolicy {
  private readonly assets = new Map<string, Set<string>>();

  allow(scope: ReportingScope, platform: OrganicPlatform, assetId: string): void {
    const key = scopeKey(scope);
    const allowed = this.assets.get(key) ?? new Set<string>();
    allowed.add(assetKey(platform, assetId));
    this.assets.set(key, allowed);
  }

  async assertAssetAllowed(
    scope: ReportingScope,
    platform: OrganicPlatform,
    assetId: string,
  ): Promise<void> {
    if (!this.assets.get(scopeKey(scope))?.has(assetKey(platform, assetId))) {
      throw new Error("Requested organic asset is not assigned to this tenant/workspace");
    }
  }
}

import {
  assertReportingScope,
  type ReportingScope,
} from "../historical-data/index.js";
import type { IngestionAssetPolicy } from "./types.js";

function scopeKey(scope: ReportingScope): string {
  assertReportingScope(scope);
  return `${scope.tenantId}\u001f${scope.workspaceId}`;
}

export class InMemoryIngestionAssetPolicy implements IngestionAssetPolicy {
  private readonly accounts = new Map<string, Set<string>>();

  allow(scope: ReportingScope, accountId: string): void {
    if (!/^act_\d+$/.test(accountId)) {
      throw new Error("Ingestion account bindings require an act_<digits> accountId");
    }
    const key = scopeKey(scope);
    const allowed = this.accounts.get(key) ?? new Set<string>();
    allowed.add(accountId);
    this.accounts.set(key, allowed);
  }

  async assertAccountAllowed(scope: ReportingScope, accountId: string): Promise<void> {
    if (!this.accounts.get(scopeKey(scope))?.has(accountId)) {
      throw new Error("Requested ad account is not assigned to this tenant/workspace");
    }
  }
}

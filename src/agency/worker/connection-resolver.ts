import type { AssetBindingRepo } from "../../store/asset-binding-repo.js";
import type { MetaTokenRepo } from "../../store/meta-token-repo.js";
import { assertReportingScope, type ReportingScope } from "../historical-data/index.js";
import type { IngestionAccount } from "../ingestion/index.js";
import type {
  IngestionConnectionResolver,
  ResolvedIngestionConnection,
} from "./types.js";

export interface AgencyAccountConnection extends IngestionAccount, ReportingScope {
  readonly tokenName: string;
  readonly active: boolean;
}

export interface AgencyAccountConnectionRepository {
  get(
    scope: ReportingScope,
    accountId: string,
  ): Promise<AgencyAccountConnection | null>;
}

export interface TenantWorkspacePolicy {
  assertWorkspaceOwned(scope: ReportingScope): Promise<void>;
}

function normalizeAccountId(value: string): string {
  return value.startsWith("act_") ? value : `act_${value}`;
}

export class RepositoryIngestionConnectionResolver implements IngestionConnectionResolver {
  constructor(
    private readonly workspacePolicy: TenantWorkspacePolicy,
    private readonly accounts: AgencyAccountConnectionRepository,
    private readonly bindings: AssetBindingRepo,
    private readonly tokens: MetaTokenRepo,
    private readonly serverUrl?: URL,
  ) {}

  async resolve(
    scope: ReportingScope,
    accountId: string,
  ): Promise<ResolvedIngestionConnection> {
    assertReportingScope(scope);
    if (!/^act_\d+$/.test(accountId)) {
      throw new Error("Ingestion connection requires an act_<digits> accountId");
    }
    await this.workspacePolicy.assertWorkspaceOwned(scope);

    const account = await this.accounts.get(scope, accountId);
    if (
      !account ||
      !account.active ||
      account.tenantId !== scope.tenantId ||
      account.workspaceId !== scope.workspaceId ||
      account.accountId !== accountId
    ) {
      throw new Error("Ingestion account connection is not active for this tenant/workspace");
    }
    if (
      !account.accountName.trim() ||
      !account.currency.trim() ||
      !account.timezone.trim() ||
      !account.tokenName.trim() ||
      account.tokenName.includes("/")
    ) {
      throw new Error("Ingestion account connection metadata is invalid");
    }

    const activeBindings = await this.bindings.listActive(scope.workspaceId);
    const isBound = activeBindings.some(
      (binding) =>
        binding.kind === "ad_account" && normalizeAccountId(binding.assetId) === accountId,
    );
    if (!isBound) {
      throw new Error("Ingestion account is not present in the active workspace bindings");
    }

    const token = await this.tokens.resolveToken(
      scope.workspaceId,
      account.tokenName,
      this.serverUrl,
    );
    const allowedAccountIds = token.allowedAccountIds.map(normalizeAccountId);
    if (token.workspaceId !== scope.workspaceId || !allowedAccountIds.includes(accountId)) {
      throw new Error("Resolved Meta token is not authorized for the ingestion account");
    }

    return {
      scope: {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
      },
      account: {
        accountId: account.accountId,
        accountName: account.accountName,
        currency: account.currency,
        timezone: account.timezone,
        agentId: account.agentId ?? null,
        agentName: account.agentName ?? null,
      },
      accessToken: token.accessToken,
      scopes: [...token.scopes],
      allowedAccountIds,
    };
  }
}

export class InMemoryTenantWorkspacePolicy implements TenantWorkspacePolicy {
  private readonly scopes = new Set<string>();

  allow(scope: ReportingScope): void {
    assertReportingScope(scope);
    this.scopes.add(`${scope.tenantId}\u001f${scope.workspaceId}`);
  }

  async assertWorkspaceOwned(scope: ReportingScope): Promise<void> {
    assertReportingScope(scope);
    if (!this.scopes.has(`${scope.tenantId}\u001f${scope.workspaceId}`)) {
      throw new Error("Workspace is not assigned to this tenant");
    }
  }
}

export class InMemoryAgencyAccountConnectionRepository
implements AgencyAccountConnectionRepository {
  private readonly connections = new Map<string, AgencyAccountConnection>();

  save(connection: AgencyAccountConnection): void {
    assertReportingScope(connection);
    this.connections.set(
      `${connection.tenantId}\u001f${connection.workspaceId}\u001f${connection.accountId}`,
      structuredClone(connection),
    );
  }

  async get(
    scope: ReportingScope,
    accountId: string,
  ): Promise<AgencyAccountConnection | null> {
    const connection = this.connections.get(
      `${scope.tenantId}\u001f${scope.workspaceId}\u001f${accountId}`,
    );
    return connection ? structuredClone(connection) : null;
  }
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { registerToolsWithPolicy } from "../../src/tools/index.js";
import { createMockMcpServer, setupTestToken, cleanupTestToken, mockFetchResponse } from "../setup.js";
import { MetaApiClient } from "../../src/meta/client.js";
import {
  configureMetaTokenRepo,
  InMemoryMetaTokenRepo,
  resetMetaTokenRepoForTests,
  saveToken,
} from "../../src/store/meta-token-repo.js";
import {
  configureAssetBindingRepo,
  InMemoryAssetBindingRepo,
  resetAssetBindingRepoForTests,
  saveAssetBinding,
} from "../../src/store/asset-binding-repo.js";
import { buildMetaTokenMiddleware, renderConsentPage } from "../../src/transport/http.js";
import {
  getAccessToken,
  getTenantContext,
  requestContext,
} from "../../src/auth/token-store.js";
import { requireSameOriginPost } from "../../src/transport/auth-routes.js";
import {
  oauthProvider,
  resetOAuthProviderForTests,
} from "../../src/auth/oauth-provider.js";
import { inspectReportingToken } from "../../src/auth/meta-oauth.js";

function responseMock() {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
    type: vi.fn(),
    send: vi.fn(),
    setHeader: vi.fn(),
  };
  response.status.mockReturnValue(response);
  response.type.mockReturnValue(response);
  return response;
}

describe("security hardening", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.OAUTH_SECRET = "o".repeat(64);
    resetOAuthProviderForTests();
  });

  afterEach(() => {
    cleanupTestToken();
    resetMetaTokenRepoForTests();
    resetAssetBindingRepoForTests();
    resetOAuthProviderForTests();
  });

  it("publishes only pure reporting tools in read-only mode", () => {
    const server = createMockMcpServer();
    registerToolsWithPolicy(server as never, {
      mode: "read_only",
      allowLeadPii: false,
    });
    const names = server._registeredTools.map((tool) => tool.name);
    expect(names).toHaveLength(58);
    expect(server._registeredTools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
    expect(names).not.toContain("ads_create_campaign");
    expect(names).not.toContain("ads_update_campaign");
    expect(names).not.toContain("ads_delete_campaign");
    expect(names).not.toContain("ads_get_leads");
    expect(names).not.toContain("ads_get_ad_leads");
    expect(names.some((name) => name.startsWith("whatsapp_"))).toBe(false);
    expect(names.some((name) => name.startsWith("ads_library_"))).toBe(false);
  });

  it("never renders a Meta token input in the browser", () => {
    const html = renderConsentPage({
      query: {
        client_id: "client",
        redirect_uri: "https://client.example/callback",
      },
      user: { fbUserId: "user-a", email: null, name: "A" },
      tokens: [],
      activeName: null,
      apify: {
        registered: false,
        apifyUserId: null,
        apifyUsername: null,
        updatedAt: null,
      },
      readOnly: true,
    });
    expect(html).not.toContain("access_token");
    expect(html).not.toContain("register-system-token");
  });

  it("blocks Graph writes before any network request", async () => {
    setupTestToken();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new MetaApiClient({ mode: "read_only" });
    await expect(client.post("/act_1/campaigns", {})).rejects.toThrow(/read-only policy/);
    await expect(client.delete("/123")).rejects.toThrow(/read-only policy/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("binds a decrypted token and asset allowlist to one workspace", async () => {
    const repo = new InMemoryMetaTokenRepo();
    const bindingRepo = new InMemoryAssetBindingRepo();
    configureMetaTokenRepo(repo);
    configureAssetBindingRepo(bindingRepo);
    await saveToken({
      fbUserId: "workspace-a",
      workspaceId: "workspace-a",
      name: "personal",
      accessToken: "tenant-a-secret-token",
      kind: "user",
      expiresAt: null,
      scopes: ["ads_read"],
      allowedAccountIds: ["act_100"],
      allowedAssetIds: ["200"],
      metaUserId: "user-a",
      metaUserName: "A",
    });
    await saveAssetBinding({
      workspaceId: "workspace-a",
      kind: "ad_account",
      assetId: "act_100",
    });
    await saveAssetBinding({
      workspaceId: "workspace-a",
      kind: "page",
      assetId: "200",
    });

    const middleware = buildMetaTokenMiddleware(new URL("https://mcp.example"), true);
    const req = {
      headers: {},
      auth: { extra: { fbUserId: "user-a", workspaceId: "workspace-a" } },
    } as unknown as Request;
    const res = responseMock() as unknown as Response;
    const next = vi.fn(() => {
      expect(getAccessToken()).toBe("tenant-a-secret-token");
      expect(getTenantContext()?.workspaceId).toBe("workspace-a");
      expect(getTenantContext()?.allowedAccountIds.has("act_100")).toBe(true);
      expect(getTenantContext()?.allowedPageIds.has("200")).toBe(true);
    });
    await middleware(req, res, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();

    await repo.saveToken({
      fbUserId: "path-a",
      workspaceId: "workspace-b",
      name: "misbound",
      accessToken: "misbound-secret-token",
      kind: "user",
      expiresAt: null,
      scopes: ["ads_read"],
      metaUserId: "user-b",
      metaUserName: "B",
    });
    await expect(repo.resolveToken("path-a", "misbound")).rejects.toThrow(/not bound/);
  });

  it("intersects token assets with authoritative workspace bindings", async () => {
    const tokenRepo = new InMemoryMetaTokenRepo();
    const bindingRepo = new InMemoryAssetBindingRepo();
    configureMetaTokenRepo(tokenRepo);
    configureAssetBindingRepo(bindingRepo);
    await tokenRepo.saveToken({
      fbUserId: "workspace-a",
      workspaceId: "workspace-a",
      name: "personal",
      accessToken: "tenant-a-secret-token",
      kind: "user",
      expiresAt: null,
      scopes: ["ads_read"],
      allowedAccountIds: ["act_100", "act_999"],
      allowedAssetIds: ["200", "999"],
      metaUserId: "user-a",
      metaUserName: "A",
    });
    await bindingRepo.save({
      workspaceId: "workspace-a",
      kind: "ad_account",
      assetId: "100",
    });
    await bindingRepo.save({
      workspaceId: "workspace-a",
      kind: "page",
      assetId: "200",
    });
    await bindingRepo.save({
      workspaceId: "workspace-a",
      kind: "instagram",
      assetId: "not-present-in-token-snapshot",
    });

    const middleware = buildMetaTokenMiddleware(new URL("https://mcp.example"), true);
    const next = vi.fn(() => {
      const tenant = getTenantContext();
      expect([...tenant!.allowedAccountIds]).toEqual(["act_100"]);
      expect([...tenant!.allowedPageIds]).toEqual(["200"]);
      expect(tenant!.allowedAssetIds.has("999")).toBe(false);
      expect(tenant!.allowedInstagramIds.size).toBe(0);
    });
    await middleware(
      {
        headers: {},
        auth: { extra: { fbUserId: "user-a", workspaceId: "workspace-a" } },
      } as unknown as Request,
      responseMock() as unknown as Response,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("blocks cross-tenant account, child-object, parameter and /me reads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockFetchResponse({ account_id: "999" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new MetaApiClient({ mode: "read_only" });
    const tenantContext = {
      accessToken: "tenant-a-secret-token",
      fbUserId: "user-a",
      tenantId: "workspace-a",
      workspaceId: "workspace-a",
      allowedAccountIds: new Set(["act_100"]),
      allowedAssetIds: new Set(["200"]),
      allowedPageIds: new Set(["200"]),
      allowedInstagramIds: new Set<string>(),
    };

    await requestContext.run(tenantContext, async () => {
      await expect(client.get("/act_999", { fields: "id" })).rejects.toThrow(
        /not assigned/,
      );
      expect(fetchMock).not.toHaveBeenCalled();

      await expect(client.get("/me/adaccounts", { fields: "id" })).rejects.toThrow(
        /cannot use \/me/,
      );
      expect(fetchMock).not.toHaveBeenCalled();

      await expect(client.get("/300", { fields: "id" })).rejects.toThrow(
        /not assigned/,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fetchMock.mockClear();
      await expect(
        client.get("/act_100/generatepreviews", {
          creative: JSON.stringify({ object_story_spec: { page_id: "999" } }),
        }),
      ).rejects.toThrow(/not assigned/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects token headers and missing tenant identity on protected MCP requests", async () => {
    const middleware = buildMetaTokenMiddleware(new URL("https://mcp.example"), true);

    const headerRes = responseMock();
    await middleware(
      { headers: { "x-meta-token": "must-not-cross-http" } } as unknown as Request,
      headerRes as unknown as Response,
      vi.fn(),
    );
    expect(headerRes.status).toHaveBeenCalledWith(400);

    const anonymousRes = responseMock();
    await middleware(
      { headers: {} } as unknown as Request,
      anonymousRes as unknown as Response,
      vi.fn(),
    );
    expect(anonymousRes.status).toHaveBeenCalledWith(401);
  });

  it("protects every cookie-auth POST with a same-origin boundary", () => {
    const middleware = requireSameOriginPost("https://mcp.example");
    const blocked = responseMock();
    middleware(
      {
        method: "POST",
        path: "/logout",
        get: (name: string) => name === "origin" ? "https://evil.example" : undefined,
      } as unknown as Request,
      blocked as unknown as Response,
      vi.fn(),
    );
    expect(blocked.status).toHaveBeenCalledWith(403);

    const next = vi.fn();
    middleware(
      {
        method: "POST",
        path: "/logout",
        get: (name: string) => name === "origin" ? "https://mcp.example" : undefined,
      } as unknown as Request,
      responseMock() as unknown as Response,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("binds MCP authorization codes to redirect URI and workspace", async () => {
    const client: OAuthClientInformationFull = {
      client_id: "hardening-client",
      redirect_uris: ["https://client.example/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
    const issuerUrl = new URL("https://mcp.example");
    const resourceServerUrl = new URL("https://mcp.example/mcp");
    oauthProvider.configure({
      securityBinding: { issuerUrl, resourceServerUrl },
      resolvePendingAuth: () => ({ fbUserId: "user-a", workspaceId: "workspace-a" }),
    });
    const redirect = vi.fn();
    await oauthProvider.authorize(
      client,
      {
        redirectUri: "https://client.example/callback",
        codeChallenge: "challenge",
        state: "state",
        resource: resourceServerUrl,
      },
      { redirect } as unknown as Response,
    );
    const code = new URL(redirect.mock.calls[0][1] as string).searchParams.get("code")!;
    await expect(
      oauthProvider.exchangeAuthorizationCode(
        client,
        code,
        undefined,
        "https://evil.example/callback",
        resourceServerUrl,
      ),
    ).rejects.toThrow(/redirect_uri/);
  });

  it("introspects scopes without putting a token or app secret in the URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockFetchResponse({
          data: {
            app_id: "123456",
            user_id: "user-a",
            is_valid: true,
            scopes: ["ads_read"],
            expires_at: 2_000_000_000,
            data_access_expires_at: 2_000_000_000,
          },
        }),
      ),
    );
    await inspectReportingToken(
      {
        appId: "123456",
        appSecret: "app-secret-fixture",
        apiVersion: "v22.0",
        redirectUri: "https://mcp.example/auth/meta/callback",
      },
      "meta-token-fixture",
    );
    const [url, options] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("meta-token-fixture");
    expect(url).not.toContain("app-secret-fixture");
    expect(options.body).toContain("input_token=meta-token-fixture");
    expect(new Headers(options.headers).get("Authorization")).toContain("app-secret-fixture");
  });

  it("rejects expired Meta data access during token introspection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockFetchResponse({
          data: {
            app_id: "123456",
            user_id: "user-a",
            is_valid: true,
            scopes: ["ads_read"],
            expires_at: 2_000_000_000,
            data_access_expires_at: 1,
          },
        }),
      ),
    );

    await expect(
      inspectReportingToken(
        {
          appId: "123456",
          appSecret: "app-secret-fixture",
          apiVersion: "v22.0",
          redirectUri: "https://mcp.example/auth/meta/callback",
        },
        "meta-token-fixture",
      ),
    ).rejects.toThrow("data access has expired");
  });
});

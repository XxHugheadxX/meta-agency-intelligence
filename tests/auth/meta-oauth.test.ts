import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchPrimaryBusiness,
  inspectReportingToken,
  type MetaOAuthConfig,
} from "../../src/auth/meta-oauth.js";
import { mockFetchResponse } from "../setup.js";

describe("fetchPrimaryBusiness", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns id and name for the first business", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockFetchResponse({
        data: [{ id: "1234567890", name: "Acme Corp" }],
      }),
    );

    const result = await fetchPrimaryBusiness("token-x", "v22.0");
    expect(result).toEqual({ id: "1234567890", name: "Acme Corp" });

    const url = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(url).toContain("/v22.0/me/businesses");
    expect(url).toContain("fields=id%2Cname");
    expect(url).toContain("limit=1");
    expect(url).not.toContain("access_token");
    const options = vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit;
    expect(new Headers(options.headers).get("Authorization")).toBe("Bearer token-x");
  });

  it("returns null when the businesses list is empty", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockFetchResponse({ data: [] }),
    );

    const result = await fetchPrimaryBusiness("token-x");
    expect(result).toBeNull();
  });

  it("returns null when the API responds with an error (missing permission)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockFetchResponse(
        {
          error: {
            message:
              "(#200) Permissions error: business_management is required",
          },
        },
        { status: 400 },
      ),
    );

    const result = await fetchPrimaryBusiness("token-no-perm");
    expect(result).toBeNull();
  });

  it("returns null when the network call throws", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("network down"));

    const result = await fetchPrimaryBusiness("token-x");
    expect(result).toBeNull();
  });

  it("preserves the id and tolerates a missing name", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockFetchResponse({ data: [{ id: "9999" }] }),
    );

    const result = await fetchPrimaryBusiness("token-x");
    expect(result).toEqual({ id: "9999", name: null });
  });
});

describe("inspectReportingToken", () => {
  const config: MetaOAuthConfig = {
    appId: "app-123",
    appSecret: "app-secret",
    redirectUri: "https://mcp.example/auth/meta/callback",
    apiVersion: "v22.0",
  };

  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("validates and normalizes scopes, granular scopes, expiry, and asset ids", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockFetchResponse({
        data: {
          app_id: "app-123",
          user_id: "user-1",
          is_valid: true,
          scopes: ["pages_read_engagement", "ads_read"],
          granular_scopes: [
            { scope: "ads_read", target_ids: ["200", "100", "100"] },
            { scope: "pages_show_list", target_ids: ["page-1"] },
          ],
          expires_at: 2_000_000_000,
          data_access_expires_at: 2_100_000_000,
        },
      }),
    );

    const inspection = await inspectReportingToken(config, "meta-token");
    expect(inspection).toEqual({
      appId: "app-123",
      userId: "user-1",
      scopes: ["ads_read", "pages_read_engagement", "pages_show_list"],
      granularScopes: [
        { scope: "ads_read", targetIds: ["100", "200"] },
        { scope: "pages_show_list", targetIds: ["page-1"] },
      ],
      expiresAt: 2_000_000_000,
      dataAccessExpiresAt: 2_100_000_000,
      assetIds: ["100", "200", "page-1"],
    });

    const [requestUrl, options] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(requestUrl)).not.toContain("meta-token");
    expect(String(requestUrl)).not.toContain("app-secret");
    expect(new Headers(options?.headers).get("Authorization")).toBe(
      "Bearer app-123|app-secret",
    );
    expect(String(options?.body)).toContain("input_token=meta-token");
  });

  it("rejects a forbidden permission reported only in granular_scopes", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockFetchResponse({
        data: {
          app_id: "app-123",
          user_id: "user-1",
          is_valid: true,
          scopes: ["ads_read"],
          granular_scopes: [
            { scope: "ads_management", target_ids: ["100"] },
          ],
          expires_at: 2_000_000_000,
          data_access_expires_at: 2_100_000_000,
        },
      }),
    );

    await expect(inspectReportingToken(config, "meta-token")).rejects.toThrow(
      /forbidden write scope: ads_management/,
    );
  });

  it.each([
    ["missing owner", { user_id: undefined }],
    ["missing token expiry", { expires_at: undefined }],
    ["missing data-access expiry", { data_access_expires_at: undefined }],
    ["malformed granular scopes", { granular_scopes: {} }],
  ])("fails closed for %s", async (_label, override) => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockFetchResponse({
        data: {
          app_id: "app-123",
          user_id: "user-1",
          is_valid: true,
          scopes: ["ads_read"],
          granular_scopes: [],
          expires_at: 2_000_000_000,
          data_access_expires_at: 2_100_000_000,
          ...override,
        },
      }),
    );

    await expect(inspectReportingToken(config, "meta-token")).rejects.toThrow(
      /validation failed|invalid granular scopes/,
    );
  });
});

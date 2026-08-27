import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetKeyCacheForTests } from "../../src/auth/crypto.js";
import {
  InMemoryMetaTokenRepo,
  type MetaTokenRepo,
} from "../../src/store/meta-token-repo.js";
import * as metaOAuth from "../../src/auth/meta-oauth.js";

const ENCRYPTION_KEY = "a".repeat(64);
const APP_ID = "test-app";
const APP_SECRET = "test-secret";
const SERVER_URL = new URL("http://localhost:3000");

const profile = {
  id: "fb-1",
  name: "Alice",
  email: "alice@example.com",
  pictureUrl: null,
};

function makeInput(overrides: Partial<Parameters<MetaTokenRepo["saveToken"]>[0]> = {}) {
  return {
    fbUserId: "fb-1",
    name: "personal",
    accessToken: "EAA-secret-token",
    kind: "user" as const,
    expiresAt: Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60,
    metaUserId: "fb-1",
    metaUserName: "Alice",
    ...overrides,
  };
}

describe("InMemoryMetaTokenRepo", () => {
  let repo: InMemoryMetaTokenRepo;
  const originalKey = process.env.TOKEN_ENCRYPTION_KEY;
  const originalAppId = process.env.META_APP_ID;
  const originalAppSecret = process.env.META_APP_SECRET;

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = ENCRYPTION_KEY;
    process.env.META_APP_ID = APP_ID;
    process.env.META_APP_SECRET = APP_SECRET;
    resetKeyCacheForTests();
    repo = new InMemoryMetaTokenRepo();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = originalKey;
    if (originalAppId === undefined) delete process.env.META_APP_ID;
    else process.env.META_APP_ID = originalAppId;
    if (originalAppSecret === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = originalAppSecret;
    resetKeyCacheForTests();
    vi.restoreAllMocks();
  });

  it("upserts users and reads them back", async () => {
    await repo.upsertUser("fb-1", profile);
    const user = await repo.getUser("fb-1");
    expect(user).toMatchObject({
      email: "alice@example.com",
      name: "Alice",
    });
  });

  it("first saved token becomes default automatically", async () => {
    await repo.saveToken(makeInput({ name: "first" }));
    expect(await repo.getDefaultTokenName("fb-1")).toBe("first");

    await repo.saveToken(makeInput({ name: "second" }));
    expect(await repo.getDefaultTokenName("fb-1")).toBe("first");
  });

  it("setAsDefault swaps the active default", async () => {
    await repo.saveToken(makeInput({ name: "a" }));
    await repo.saveToken(makeInput({ name: "b", setAsDefault: true }));
    expect(await repo.getDefaultTokenName("fb-1")).toBe("b");

    const tokens = await repo.listTokens("fb-1");
    expect(tokens.find((t) => t.name === "a")?.isDefault).toBe(false);
    expect(tokens.find((t) => t.name === "b")?.isDefault).toBe(true);
  });

  it("setDefaultToken returns false when missing and switches when present", async () => {
    expect(await repo.setDefaultToken("fb-1", "missing")).toBe(false);
    await repo.saveToken(makeInput({ name: "a" }));
    await repo.saveToken(makeInput({ name: "b" }));
    expect(await repo.setDefaultToken("fb-1", "b")).toBe(true);
    expect(await repo.getDefaultTokenName("fb-1")).toBe("b");
  });

  it("deleteToken promotes another token when default is removed", async () => {
    await repo.saveToken(makeInput({ name: "a" }));
    await repo.saveToken(makeInput({ name: "b" }));
    expect(await repo.deleteToken("fb-1", "a")).toBe(true);
    expect(await repo.getDefaultTokenName("fb-1")).toBe("b");
  });

  it("getDecryptedToken returns the plaintext for system_user tokens without refresh", async () => {
    await repo.saveToken(
      makeInput({
        kind: "system_user",
        expiresAt: null,
        accessToken: "system-user-token",
        setAsDefault: true,
      }),
    );

    const plaintext = await repo.getDecryptedToken("fb-1");
    expect(plaintext).toBe("system-user-token");
  });

  it("returns plaintext when not within refresh window", async () => {
    const farFuture = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    await repo.saveToken(
      makeInput({ accessToken: "still-valid", expiresAt: farFuture }),
    );

    const spy = vi.spyOn(metaOAuth, "exchangeForLongLivedToken");
    const plaintext = await repo.getDecryptedToken("fb-1", "personal", SERVER_URL);
    expect(plaintext).toBe("still-valid");
    expect(spy).not.toHaveBeenCalled();
  });

  it("refreshes long-lived tokens within the refresh window", async () => {
    const soon = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    await repo.saveToken(makeInput({ accessToken: "old-token", expiresAt: soon }));

    vi.spyOn(metaOAuth, "exchangeForLongLivedToken").mockResolvedValueOnce({
      accessToken: "new-token",
      expiresAt: Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60,
    });
    vi.spyOn(metaOAuth, "inspectReportingToken").mockResolvedValueOnce({
      appId: APP_ID,
      userId: "fb-1",
      scopes: ["ads_read", "pages_read_engagement"],
      granularScopes: [
        { scope: "ads_read", targetIds: ["100"] },
        { scope: "pages_read_engagement", targetIds: ["page-1"] },
      ],
      expiresAt: Math.floor(Date.now() / 1000) + 50 * 24 * 60 * 60,
      dataAccessExpiresAt: Math.floor(Date.now() / 1000) + 80 * 24 * 60 * 60,
      assetIds: ["100", "page-1"],
    });
    vi.spyOn(metaOAuth, "fetchAccessibleAssets").mockResolvedValueOnce({
      accountIds: ["act_200"],
      assetIds: ["act_200", "page-2"],
    });

    const refreshed = await repo.resolveToken("fb-1", "personal", SERVER_URL);
    expect(refreshed).toMatchObject({
      accessToken: "new-token",
      scopes: ["ads_read", "pages_read_engagement"],
      granularScopes: [
        { scope: "ads_read", targetIds: ["100"] },
        { scope: "pages_read_engagement", targetIds: ["page-1"] },
      ],
      allowedAccountIds: ["act_100", "act_200"],
      allowedAssetIds: ["100", "act_200", "fb-1", "page-1", "page-2"],
    });
    expect(refreshed.dataAccessExpiresAt).toBeGreaterThan(0);

    const second = await repo.getDecryptedToken("fb-1", "personal", SERVER_URL);
    expect(second).toBe("new-token");
  });

  it("does not persist a refreshed Meta token when re-introspection fails", async () => {
    const soon = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    await repo.saveToken(
      makeInput({
        accessToken: "existing-token",
        expiresAt: soon,
        scopes: ["ads_read"],
        allowedAccountIds: ["act_existing"],
      }),
    );
    vi.spyOn(metaOAuth, "exchangeForLongLivedToken").mockResolvedValueOnce({
      accessToken: "unverified-new-token",
      expiresAt: soon + 1_000,
    });
    vi.spyOn(metaOAuth, "inspectReportingToken").mockRejectedValueOnce(
      new Error("forbidden scope"),
    );

    const resolved = await repo.resolveToken("fb-1", "personal", SERVER_URL);
    expect(resolved.accessToken).toBe("existing-token");
    expect(resolved.scopes).toEqual(["ads_read"]);
    expect(resolved.allowedAccountIds).toEqual(["act_existing"]);
  });

  it("returns existing plaintext when refresh fails but token is not yet expired", async () => {
    const soon = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    await repo.saveToken(makeInput({ accessToken: "still-good", expiresAt: soon }));

    vi.spyOn(metaOAuth, "exchangeForLongLivedToken").mockRejectedValueOnce(
      new Error("network error"),
    );

    const plaintext = await repo.getDecryptedToken("fb-1", "personal", SERVER_URL);
    expect(plaintext).toBe("still-good");
  });

  it("throws when refresh fails and the token is already expired", async () => {
    const expiredAt = Math.floor(Date.now() / 1000) - 60;
    await repo.saveToken(makeInput({ accessToken: "rotten", expiresAt: expiredAt }));

    vi.spyOn(metaOAuth, "exchangeForLongLivedToken").mockRejectedValueOnce(
      new Error("OAuthException: token expired"),
    );

    await expect(
      repo.getDecryptedToken("fb-1", "personal", SERVER_URL),
    ).rejects.toThrow(/expired and refresh failed/);
  });

  it("throws when no token is registered", async () => {
    await expect(repo.getDecryptedToken("fb-2")).rejects.toThrow(/No Meta token registered/);
  });

  it("throws when the named token does not exist", async () => {
    await repo.saveToken(makeInput({ name: "a" }));
    await expect(repo.getDecryptedToken("fb-1", "missing")).rejects.toThrow(
      /not found for this workspace/,
    );
  });

  it("persists businessId and businessName and exposes them in summaries", async () => {
    await repo.saveToken(
      makeInput({
        name: "client_acme",
        kind: "system_user",
        expiresAt: null,
        businessId: "1234567890",
        businessName: "Acme Corp",
      }),
    );

    const tokens = await repo.listTokens("fb-1");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      name: "client_acme",
      businessId: "1234567890",
      businessName: "Acme Corp",
    });
  });

  it("defaults businessId and businessName to null when not provided", async () => {
    await repo.saveToken(makeInput({ name: "no-bm" }));

    const tokens = await repo.listTokens("fb-1");
    expect(tokens[0].businessId).toBeNull();
    expect(tokens[0].businessName).toBeNull();
  });

  it("getDecryptedToken without a name resolves the current default after setDefaultToken (enables agent token pivoting)", async () => {
    await repo.saveToken(
      makeInput({
        name: "byads",
        kind: "system_user",
        expiresAt: null,
        accessToken: "byads-token",
        setAsDefault: true,
      }),
    );
    await repo.saveToken(
      makeInput({
        name: "personal",
        kind: "system_user",
        expiresAt: null,
        accessToken: "personal-token",
      }),
    );

    expect(await repo.getDecryptedToken("fb-1")).toBe("byads-token");

    expect(await repo.setDefaultToken("fb-1", "personal")).toBe(true);
    expect(await repo.getDecryptedToken("fb-1")).toBe("personal-token");

    expect(await repo.setDefaultToken("fb-1", "byads")).toBe(true);
    expect(await repo.getDecryptedToken("fb-1")).toBe("byads-token");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import { SignJWT } from "jose";
import {
  oauthProvider as rawOAuthProvider,
  resetOAuthProviderForTests,
} from "../../src/auth/oauth-provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

const original = process.env.OAUTH_SECRET;
const ISSUER = new URL("https://auth.example.com/");
const RESOURCE = new URL("https://mcp.example.com/mcp");
const REDIRECT_URI = "https://example.com/cb";

const oauthProvider = {
  configure: rawOAuthProvider.configure.bind(rawOAuthProvider),
  authorize(
    client: OAuthClientInformationFull,
    params: Parameters<typeof rawOAuthProvider.authorize>[1],
    res: Response,
  ) {
    return rawOAuthProvider.authorize(
      client,
      { ...params, resource: params.resource ?? RESOURCE },
      res,
    );
  },
  exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    verifier?: string,
    redirectUri: string = REDIRECT_URI,
    resource: URL = RESOURCE,
  ) {
    return rawOAuthProvider.exchangeAuthorizationCode(
      client,
      code,
      verifier,
      redirectUri,
      resource,
    );
  },
  exchangeRefreshToken: rawOAuthProvider.exchangeRefreshToken.bind(rawOAuthProvider),
  verifyAccessToken: rawOAuthProvider.verifyAccessToken.bind(rawOAuthProvider),
  revokeToken: rawOAuthProvider.revokeToken.bind(rawOAuthProvider),
};

const fakeClient: OAuthClientInformationFull = {
  client_id: "test-client",
  client_name: "Test",
  redirect_uris: [REDIRECT_URI],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  client_id_issued_at: Math.floor(Date.now() / 1000),
};

function fakeRes(): Response {
  const stub = {
    redirect: vi.fn(),
  } as unknown as Response;
  return stub;
}

describe("MetaAdsOAuthProvider", () => {
  beforeEach(() => {
    process.env.OAUTH_SECRET = "x".repeat(64);
    resetOAuthProviderForTests();
    oauthProvider.configure({
      securityBinding: { issuerUrl: ISSUER, resourceServerUrl: RESOURCE },
      resolvePendingAuth: () => ({ fbUserId: "fb-default" }),
    });
  });

  afterEach(() => {
    if (original === undefined) delete process.env.OAUTH_SECRET;
    else process.env.OAUTH_SECRET = original;
    resetOAuthProviderForTests();
  });

  it("issues a code that can be exchanged for tokens including fb_user_id (and never the token name)", async () => {
    oauthProvider.configure({
      resolvePendingAuth: () => ({ fbUserId: "fb-1234" }),
    });

    const res = fakeRes();
    await oauthProvider.authorize(
      fakeClient,
      {
        codeChallenge: "ch",
        codeChallengeMethod: "S256",
        redirectUri: "https://example.com/cb",
        scopes: [],
      },
      res,
    );

    expect((res.redirect as never as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
      1,
    );
    const redirected = (res.redirect as never as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as string;
    const url = new URL(redirected);
    const code = url.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokens = await oauthProvider.exchangeAuthorizationCode(
      fakeClient,
      code!,
    );
    expect(tokens.access_token).toBeTruthy();

    const authInfo = await oauthProvider.verifyAccessToken(tokens.access_token);
    expect(authInfo.clientId).toBe("test-client");
    expect((authInfo.extra as { fbUserId?: string } | undefined)?.fbUserId).toBe(
      "fb-1234",
    );
    expect(
      (authInfo.extra as Record<string, unknown> | undefined)?.metaTokenName,
    ).toBeUndefined();
    expect(authInfo.extra).toMatchObject({
      tenantId: "fb-1234",
      workspaceId: "fb-1234",
    });
    expect(authInfo.resource?.href).toBe(RESOURCE.href);
  });

  it("fails closed when issuer/resource configuration or tenant context is absent", async () => {
    resetOAuthProviderForTests();
    await expect(
      rawOAuthProvider.authorize(
        fakeClient,
        {
          codeChallenge: "ch",
          codeChallengeMethod: "S256",
          redirectUri: REDIRECT_URI,
          scopes: [],
          resource: RESOURCE,
        },
        fakeRes(),
      ),
    ).rejects.toThrow(/issuer and MCP resource/);

    rawOAuthProvider.configure({
      securityBinding: { issuerUrl: ISSUER, resourceServerUrl: RESOURCE },
    });
    await expect(
      rawOAuthProvider.authorize(
        fakeClient,
        {
          codeChallenge: "ch",
          codeChallengeMethod: "S256",
          redirectUri: REDIRECT_URI,
          scopes: [],
          resource: RESOURCE,
        },
        fakeRes(),
      ),
    ).rejects.toThrow(/tenant context/);
  });

  it("rejects an authorization request for a different or omitted resource", async () => {
    await expect(
      rawOAuthProvider.authorize(
        fakeClient,
        {
          codeChallenge: "ch",
          codeChallengeMethod: "S256",
          redirectUri: REDIRECT_URI,
          scopes: [],
          resource: new URL("https://other.example/mcp"),
        },
        fakeRes(),
      ),
    ).rejects.toThrow(/resource/);

    await expect(
      rawOAuthProvider.authorize(
        fakeClient,
        {
          codeChallenge: "ch",
          codeChallengeMethod: "S256",
          redirectUri: REDIRECT_URI,
          scopes: [],
        },
        fakeRes(),
      ),
    ).rejects.toThrow(/resource/);
  });

  it("rejects auth code that was issued to a different client", async () => {
    const res = fakeRes();
    await oauthProvider.authorize(
      fakeClient,
      {
        codeChallenge: "ch",
        codeChallengeMethod: "S256",
        redirectUri: "https://example.com/cb",
        scopes: [],
      },
      res,
    );
    const code = new URL(
      (res.redirect as never as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).searchParams.get("code")!;

    const otherClient: OAuthClientInformationFull = {
      ...fakeClient,
      client_id: "other-client",
    };

    await expect(
      oauthProvider.exchangeAuthorizationCode(otherClient, code),
    ).rejects.toThrow(/different client/);
  });

  it("CODE-A1: code consume() is single-use under concurrent exchange (race fix)", async () => {
    const res = fakeRes();
    await oauthProvider.authorize(
      fakeClient,
      {
        codeChallenge: "ch",
        codeChallengeMethod: "S256",
        redirectUri: "https://example.com/cb",
        scopes: [],
      },
      res,
    );
    const code = new URL(
      (res.redirect as never as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).searchParams.get("code")!;

    // Two concurrent exchanges race. With the atomic consume(), exactly
    // one wins.
    const settled = await Promise.allSettled([
      oauthProvider.exchangeAuthorizationCode(fakeClient, code),
      oauthProvider.exchangeAuthorizationCode(fakeClient, code),
    ]);
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(
      /Invalid authorization code/,
    );
  });

  it("CODE-C3: rejects mismatched PKCE verifier when supplied", async () => {
    const verifier = "a".repeat(64);
    const challenge = (await import("node:crypto"))
      .createHash("sha256")
      .update(verifier)
      .digest("base64url");

    const res = fakeRes();
    await oauthProvider.authorize(
      fakeClient,
      {
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        redirectUri: "https://example.com/cb",
        scopes: [],
      },
      res,
    );
    const code = new URL(
      (res.redirect as never as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).searchParams.get("code")!;

    await expect(
      oauthProvider.exchangeAuthorizationCode(
        fakeClient,
        code,
        "wrong-verifier",
      ),
    ).rejects.toThrow(/PKCE verification failed/);
  });

  it("CODE-C3: accepts a matching PKCE verifier", async () => {
    const verifier = "b".repeat(64);
    const challenge = (await import("node:crypto"))
      .createHash("sha256")
      .update(verifier)
      .digest("base64url");

    const res = fakeRes();
    await oauthProvider.authorize(
      fakeClient,
      {
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        redirectUri: "https://example.com/cb",
        scopes: [],
      },
      res,
    );
    const code = new URL(
      (res.redirect as never as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).searchParams.get("code")!;

    const tokens = await oauthProvider.exchangeAuthorizationCode(
      fakeClient,
      code,
      verifier,
    );
    expect(tokens.access_token).toBeTruthy();
  });

  it("CODE-A2: refresh token can only be used once (rotation)", async () => {
    oauthProvider.configure({
      resolvePendingAuth: () => ({ fbUserId: "fb-rotate" }),
    });
    const res = fakeRes();
    await oauthProvider.authorize(
      fakeClient,
      {
        codeChallenge: "ch",
        codeChallengeMethod: "S256",
        redirectUri: "https://example.com/cb",
        scopes: [],
      },
      res,
    );
    const code = new URL(
      (res.redirect as never as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).searchParams.get("code")!;
    const tokens = await oauthProvider.exchangeAuthorizationCode(
      fakeClient,
      code,
    );

    // First refresh succeeds and rotates the jti.
    const refreshed = await oauthProvider.exchangeRefreshToken(
      fakeClient,
      tokens.refresh_token!,
    );
    expect(refreshed.access_token).toBeTruthy();

    // Same refresh token again must fail (jti deleted on rotation).
    await expect(
      oauthProvider.exchangeRefreshToken(fakeClient, tokens.refresh_token!),
    ).rejects.toThrow(/revoked|already used/i);
  });

  it("CODE-A2: refresh-token rotation is atomic under concurrent exchange", async () => {
    // Two concurrent exchanges of the same refresh token must produce
    // exactly one fulfilled and one rejected. Without atomic consume,
    // both would see has=true before either delete and both would mint
    // new pairs (replay window).
    const res = fakeRes();
    await oauthProvider.authorize(
      fakeClient,
      {
        codeChallenge: "ch",
        codeChallengeMethod: "S256",
        redirectUri: "https://example.com/cb",
        scopes: [],
      },
      res,
    );
    const code = new URL(
      (res.redirect as never as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).searchParams.get("code")!;
    const tokens = await oauthProvider.exchangeAuthorizationCode(
      fakeClient,
      code,
    );

    const settled = await Promise.allSettled([
      oauthProvider.exchangeRefreshToken(fakeClient, tokens.refresh_token!),
      oauthProvider.exchangeRefreshToken(fakeClient, tokens.refresh_token!),
    ]);
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(
      /revoked|already used/i,
    );
  });

  it("CODE-A2: revokeToken invalidates the refresh token (RFC 7009)", async () => {
    const res = fakeRes();
    await oauthProvider.authorize(
      fakeClient,
      {
        codeChallenge: "ch",
        codeChallengeMethod: "S256",
        redirectUri: "https://example.com/cb",
        scopes: [],
      },
      res,
    );
    const code = new URL(
      (res.redirect as never as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).searchParams.get("code")!;
    const tokens = await oauthProvider.exchangeAuthorizationCode(
      fakeClient,
      code,
    );

    await oauthProvider.revokeToken(fakeClient, {
      token: tokens.refresh_token!,
    });

    await expect(
      oauthProvider.exchangeRefreshToken(fakeClient, tokens.refresh_token!),
    ).rejects.toThrow(/revoked|already used/i);
  });

  it("CODE-M7: rejects an access token offered as a refresh token (audience separation)", async () => {
    const res = fakeRes();
    await oauthProvider.authorize(
      fakeClient,
      {
        codeChallenge: "ch",
        codeChallengeMethod: "S256",
        redirectUri: "https://example.com/cb",
        scopes: [],
      },
      res,
    );
    const code = new URL(
      (res.redirect as never as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).searchParams.get("code")!;
    const tokens = await oauthProvider.exchangeAuthorizationCode(
      fakeClient,
      code,
    );

    // Pass the access token where a refresh is expected.
    await expect(
      oauthProvider.exchangeRefreshToken(fakeClient, tokens.access_token),
    ).rejects.toThrow(/Invalid refresh token/);
  });

  it("CODE-M7: rejects a refresh token offered as an access token (audience separation)", async () => {
    const res = fakeRes();
    await oauthProvider.authorize(
      fakeClient,
      {
        codeChallenge: "ch",
        codeChallengeMethod: "S256",
        redirectUri: "https://example.com/cb",
        scopes: [],
      },
      res,
    );
    const code = new URL(
      (res.redirect as never as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).searchParams.get("code")!;
    const tokens = await oauthProvider.exchangeAuthorizationCode(
      fakeClient,
      code,
    );

    // Pass the refresh token where an access verifier is expected.
    await expect(
      oauthProvider.verifyAccessToken(tokens.refresh_token!),
    ).rejects.toThrow(/Invalid access token/);
  });

  it("verifyAccessToken rejects malformed tokens with InvalidTokenError (SDK maps to 401)", async () => {
    await expect(
      oauthProvider.verifyAccessToken("not-a-jwt"),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("verifyAccessToken rejects expired tokens with InvalidTokenError (SDK maps to 401)", async () => {
    const secret = new TextEncoder().encode("x".repeat(64));
    const expired = await new SignJWT({
      sub: "test-client",
      type: "access",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(0)
      .setExpirationTime(1)
      .setAudience("mcp-oauth-access")
      .sign(secret);

    await expect(oauthProvider.verifyAccessToken(expired)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  it("verifyAccessToken rejects wrong-audience tokens with InvalidTokenError", async () => {
    const secret = new TextEncoder().encode("x".repeat(64));
    const now = Math.floor(Date.now() / 1000);
    const wrongAudience = await new SignJWT({
      sub: "test-client",
      type: "access",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setAudience("some-other-audience")
      .sign(secret);

    await expect(
      oauthProvider.verifyAccessToken(wrongAudience),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("verifyAccessToken rejects wrong issuer and missing tenant claims", async () => {
    const secret = new TextEncoder().encode("x".repeat(64));
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      sub: "test-client",
      type: "access",
      resource: RESOURCE.href,
      fb_user_id: "fb-1",
      tenant_id: "tenant-1",
      workspace_id: "workspace-1",
    };
    const wrongIssuer = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setIssuer("https://evil.example/")
      .setAudience(RESOURCE.href)
      .sign(secret);
    await expect(
      oauthProvider.verifyAccessToken(wrongIssuer),
    ).rejects.toBeInstanceOf(InvalidTokenError);

    const missingTenant = await new SignJWT({
      sub: "test-client",
      type: "access",
      resource: RESOURCE.href,
      fb_user_id: "fb-1",
      workspace_id: "workspace-1",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setIssuer(ISSUER.href)
      .setAudience(RESOURCE.href)
      .sign(secret);
    await expect(
      oauthProvider.verifyAccessToken(missingTenant),
    ).rejects.toThrow(/tenant context/);
  });

  it("exchangeRefreshToken rejects invalid tokens with InvalidGrantError", async () => {
    await expect(
      oauthProvider.exchangeRefreshToken(fakeClient, "not-a-jwt"),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("exchangeAuthorizationCode rejects unknown codes with InvalidGrantError", async () => {
    await expect(
      oauthProvider.exchangeAuthorizationCode(fakeClient, "does-not-exist"),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("preserves fb_user_id across refresh-token exchange (token name is never in the JWT)", async () => {
    oauthProvider.configure({
      resolvePendingAuth: () => ({ fbUserId: "fb-9999" }),
    });
    const res = fakeRes();
    await oauthProvider.authorize(
      fakeClient,
      {
        codeChallenge: "ch",
        codeChallengeMethod: "S256",
        redirectUri: "https://example.com/cb",
        scopes: [],
      },
      res,
    );
    const code = new URL(
      (res.redirect as never as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).searchParams.get("code")!;
    const tokens = await oauthProvider.exchangeAuthorizationCode(
      fakeClient,
      code,
    );

    const refreshed = await oauthProvider.exchangeRefreshToken(
      fakeClient,
      tokens.refresh_token!,
    );
    const authInfo = await oauthProvider.verifyAccessToken(refreshed.access_token);
    expect((authInfo.extra as { fbUserId?: string } | undefined)?.fbUserId).toBe(
      "fb-9999",
    );
    expect(
      (authInfo.extra as Record<string, unknown> | undefined)?.metaTokenName,
    ).toBeUndefined();
    expect(authInfo.extra).toMatchObject({
      tenantId: "fb-9999",
      workspaceId: "fb-9999",
    });
    expect(authInfo.resource?.href).toBe(RESOURCE.href);
  });

  it("rejects a refresh request that tries to switch resources", async () => {
    const res = fakeRes();
    await oauthProvider.authorize(
      fakeClient,
      {
        codeChallenge: "ch",
        codeChallengeMethod: "S256",
        redirectUri: REDIRECT_URI,
        scopes: [],
      },
      res,
    );
    const code = new URL(
      (res.redirect as never as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).searchParams.get("code")!;
    const tokens = await oauthProvider.exchangeAuthorizationCode(fakeClient, code);

    await expect(
      oauthProvider.exchangeRefreshToken(
        fakeClient,
        tokens.refresh_token!,
        undefined,
        new URL("https://other.example/mcp"),
      ),
    ).rejects.toThrow(/resource/);
  });
});

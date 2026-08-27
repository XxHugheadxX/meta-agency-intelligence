import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { logger } from "../utils/logger.js";
import { hashPii } from "./token-store.js";
import {
  InMemoryAuthCodesStore,
  type AuthCodesStore,
} from "../store/persistent-auth-codes.js";
import { InMemoryClientsStore } from "../store/persistent-clients-store.js";
import {
  InMemoryJtiStore,
  type JtiStore,
} from "../store/persistent-jti-store.js";

// Audience separation (CODE-M7): every JWT we mint is tagged with its
// purpose. Verifiers pin the audience so an attacker can't smuggle a
// session JWT into the access-token slot or vice versa, even if a single
// secret rotates and starts being shared. Combined with `type` claim
// checks already in place, this is belt-and-braces.
const REFRESH_AUDIENCE = "mcp-oauth-refresh";

export interface OAuthSecurityBinding {
  issuerUrl: URL;
  resourceServerUrl: URL;
}

let cachedSecret: Uint8Array | undefined;

function getJwtSecret(): Uint8Array {
  if (cachedSecret) return cachedSecret;

  const secret = process.env.OAUTH_SECRET;
  if (secret) {
    cachedSecret = new TextEncoder().encode(secret);
    return cachedSecret;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("OAUTH_SECRET environment variable is required in production");
  }

  logger.warn("OAUTH_SECRET not set; generating random secret (tokens won't survive restart)");
  const randomSecret = crypto.randomBytes(32).toString("hex");
  process.env.OAUTH_SECRET = randomSecret;
  cachedSecret = new TextEncoder().encode(randomSecret);
  return cachedSecret;
}

export interface PendingAuthSession {
  fbUserId: string;
  tenantId?: string;
  workspaceId?: string;
}

export class MetaAdsOAuthProvider implements OAuthServerProvider {
  private clientsStoreImpl: OAuthRegisteredClientsStore = new InMemoryClientsStore();
  private authCodesImpl: AuthCodesStore = new InMemoryAuthCodesStore();
  private refreshJtiStoreImpl: JtiStore = new InMemoryJtiStore();
  private pendingAuthResolver: () => PendingAuthSession | null = () => null;
  private issuer: string | null = null;
  private expectedResource: string | null = null;

  configure(opts: {
    clientsStore?: OAuthRegisteredClientsStore;
    authCodesStore?: AuthCodesStore;
    refreshJtiStore?: JtiStore;
    resolvePendingAuth?: () => PendingAuthSession | null;
    securityBinding?: OAuthSecurityBinding | null;
  }): void {
    if (opts.clientsStore) this.clientsStoreImpl = opts.clientsStore;
    if (opts.authCodesStore) this.authCodesImpl = opts.authCodesStore;
    if (opts.refreshJtiStore) this.refreshJtiStoreImpl = opts.refreshJtiStore;
    if (opts.resolvePendingAuth) this.pendingAuthResolver = opts.resolvePendingAuth;
    if (opts.securityBinding === null) {
      this.issuer = null;
      this.expectedResource = null;
    } else if (opts.securityBinding) {
      this.issuer = opts.securityBinding.issuerUrl.href;
      this.expectedResource = opts.securityBinding.resourceServerUrl.href;
    }
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.clientsStoreImpl;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const binding = this.requireSecurityBinding();
    const code = crypto.randomBytes(32).toString("hex");
    const pending = this.pendingAuthResolver();
    const tenantId = pending?.tenantId ?? pending?.workspaceId ?? pending?.fbUserId;
    const workspaceId = pending?.workspaceId ?? pending?.tenantId ?? pending?.fbUserId;
    if (!pending?.fbUserId || !tenantId || !workspaceId) {
      throw new InvalidGrantError("Authenticated tenant context is required");
    }
    if (!params.resource || params.resource.href !== binding.resource) {
      throw new InvalidGrantError("resource does not match the configured MCP resource");
    }

    await this.authCodesImpl.set(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      resource: params.resource?.href,
      fbUserId: pending?.fbUserId,
      tenantId,
      workspaceId,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (params.state) {
      redirectUrl.searchParams.set("state", params.state);
    }

    logger.info(
      { clientId: client.client_id, principal: hashPii(pending?.fbUserId) },
      "Authorization code issued",
    );
    res.redirect(302, redirectUrl.toString());
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const entry = await this.authCodesImpl.get(authorizationCode);
    if (!entry) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    if (entry.clientId !== client.client_id) {
      throw new InvalidGrantError(
        "Authorization code was issued to a different client",
      );
    }
    if (entry.expiresAt < Math.floor(Date.now() / 1000)) {
      await this.authCodesImpl.delete(authorizationCode);
      throw new InvalidGrantError("Authorization code has expired");
    }
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const binding = this.requireSecurityBinding();
    // Atomic get-and-delete: under concurrent exchange requests, only the
    // first caller sees the entry. RFC 6749 §10.5: codes must be single-use.
    const entry = await this.authCodesImpl.consume(authorizationCode);
    if (!entry) {
      throw new InvalidGrantError("Invalid authorization code");
    }

    if (entry.clientId !== client.client_id) {
      throw new InvalidGrantError(
        "Authorization code was issued to a different client",
      );
    }
    if (entry.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidGrantError("Authorization code has expired");
    }
    if (!redirectUri || redirectUri !== entry.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match authorization request");
    }
    if (
      !resource ||
      resource.href !== binding.resource ||
      entry.resource !== binding.resource
    ) {
      throw new InvalidGrantError("resource does not match the configured MCP resource");
    }
    if (!entry.fbUserId || !entry.tenantId || !entry.workspaceId) {
      throw new InvalidGrantError("Authorization code is missing tenant context");
    }

    // Defense-in-depth PKCE check. mcp-sdk's primary verification happens
    // upstream via challengeForAuthorizationCode; we re-verify here when
    // the verifier is supplied so the guarantee survives any future
    // change in how mcp-sdk wires the calls. We don't *require* the
    // verifier in this method (the SDK's flow sometimes passes it,
    // sometimes hands the challenge upward), but if it's present it must
    // match.
    if (entry.codeChallenge && codeVerifier) {
      const computed = crypto
        .createHash("sha256")
        .update(codeVerifier)
        .digest("base64url");
      if (computed !== entry.codeChallenge) {
        throw new InvalidGrantError("PKCE verification failed");
      }
    }

    return this.generateTokens({
      clientId: client.client_id,
      resource,
      fbUserId: entry.fbUserId,
      tenantId: entry.tenantId,
      workspaceId: entry.workspaceId,
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const secret = getJwtSecret();
    const binding = this.requireSecurityBinding();

    const { payload } = await jwtVerify(refreshToken, secret, {
      algorithms: ["HS256"],
      audience: REFRESH_AUDIENCE,
      issuer: binding.issuer,
    }).catch(() => {
      throw new InvalidGrantError("Invalid refresh token");
    });

    if (payload.type !== "refresh") {
      throw new InvalidGrantError("Token is not a refresh token");
    }
    if (payload.sub !== client.client_id) {
      throw new InvalidGrantError(
        "Refresh token was issued to a different client",
      );
    }
    if (payload.resource !== binding.resource) {
      throw new InvalidGrantError("Refresh token is not bound to the configured MCP resource");
    }
    if (resource && resource.href !== binding.resource) {
      throw new InvalidGrantError("resource does not match refresh token");
    }
    const fbUserId = typeof payload.fb_user_id === "string" ? payload.fb_user_id : null;
    const tenantId = typeof payload.tenant_id === "string" ? payload.tenant_id : null;
    const workspaceId =
      typeof payload.workspace_id === "string" ? payload.workspace_id : null;
    if (!fbUserId || !tenantId || !workspaceId) {
      throw new InvalidGrantError("Refresh token is missing tenant context");
    }
    // jti must be present in the allow-list — i.e. issued by us, not yet
    // revoked, and not yet rotated. Old tokens issued before this code
    // existed don't carry a jti and would be rejected here, which is the
    // intended behaviour after rolling out the change.
    const jti = typeof payload.jti === "string" ? payload.jti : null;
    if (!jti) {
      throw new InvalidGrantError("Refresh token missing jti");
    }
    // Atomic consume: under concurrent refresh requests with the same
    // token, only one wins. Without this, has()+delete() were two
    // separate calls, leaving a replay window across instances backed by
    // Firestore (and breaking the rotation guarantee in-memory under
    // sufficient async interleaving). Even if generateTokens fails after
    // this, the worst case is the user has to re-authorize.
    if (!(await this.refreshJtiStoreImpl.consume(jti))) {
      throw new InvalidGrantError(
        "Refresh token has been revoked or already used",
      );
    }

    return this.generateTokens({
      clientId: client.client_id,
      resource: new URL(binding.resource),
      fbUserId,
      tenantId,
      workspaceId,
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const secret = getJwtSecret();
    const binding = this.requireSecurityBinding();

    // Throw the SDK's typed error so requireBearerAuth responds with
    // 401 + WWW-Authenticate (triggering the client's refresh flow).
    // A plain Error here falls through to the SDK's generic 500 path,
    // which leaves clients stuck pretending the server is down once
    // their 1h access token expires.
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      audience: binding.resource,
      issuer: binding.issuer,
    }).catch(() => {
      throw new InvalidTokenError("Invalid access token");
    });

    if (payload.type !== "access") {
      throw new InvalidTokenError("Token is not an access token");
    }
    if (payload.resource !== binding.resource) {
      throw new InvalidTokenError("Access token is not bound to the configured MCP resource");
    }
    if (
      typeof payload.sub !== "string" ||
      typeof payload.fb_user_id !== "string" ||
      typeof payload.tenant_id !== "string" ||
      typeof payload.workspace_id !== "string"
    ) {
      throw new InvalidTokenError("Access token is missing tenant context");
    }

    const extra: Record<string, unknown> = {
      fbUserId: payload.fb_user_id,
      tenantId: payload.tenant_id,
      workspaceId: payload.workspace_id,
    };

    const authInfo: AuthInfo = {
      token,
      clientId: payload.sub,
      scopes: [],
      expiresAt: payload.exp,
      extra,
    };
    authInfo.resource = new URL(binding.resource);
    return authInfo;
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    // RFC 7009: best-effort revoke. We can only revoke refresh tokens (the
    // ones we track jtis for). Access tokens are 1h TTL and stateless.
    const token = request.token;
    if (!token) return;
    try {
      const { payload } = await jwtVerify(token, getJwtSecret(), {
        algorithms: ["HS256"],
        audience: REFRESH_AUDIENCE,
        issuer: this.requireSecurityBinding().issuer,
      });
      if (payload.type === "refresh" && typeof payload.jti === "string") {
        await this.refreshJtiStoreImpl.delete(payload.jti);
        logger.info({ jti: payload.jti }, "Refresh token revoked");
      }
    } catch {
      // Silently ignore — RFC 7009 §2.2: revocation responses must succeed
      // even on unrecognised tokens. Tokens that aren't a refresh JWT fall
      // through here and we treat them as already revoked / unknown.
    }
  }

  private async generateTokens(input: {
    clientId: string;
    resource: URL;
    fbUserId: string;
    tenantId: string;
    workspaceId: string;
  }): Promise<OAuthTokens> {
    const secret = getJwtSecret();
    const binding = this.requireSecurityBinding();
    if (input.resource.href !== binding.resource) {
      throw new InvalidGrantError("resource does not match the configured MCP resource");
    }
    const now = Math.floor(Date.now() / 1000);

    const claims: Record<string, unknown> = {
      sub: input.clientId,
      type: "access",
      resource: binding.resource,
      fb_user_id: input.fbUserId,
      tenant_id: input.tenantId,
      workspace_id: input.workspaceId,
    };

    const accessToken = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .setIssuer(binding.issuer)
      .setAudience(binding.resource)
      .sign(secret);

    // Refresh tokens carry a jti recorded in the refresh allow-list.
    // Exchange-refresh deletes the jti before minting a new pair (rotation),
    // and revokeToken can wipe it on demand.
    const refreshJti = crypto.randomBytes(16).toString("hex");
    const refreshExpiresAt = now + 30 * 24 * 3600;
    const refreshClaims: Record<string, unknown> = {
      sub: input.clientId,
      type: "refresh",
      jti: refreshJti,
      resource: binding.resource,
      fb_user_id: input.fbUserId,
      tenant_id: input.tenantId,
      workspace_id: input.workspaceId,
    };

    const refreshToken = await new SignJWT(refreshClaims)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(refreshExpiresAt)
      .setIssuer(binding.issuer)
      .setAudience(REFRESH_AUDIENCE)
      .sign(secret);

    await this.refreshJtiStoreImpl.put(refreshJti, {
      expiresAt: refreshExpiresAt,
      meta: {
        clientId: input.clientId,
        fbUserId: input.fbUserId,
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
      },
    });

    logger.info(
      { clientId: input.clientId, principal: hashPii(input.fbUserId) },
      "Tokens issued",
    );

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
    };
  }

  private requireSecurityBinding(): { issuer: string; resource: string } {
    if (!this.issuer || !this.expectedResource) {
      throw new Error("OAuth issuer and MCP resource must be configured");
    }
    return { issuer: this.issuer, resource: this.expectedResource };
  }
}

export const oauthProvider: MetaAdsOAuthProvider = new MetaAdsOAuthProvider();

export function resetOAuthProviderForTests(): void {
  cachedSecret = undefined;
  oauthProvider.configure({
    clientsStore: new InMemoryClientsStore(),
    authCodesStore: new InMemoryAuthCodesStore(),
    refreshJtiStore: new InMemoryJtiStore(),
    resolvePendingAuth: () => null,
    securityBinding: null,
  });
}

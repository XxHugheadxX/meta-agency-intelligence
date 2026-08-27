import express from "express";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  fetchAccessibleAssets,
  fetchPrimaryBusiness,
  fetchProfile,
  inspectReportingToken,
  loadMetaOAuthConfig,
  type MetaOAuthConfig,
} from "../auth/meta-oauth.js";
import { isAllowed } from "../auth/email-allowlist.js";
import { clearSession, getSession, setSession } from "../auth/session.js";
import { consumeCsrfToken, issueCsrfToken } from "../auth/csrf.js";
import {
  generateOAuthStateNonce,
  signOAuthState,
  verifyOAuthState,
} from "../auth/oauth-state.js";
import {
  deleteToken,
  getDefaultTokenName,
  listTokens,
  saveToken,
  setDefaultToken,
  upsertUser,
} from "../store/meta-token-repo.js";
import { logger } from "../utils/logger.js";
import { escapeHtml } from "../utils/html.js";
import { hashToken } from "../auth/token-store.js";
import { getApifyTokenRepo } from "../store/apify-token-repo.js";
import { ApifyApiClient } from "../apify/client.js";
import type { ApifyEnvelope, ApifyUser } from "../apify/types.js";
import { CONNECTIONS_PATH, renderConnectionsPage } from "./html-pages.js";

const STANDALONE_RETURN_PATHS = new Set<string>([CONNECTIONS_PATH]);

/**
 * Short timeout and no retries, unlike the shared `apifyApiClient` singleton
 * (30s / 3 retries): this runs inside a user-facing request, so a stalling
 * api.apify.com must not hold the connection for minutes.
 */
const apifyValidationClient = new ApifyApiClient({ timeout: 10_000, maxRetries: 0 });

/**
 * SameSite=Lax blocks a cross-site POST, but "same-site" is not "same-origin":
 * on a custom domain a sibling subdomain could still forge one, and swapping a
 * tenant's Apify token for the attacker's would silently redirect their scrapes.
 *
 * Fetch Metadata is the primary signal because it needs no configuration. The
 * Origin fallback is compared against the origin the browser actually contacted
 * rather than SERVER_URL, so a misconfigured env cannot lock legitimate users
 * out.
 *
 * Requests with neither signal fail closed. Browser compatibility is secondary
 * to preventing an ambient session cookie from authorizing an unverifiable
 * state-changing request.
 */
export function isSameOriginRequest(headers: {
  secFetchSite?: string | null;
  origin?: string | null;
  selfOrigin: string;
}): boolean {
  if (headers.secFetchSite) return headers.secFetchSite === "same-origin";
  if (!headers.origin) return false;
  try {
    return new URL(headers.origin).origin === headers.selfOrigin;
  } catch {
    return false;
  }
}

function isSameOriginPost(req: express.Request): boolean {
  return isSameOriginRequest({
    secFetchSite: req.get("sec-fetch-site"),
    origin: req.get("origin"),
    selfOrigin: `${req.protocol}://${req.get("host")}`,
  });
}

export type ApifyTokenInputResult =
  | { ok: true; token: string }
  | { ok: false; reason: "empty" | "too-short" | "too-long" | "illegal-chars" };

/**
 * The token is interpolated into an `Authorization: Bearer` header, so an
 * embedded CR/LF is a header-injection attempt. Reject the whole class of
 * control characters and inner whitespace rather than relying on the HTTP
 * client to notice. The `apify_api_` prefix is deliberately not required —
 * Apify may change the format, and /v2/users/me is the real authority.
 */
export function validateApifyTokenInput(input: unknown): ApifyTokenInputResult {
  if (typeof input !== "string") return { ok: false, reason: "empty" };
  const token = input.trim();
  if (token.length === 0) return { ok: false, reason: "empty" };
  if (token.length < 10) return { ok: false, reason: "too-short" };
  if (token.length > 200) return { ok: false, reason: "too-long" };
  if (/[\s\x00-\x1f\x7f]/.test(token)) return { ok: false, reason: "illegal-chars" };
  return { ok: true, token };
}
import { hashPii } from "../auth/token-store.js";
import { validateAuthorizeQuery } from "./authorize-validation.js";

const OAUTH_STATE_COOKIE_NAME =
  process.env.NODE_ENV === "production" ? "__Host-meta_oauth_state" : "meta_oauth_state";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Sanitize a returnTo URL provided by callers (?return=… on /auth/meta).
 *
 * Defenses (CODE-M3):
 *   - must start with a single "/" (no scheme, no protocol-relative "//")
 *   - max length 2048 (avoid header smuggling and absurdly large redirects)
 *   - control characters (CR, LF, NUL, etc.) rejected — prevents response
 *     splitting / header injection if this ever ends up in a Location header
 *     unencoded by a downstream proxy
 *   - if it points at /authorize, the query must carry both client_id and
 *     redirect_uri (otherwise it's the same dead-end the validation gate
 *     guards against, just reached via a redirect chain)
 *
 * On any failure, fall back to "/authorize" — the landing page handles
 * unauthenticated users.
 */
export type SafeReturnFallback = "/authorize" | typeof CONNECTIONS_PATH;

/**
 * `fallback` is a literal union on purpose: a caller can never route a user to
 * an attacker-supplied destination by widening it.
 */
export function safeReturnTo(
  input: unknown,
  fallback: SafeReturnFallback = "/authorize",
): string {
  if (typeof input !== "string") return fallback;
  if (input.length === 0 || input.length > 2048) return fallback;
  if (!input.startsWith("/")) return fallback;
  if (input.startsWith("//")) return fallback;
  // Browsers and the WHATWG URL parser normalize "\" to "/" for special
  // schemes, so "/\evil.example/x" becomes protocol-relative and escapes to an
  // external host. Rejecting the character outright is simpler than trying to
  // out-guess every normalization step.
  if (input.includes("\\")) return fallback;
  // Reject control characters (0x00–0x1f and DEL).
  if (/[\x00-\x1f\x7f]/.test(input)) return fallback;

  // If returnTo points at /authorize, make sure it has the OAuth params
  // the GET handler now requires. A path like "/authorize" alone is
  // valid and renders the landing page; anything matching "/authorize?…"
  // must carry both client_id and redirect_uri.
  if (input === "/authorize" || input.startsWith("/authorize?")) {
    const qIdx = input.indexOf("?");
    if (qIdx === -1) return input; // bare /authorize → landing page is fine
    const params = new URLSearchParams(input.slice(qIdx + 1));
    if (!params.get("client_id") || !params.get("redirect_uri")) {
      return fallback;
    }
  }
  return input;
}

function renderError(res: express.Response, status: number, message: string): void {
  // Restrictive CSP on every server-rendered HTML page (CODE-B3): even
  // though renderError only emits inline <style>, pinning the policy
  // limits the blast radius if user-controlled content ever leaks
  // through escapeHtml in the future.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  );
  res.status(status).type("html").send(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Auth error</title>
    <style>body{background:#0f0f0f;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
    .card{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:2.5rem;max-width:420px;text-align:center}
    h1{color:#fca5a5;margin:0 0 0.5rem}p{color:#aaa;margin:0}</style></head>
    <body><div class="card"><h1>Auth error</h1><p>${escapeHtml(message)}</p></div></body></html>`,
  );
}

function setOAuthStateCookie(res: express.Response, nonce: string): void {
  res.cookie(OAUTH_STATE_COOKIE_NAME, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: OAUTH_STATE_TTL_MS,
    path: "/",
  });
}

function getOAuthStateCookie(req: express.Request): string | null {
  const reqCookies = (req as express.Request & { cookies?: Record<string, string> })
    .cookies;
  const nonce = reqCookies?.[OAUTH_STATE_COOKIE_NAME];
  return typeof nonce === "string" && nonce.length > 0 ? nonce : null;
}

function clearOAuthStateCookie(res: express.Response): void {
  res.clearCookie(OAUTH_STATE_COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
}

export interface AuthRoutesOptions {
  serverUrl: URL;
  readOnly: boolean;
  getClient: (
    clientId: string,
  ) => OAuthClientInformationFull | undefined | Promise<OAuthClientInformationFull | undefined>;
}

export function requireSameOriginPost(selfOrigin: string): express.RequestHandler {
  return (req, res, next) => {
    if (req.method !== "POST") {
      next();
      return;
    }
    if (!isSameOriginRequest({
      secFetchSite: req.get("sec-fetch-site"),
      origin: req.get("origin"),
      selfOrigin,
    })) {
      logger.warn(
        { event: "cross_origin_post_rejected", path: req.path },
        "Rejected a cross-origin auth request",
      );
      renderError(res, 403, "Cross-origin request rejected.");
      return;
    }
    next();
  };
}

async function requireValidCsrf(
  req: express.Request,
  res: express.Response,
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>,
): Promise<boolean> {
  if (await consumeCsrfToken(req.body?.csrf_token, session)) return true;
  logger.warn(
    { event: "csrf_token_rejected", path: req.path },
    "Rejected an invalid or replayed CSRF token",
  );
  renderError(res, 403, "Invalid or expired form token. Reload and try again.");
  return false;
}

export async function validateMetaAuthReturn(
  input: unknown,
  getClient: AuthRoutesOptions["getClient"],
): Promise<string | null> {
  if (typeof input !== "string") return null;
  const returnTo = safeReturnTo(input);
  if (returnTo !== input) return null;

  // Login has to be able to return somewhere that is not an OAuth request.
  // Compared as an exact string, before any URL parsing, so no normalization
  // quirk can turn a hostile input into one of these paths.
  if (STANDALONE_RETURN_PATHS.has(returnTo)) return returnTo;

  const base = "http://mcp.local";
  let parsed: URL;
  try {
    parsed = new URL(returnTo, base);
  } catch {
    return null;
  }
  // Checking only `pathname` is not enough: a path that normalizes to another
  // origin (e.g. via backslashes) keeps the expected pathname while pointing
  // off-site. Pin the origin explicitly.
  if (parsed.origin !== base) return null;
  if (parsed.pathname !== "/authorize") return null;

  const query = Object.fromEntries(parsed.searchParams.entries());
  const validation = await validateAuthorizeQuery(query, async (clientId) =>
    getClient(clientId),
  );
  return validation.ok ? returnTo : null;
}

function getMetaConfigOr500(
  serverUrl: URL,
  res: express.Response,
): MetaOAuthConfig | null {
  const config = loadMetaOAuthConfig(serverUrl);
  if (!config) {
    renderError(res, 500, "Meta OAuth is not configured on this server.");
    return null;
  }
  return config;
}

export function mountAuthRoutes(
  app: express.Application,
  options: AuthRoutesOptions,
): void {
  const { serverUrl, getClient, readOnly } = options;

  // Uniform CSRF boundary for every cookie-authenticated state-changing auth
  // endpoint. Comparing with configured SERVER_URL avoids trusting Host.
  app.use("/auth", requireSameOriginPost(serverUrl.origin));

  app.get("/auth/meta", async (req, res) => {
    const returnTo = await validateMetaAuthReturn(req.query.return, getClient);
    if (!returnTo) {
      renderError(res, 400, "Invalid OAuth request.");
      return;
    }

    const config = getMetaConfigOr500(serverUrl, res);
    if (!config) return;

    const nonce = generateOAuthStateNonce();
    const state = await signOAuthState({ returnTo, nonce });
    setOAuthStateCookie(res, nonce);

    res.redirect(302, buildAuthorizeUrl(config, state));
  });

  app.get("/auth/meta/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    const error = typeof req.query.error === "string" ? req.query.error : null;
    const stateNonce = getOAuthStateCookie(req);
    clearOAuthStateCookie(res);

    const config = getMetaConfigOr500(serverUrl, res);
    if (!config) return;

    if (error) {
      // Don't reflect Meta's error code/message back to the user — log it
      // server-side and show a generic message (CODE-M1).
      logger.warn(
        { event: "meta_oauth_denied" },
        "Meta OAuth callback returned an error",
      );
      renderError(
        res,
        400,
        "Login was cancelled or rejected by Meta. Please try again.",
      );
      return;
    }
    if (!code || !state) {
      renderError(res, 400, "Missing code or state in callback.");
      return;
    }

    const pending = stateNonce ? await verifyOAuthState(state, stateNonce) : null;
    if (!pending) {
      renderError(res, 400, "Invalid or expired OAuth state.");
      return;
    }

    try {
      const shortLived = await exchangeCodeForToken(config, code);
      const longLived = await exchangeForLongLivedToken(
        config,
        shortLived.accessToken,
      );
      const profile = await fetchProfile(longLived.accessToken, config.apiVersion);
      const inspection = await inspectReportingToken(config, longLived.accessToken);
      if (inspection.userId !== profile.id) {
        throw new Error("Meta token owner validation failed");
      }
      const assets = await fetchAccessibleAssets(longLived.accessToken, config.apiVersion);

      if (!isAllowed({ email: profile.email, fbUserId: profile.id })) {
        // Hash PII before logging — keeps the value correlatable across
        // events without persisting the raw email/fbUserId in log
        // retention (CODE-B5).
        logger.warn(
          { fbUserId: hashPii(profile.id), email: hashPii(profile.email) },
          "Meta login rejected by allowlist",
        );
        renderError(
          res,
          403,
          "This Meta account is not allowed to use this server. Contact the administrator.",
        );
        return;
      }

      const business = await fetchPrimaryBusiness(
        longLived.accessToken,
        config.apiVersion,
      );

      await upsertUser(profile.id, profile);
      const granularAccountIds = inspection.granularScopes
        .filter(({ scope }) => scope === "ads_read")
        .flatMap(({ targetIds }) => targetIds)
        .map((id) => (id.startsWith("act_") ? id : `act_${id}`));
      await saveToken({
        fbUserId: profile.id,
        workspaceId: profile.id,
        name: "personal",
        accessToken: longLived.accessToken,
        kind: "user",
        expiresAt:
          inspection.expiresAt === 0
            ? longLived.expiresAt
            : inspection.expiresAt,
        scopes: inspection.scopes,
        granularScopes: inspection.granularScopes,
        dataAccessExpiresAt: inspection.dataAccessExpiresAt,
        allowedAccountIds: [
          ...new Set([...assets.accountIds, ...granularAccountIds]),
        ],
        allowedAssetIds: [
          ...new Set([profile.id, ...inspection.assetIds, ...assets.assetIds]),
        ],
        metaUserId: profile.id,
        metaUserName: profile.name,
        businessId: business?.id ?? null,
        businessName: business?.name ?? null,
        setAsDefault: !(await getDefaultTokenName(profile.id)),
      });

      await setSession(res, {
        fbUserId: profile.id,
        email: profile.email,
        name: profile.name,
      });

      res.redirect(302, safeReturnTo(pending.returnTo));
    } catch {
      logger.error({ event: "meta_oauth_callback_failed" }, "Meta callback failed");
      renderError(res, 500, "Login failed. Please try again.");
    }
  });

  app.post("/auth/logout", express.urlencoded({ extended: false }), async (req, res) => {
    const session = await getSession(req);
    if (!session) {
      renderError(res, 401, "Session expired. Sign in again.");
      return;
    }
    if (!(await requireValidCsrf(req, res, session))) return;
    await clearSession(req, res);
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    );
    res.status(200).type("html").send(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sesión cerrada</title>
      <style>body{background:#0f0f0f;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:1rem}
      .card{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:2rem;max-width:480px;text-align:center}
      h1{color:#fff;margin:0 0 1rem;font-size:1.3rem}
      p{color:#aaa;margin:0.5rem 0;font-size:0.95rem;line-height:1.5}</style></head>
      <body><div class="card">
        <h1>Sesión cerrada</h1>
        <p>Tu sesión se cerró correctamente. Puedes cerrar esta pestaña y volver a iniciar la autorización desde tu cliente MCP.</p>
      </div></body></html>`,
    );
  });

  app.post(
    "/auth/select-token",
    express.urlencoded({ extended: false }),
    async (req, res) => {
      if (readOnly) {
        renderError(res, 403, "Credential selection is disabled in read-only mode.");
        return;
      }
      const session = await getSession(req);
      if (!session) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      if (!(await requireValidCsrf(req, res, session))) return;
      const name = typeof req.body?.name === "string" ? req.body.name : null;
      if (!name) {
        res.status(400).json({ error: "Missing name" });
        return;
      }
      const ok = await setDefaultToken(session.fbUserId, name);
      if (!ok) {
        res.status(404).json({ error: "Token not found" });
        return;
      }
      const returnTo = safeReturnTo(req.body?.return);
      res.redirect(302, returnTo);
    },
  );

  app.post(
    "/auth/register-system-token",
    express.urlencoded({ extended: false }),
    async (_req, res) => {
      renderError(
        res,
        410,
        "Browser token registration was removed. Connect through server-side Meta OAuth.",
      );
    },
  );

  app.post(
    "/auth/delete-token",
    express.urlencoded({ extended: false }),
    async (req, res) => {
      if (readOnly) {
        renderError(res, 403, "Credential administration is disabled in read-only mode.");
        return;
      }
      const session = await getSession(req);
      if (!session) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      if (!(await requireValidCsrf(req, res, session))) return;
      const name = typeof req.body?.name === "string" ? req.body.name : null;
      if (!name) {
        res.status(400).json({ error: "Missing name" });
        return;
      }
      const ok = await deleteToken(session.fbUserId, name);
      if (!ok) {
        res.status(404).json({ error: "Token not found" });
        return;
      }
      const returnTo = safeReturnTo(req.body?.return);
      res.redirect(302, returnTo);
    },
  );

  app.get(CONNECTIONS_PATH, async (req, res) => {
    const session = await getSession(req);
    if (!session) {
      // Literal destination, no user input — nothing to redirect-inject.
      res.redirect(
        302,
        `/auth/meta?return=${encodeURIComponent(CONNECTIONS_PATH)}`,
      );
      return;
    }

    const [tokens, activeName, apify, csrfToken] = await Promise.all([
      listTokens(session.fbUserId),
      getDefaultTokenName(session.fbUserId),
      getApifyTokenRepo().getStatus(session.fbUserId),
      issueCsrfToken(session),
    ]);

    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "Cookie");

      res.type("html").send(
        renderConnectionsPage({
        user: {
          fbUserId: session.fbUserId,
          email: session.email,
          name: session.name,
        },
        tokens,
        activeName,
          apify,
          readOnly,
          csrfToken,
      }),
    );
  });

  app.post(
    "/auth/register-apify-token",
    express.urlencoded({ extended: false }),
    async (req, res) => {
      if (readOnly) {
        renderError(res, 403, "Apify credential administration is disabled in read-only mode.");
        return;
      }
      if (!isSameOriginPost(req)) {
        logger.warn(
          { event: "cross_origin_post_rejected", path: "/auth/register-apify-token" },
          "Rejected a cross-origin form post",
        );
        renderError(res, 403, "Cross-origin request rejected.");
        return;
      }

      const session = await getSession(req);
      if (!session) {
        renderError(res, 401, "Session expired. Sign in again.");
        return;
      }
      if (!(await requireValidCsrf(req, res, session))) return;

      const parsed = validateApifyTokenInput(req.body?.apify_token);
      if (!parsed.ok) {
        renderError(res, 400, "Invalid Apify token.");
        return;
      }

      let user: ApifyUser;
      try {
        const response = await apifyValidationClient.get<ApifyEnvelope<ApifyUser>>(
          "/v2/users/me",
          undefined,
          parsed.token,
        );
        user = response.data;
      } catch (error) {
        logger.warn(
          {
            event: "apify_token_register_failed",
            fbUserId: hashPii(session.fbUserId),
            tokenHash: hashToken(parsed.token),
            error: error instanceof Error ? error.message : String(error),
          },
          "Apify token validation failed",
        );
        renderError(
          res,
          400,
          "Apify token validation failed. The token may be revoked or lack API access. Check the server logs for details.",
        );
        return;
      }

      if (!user?.id || !user?.username) {
        logger.warn(
          { event: "apify_token_register_failed", fbUserId: hashPii(session.fbUserId) },
          "Apify returned an unexpected /users/me shape",
        );
        renderError(res, 400, "Apify token validation failed.");
        return;
      }

      await getApifyTokenRepo().saveToken(session.fbUserId, parsed.token, {
        id: user.id,
        username: user.username,
      });
      logger.info(
        {
          event: "apify_token_registered",
          fbUserId: hashPii(session.fbUserId),
          apifyUserId: user.id,
        },
        "Apify token registered via web UI",
      );

      res.redirect(302, safeReturnTo(req.body?.return, CONNECTIONS_PATH));
    },
  );

  app.post(
    "/auth/delete-apify-token",
    express.urlencoded({ extended: false }),
    async (req, res) => {
      if (readOnly) {
        renderError(res, 403, "Apify credential administration is disabled in read-only mode.");
        return;
      }
      if (!isSameOriginPost(req)) {
        logger.warn(
          { event: "cross_origin_post_rejected", path: "/auth/delete-apify-token" },
          "Rejected a cross-origin form post",
        );
        renderError(res, 403, "Cross-origin request rejected.");
        return;
      }

      const session = await getSession(req);
      if (!session) {
        renderError(res, 401, "Session expired. Sign in again.");
        return;
      }
      if (!(await requireValidCsrf(req, res, session))) return;

      // Idempotent on purpose, unlike /auth/delete-token: a resubmitted form or
      // a stale tab should land back on the page, not on an error.
      await getApifyTokenRepo().deleteToken(session.fbUserId);
      logger.info(
        { event: "apify_token_deleted", fbUserId: hashPii(session.fbUserId) },
        "Apify token deleted via web UI",
      );

      res.redirect(302, safeReturnTo(req.body?.return, CONNECTIONS_PATH));
    },
  );
}

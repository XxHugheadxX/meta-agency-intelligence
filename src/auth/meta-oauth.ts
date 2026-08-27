import { logger } from "../utils/logger.js";

const META_API_VERSION = process.env.META_API_VERSION ?? "v22.0";
const META_GRAPH = "https://graph.facebook.com";
const META_OAUTH_DIALOG = "https://www.facebook.com";

const DEFAULT_SCOPES = [
  "ads_read",
  "pages_show_list",
  "pages_read_engagement",
  "read_insights",
  "instagram_basic",
  "instagram_manage_insights",
  "email",
  "public_profile",
];

const REQUIRED_REPORTING_SCOPES = new Set(["ads_read"]);
const FORBIDDEN_REPORTING_SCOPES = new Set([
  "ads_management",
  "whatsapp_business_management",
  "whatsapp_business_messaging",
]);

export interface MetaOAuthConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  apiVersion: string;
}

export function loadMetaOAuthConfig(serverUrl: URL): MetaOAuthConfig | null {
  const appId = process.env.META_APP_ID?.trim();
  const appSecret = process.env.META_APP_SECRET?.trim();
  if (!appId || !appSecret) return null;

  const redirectUri =
    process.env.META_OAUTH_REDIRECT_URI?.trim() ||
    new URL("/auth/meta/callback", serverUrl).toString();

  return {
    appId,
    appSecret,
    redirectUri,
    apiVersion: META_API_VERSION,
  };
}

export function buildAuthorizeUrl(
  config: MetaOAuthConfig,
  state: string,
): string {
  const url = new URL(`/${config.apiVersion}/dialog/oauth`, META_OAUTH_DIALOG);
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", DEFAULT_SCOPES.join(","));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("auth_type", "rerequest");
  return url.toString();
}

export interface ShortLivedToken {
  accessToken: string;
  expiresIn: number | null;
}

export async function exchangeCodeForToken(
  config: MetaOAuthConfig,
  code: string,
): Promise<ShortLivedToken> {
  const url = new URL(`/${config.apiVersion}/oauth/access_token`, META_GRAPH);
  const form = new URLSearchParams({
    client_id: config.appId,
    client_secret: config.appSecret,
    redirect_uri: config.redirectUri,
    code,
  });
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const body = (await response.json()) as Record<string, unknown>;

  if (!response.ok || body.error) {
    throw new Error(`Meta code exchange failed with HTTP ${response.status}`);
  }

  return {
    accessToken: String(body.access_token),
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : null,
  };
}

export interface LongLivedToken {
  accessToken: string;
  expiresAt: number;
}

export async function exchangeForLongLivedToken(
  config: MetaOAuthConfig,
  shortLivedToken: string,
): Promise<LongLivedToken> {
  const url = new URL(`/${config.apiVersion}/oauth/access_token`, META_GRAPH);
  const form = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: config.appId,
    client_secret: config.appSecret,
    fb_exchange_token: shortLivedToken,
  });
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const body = (await response.json()) as Record<string, unknown>;

  if (!response.ok || body.error) {
    throw new Error(`Meta long-lived swap failed with HTTP ${response.status}`);
  }

  const accessToken = String(body.access_token);
  const expiresIn =
    typeof body.expires_in === "number" ? body.expires_in : 60 * 24 * 60 * 60;

  return {
    accessToken,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
  };
}

export interface MetaProfile {
  id: string;
  name: string | null;
  email: string | null;
  pictureUrl: string | null;
}

export async function fetchProfile(
  accessToken: string,
  apiVersion: string = META_API_VERSION,
): Promise<MetaProfile> {
  const url = new URL(`/${apiVersion}/me`, META_GRAPH);
  url.searchParams.set(
    "fields",
    "id,name,email,picture.width(200).height(200)",
  );
  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = (await response.json()) as Record<string, unknown>;

  if (!response.ok || body.error) {
    throw new Error(`Meta profile request failed with HTTP ${response.status}`);
  }

  let pictureUrl: string | null = null;
  const pic = body.picture;
  if (pic && typeof pic === "object" && "data" in pic) {
    const data = (pic as { data?: { url?: unknown } }).data;
    if (data && typeof data.url === "string") {
      pictureUrl = data.url;
    }
  }

  return {
    id: String(body.id),
    name: typeof body.name === "string" ? body.name : null,
    email: typeof body.email === "string" ? body.email : null,
    pictureUrl,
  };
}

export async function validateToken(
  accessToken: string,
  apiVersion: string = META_API_VERSION,
  config?: MetaOAuthConfig,
): Promise<{ valid: boolean; profile?: MetaProfile; error?: string }> {
  try {
    if (config) await inspectReportingToken(config, accessToken);
    const profile = await fetchProfile(accessToken, apiVersion);
    return { valid: true, profile };
  } catch (err) {
    logger.warn({ event: "meta_token_validation_failed" }, "Meta token validation failed");
    return {
      valid: false,
      error: err instanceof Error ? err.message : "Meta token validation failed",
    };
  }
}

export interface ReportingTokenInspection {
  appId: string;
  userId: string;
  scopes: string[];
  granularScopes: MetaGranularScope[];
  expiresAt: number;
  dataAccessExpiresAt: number;
  assetIds: string[];
}

export interface MetaGranularScope {
  scope: string;
  targetIds: string[];
}

function parseGranularScopes(value: unknown): MetaGranularScope[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Meta token introspection returned invalid granular scopes");
  }

  return value.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("Meta token introspection returned invalid granular scopes");
    }
    const scope = (item as { scope?: unknown }).scope;
    const targetIds = (item as { target_ids?: unknown }).target_ids;
    if (typeof scope !== "string" || !scope) {
      throw new Error("Meta token introspection returned invalid granular scopes");
    }
    if (targetIds !== undefined && !Array.isArray(targetIds)) {
      throw new Error("Meta token introspection returned invalid granular scopes");
    }
    const parsedTargets = (targetIds ?? []).map((targetId) => {
      if (typeof targetId !== "string" || !targetId) {
        throw new Error("Meta token introspection returned invalid granular scopes");
      }
      return targetId;
    });
    return { scope, targetIds: [...new Set(parsedTargets)].sort() };
  });
}

/** Validate token provenance and least privilege without putting secrets in a URL. */
export async function inspectReportingToken(
  config: MetaOAuthConfig,
  accessToken: string,
): Promise<ReportingTokenInspection> {
  const url = new URL(`/${config.apiVersion}/debug_token`, META_GRAPH);
  const form = new URLSearchParams({ input_token: accessToken });
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.appId}|${config.appSecret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const body = (await response.json()) as {
    data?: {
      app_id?: unknown;
      user_id?: unknown;
      is_valid?: unknown;
      scopes?: unknown;
      granular_scopes?: unknown;
      expires_at?: unknown;
      data_access_expires_at?: unknown;
    };
  };
  const data = body.data;
  if (
    !response.ok ||
    data?.is_valid !== true ||
    data.app_id !== config.appId ||
    typeof data.user_id !== "string" ||
    !data.user_id ||
    !Array.isArray(data.scopes) ||
    data.scopes.some((scope) => typeof scope !== "string" || !scope) ||
    typeof data.expires_at !== "number" ||
    typeof data.data_access_expires_at !== "number"
  ) {
    throw new Error("Meta token provenance validation failed");
  }
  const granularScopes = parseGranularScopes(data.granular_scopes);
  const scopes = [
    ...new Set([
      ...(data.scopes as string[]),
      ...granularScopes.map(({ scope }) => scope),
    ]),
  ].sort();
  for (const required of REQUIRED_REPORTING_SCOPES) {
    if (!scopes.includes(required)) {
      throw new Error(`Meta token is missing required reporting scope: ${required}`);
    }
  }
  for (const forbidden of FORBIDDEN_REPORTING_SCOPES) {
    if (scopes.includes(forbidden)) {
      throw new Error(`Meta token contains forbidden write scope: ${forbidden}`);
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = data.expires_at;
  const dataAccessExpiresAt = data.data_access_expires_at;
  if (expiresAt !== 0 && expiresAt <= now) {
    throw new Error("Meta token has expired");
  }
  if (
    dataAccessExpiresAt !== 0 &&
    dataAccessExpiresAt <= now
  ) {
    throw new Error("Meta token data access has expired");
  }

  return {
    appId: config.appId,
    userId: data.user_id,
    scopes,
    granularScopes,
    expiresAt,
    dataAccessExpiresAt,
    assetIds: [
      ...new Set(granularScopes.flatMap(({ targetIds }) => targetIds)),
    ].sort(),
  };
}

export interface AccessibleMetaAssets {
  accountIds: string[];
  assetIds: string[];
}

export async function fetchAccessibleAssets(
  accessToken: string,
  apiVersion: string = META_API_VERSION,
): Promise<AccessibleMetaAssets> {
  const fetchIds = async (path: string, fields: string): Promise<string[]> => {
    const url = new URL(`/${apiVersion}${path}`, META_GRAPH);
    url.searchParams.set("fields", fields);
    url.searchParams.set("limit", "500");
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = (await response.json()) as {
      data?: Array<{
        id?: unknown;
        account_id?: unknown;
        instagram_business_account?: { id?: unknown };
      }>;
    };
    if (!response.ok) throw new Error(`Meta asset discovery failed with HTTP ${response.status}`);
    return (body.data ?? []).flatMap((item) => {
      const value = typeof item.account_id === "string" ? `act_${item.account_id}` : item.id;
      const values = typeof value === "string" ? [value] : [];
      const instagramId = item.instagram_business_account?.id;
      if (typeof instagramId === "string") values.push(instagramId);
      return values;
    });
  };

  const [accounts, pages] = await Promise.all([
    fetchIds("/me/adaccounts", "id,account_id"),
    fetchIds("/me/accounts", "id,instagram_business_account{id}"),
  ]);
  return {
    accountIds: [...new Set(accounts)],
    assetIds: [...new Set([...accounts, ...pages])],
  };
}

export interface MetaBusiness {
  id: string;
  name: string | null;
}

export async function fetchPrimaryBusiness(
  accessToken: string,
  apiVersion: string = META_API_VERSION,
): Promise<MetaBusiness | null> {
  const url = new URL(`/${apiVersion}/me/businesses`, META_GRAPH);
  url.searchParams.set("fields", "id,name");
  url.searchParams.set("limit", "1");
  try {
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = (await response.json()) as Record<string, unknown>;

    if (!response.ok || body.error) {
      logger.warn(
        { event: "meta_business_discovery_failed", status: response.status },
        "Meta business discovery failed",
      );
      return null;
    }

    const data = Array.isArray(body.data) ? body.data : [];
    const first = data[0];
    if (!first || typeof first !== "object") return null;
    const id = (first as { id?: unknown }).id;
    if (typeof id !== "string") return null;
    const name = (first as { name?: unknown }).name;
    return {
      id,
      name: typeof name === "string" ? name : null,
    };
  } catch {
    logger.warn({ event: "meta_business_discovery_error" }, "Meta business discovery failed");
    return null;
  }
}

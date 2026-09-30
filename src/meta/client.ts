import {
  getAccessToken,
  getTenantContext,
  hashToken,
  type TenantContext,
} from "../auth/token-store.js";
import { logger } from "../utils/logger.js";
import { RateLimiter, type RequestContext } from "./rate-limiter.js";
import { CircuitBreaker, type CircuitContext } from "./circuit-breaker.js";
import { WritePacer } from "./write-pacer.js";
import {
  classifyMetaError,
  isMetaApiError,
  type MetaErrorClassification,
} from "./errors.js";
import type { MetaApiResponse } from "./types/common.js";
import { collectAllPages } from "./paginator.js";
import { DistributedMetaGuard } from "./distributed-guard.js";
import { resolveMetaApiVersion } from "./api-version.js";

const DEFAULT_BASE_URL = "https://graph.facebook.com";
const DEFAULT_TIMEOUT = 30000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000;
const USAGE_LOG_INTERVAL_MS = 60_000;

export interface MetaApiClientConfig {
  apiVersion?: string;
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
  mode?: "read_only" | "write";
}

interface RequestScope {
  accountId?: string;
}

/**
 * Typed client for the Meta Graph API.
 *
 * Compliance guarantees (see src/meta/errors.ts and rate-limiter.ts for
 * references to Meta's docs):
 *  - Bucketed rate-limiting per (token, ad-account, use-case type) — one hot
 *    account does not slow down the rest of the agency.
 *  - Circuit breaker halts requests to a bucket on abuse signals
 *    (subcode 1996), temporary user/business blocks, or repeated throttle.
 *  - Platform/BUC rate-limit errors (4, 17, 32, 613, 80000-80014) are NEVER
 *    retried inside the same request — Meta's docs explicitly warn that
 *    continuing to call after a throttle extends `estimated_time_to_regain_access`.
 *  - Write operations (POST/DELETE) are paced by a preventive token bucket
 *    sized to the Ads Management hourly quota.
 *  - Every response's rate-limit headers update per-bucket state for future
 *    self-throttling decisions.
 */
export class MetaApiClient {
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly mode: "read_only" | "write";
  private readonly rateLimiter = new RateLimiter();
  private readonly circuitBreaker = new CircuitBreaker();
  private readonly writePacer = new WritePacer();
  private readonly distributedGuard = new DistributedMetaGuard();
  private lastUsageLogAt = 0;
  private readonly tenantObjectCache = new Map<string, string>();

  constructor(config?: MetaApiClientConfig) {
    this.apiVersion = resolveMetaApiVersion(config?.apiVersion);
    this.baseUrl = config?.baseUrl ?? DEFAULT_BASE_URL;
    this.timeout = config?.timeout ?? DEFAULT_TIMEOUT;
    this.maxRetries = config?.maxRetries ?? MAX_RETRIES;
    this.mode = config?.mode ?? (process.env.MCP_MODE === "write" ? "write" : "read_only");
  }

  async get<T>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const url = this.buildUrl(path, params);
    return this.execute<T>("GET", url, path);
  }

  async post<T>(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    this.assertWriteAllowed("POST", path);
    const url = this.buildUrl(path);
    return this.execute<T>("POST", url, path, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async postForm<T>(
    path: string,
    params: Record<string, string | number | boolean>,
    scope?: RequestScope,
  ): Promise<T> {
    this.assertWriteAllowed("POST", path);
    const url = this.buildUrl(path);
    const formBody = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      formBody.set(key, String(value));
    }
    return this.execute<T>("POST", url, path, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
    }, false, scope);
  }

  async postMultipart<T>(
    path: string,
    formData: FormData,
  ): Promise<T> {
    this.assertWriteAllowed("POST", path);
    const url = this.buildUrl(path);
    return this.execute<T>("POST", url, path, { body: formData });
  }

  async delete<T>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    this.assertWriteAllowed("DELETE", path);
    const url = this.buildUrl(path, params);
    return this.execute<T>("DELETE", url, path);
  }

  async getPaginated<T>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    maxItems = 1000,
  ): Promise<T[]> {
    const firstPage = await this.get<MetaApiResponse<T>>(path, params);
    if (!firstPage.data) return [];
    return collectAllPages<T>(
      firstPage,
      async (after) =>
        this.get<MetaApiResponse<T>>(path, { ...params, after }),
      maxItems,
    );
  }

  /**
   * Public snapshot for the `ads_rate_status` tool.
   */
  getUsageSnapshot() {
    return {
      usage: this.rateLimiter.snapshot(),
      circuits: this.circuitBreaker.snapshot(),
      writePacer: this.writePacer.snapshot(),
    };
  }

  resetForTests(): void {
    this.rateLimiter.reset();
    this.circuitBreaker.reset();
    this.writePacer.reset();
    this.lastUsageLogAt = 0;
    this.tenantObjectCache.clear();
  }

  // ─── Internal ────────────────────────────────────────────────

  private buildUrl(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): string {
    const base = `${this.baseUrl}/${this.apiVersion}${path.startsWith("/") ? path : `/${path}`}`;
    const url = new URL(base);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return url.toString();
  }

  private async execute<T>(
    method: string,
    url: string,
    path: string,
    options?: RequestInit,
    _skipTokenParam = false,
    scope?: RequestScope,
  ): Promise<T> {
    const token = getAccessToken();
    const tokenHash = hashToken(token);
    await this.assertTenantAssetAccess(path, url, token, tokenHash);
    const accountId = scope?.accountId ?? extractAccountId(path);
    const context: RequestContext = { tokenHash, accountId };
    const circuitContext: CircuitContext = {
      tokenHash,
      accountId,
      type: guessBucType(method, path),
    };

    // Circuit breaker is the hard stop: if open, never call Meta.
    this.circuitBreaker.assertClosed(circuitContext);
    await this.distributedGuard.beforeRequest(circuitContext);

    // Preventive write pacing for POST / DELETE on account-scoped paths.
    const isWrite =
      (method === "POST" || method === "DELETE") &&
      accountId !== undefined;
    if (isWrite) {
      await this.writePacer.acquire(tokenHash, accountId);
    }

    // Reactive self-throttle based on last-known usage headers.
    await this.rateLimiter.waitIfNeeded(context);

    // POST to /act_<id>/<collection> creates new resources without native
    // idempotency on Meta's side — retrying a timeout/5xx/network error can
    // mint duplicates (e.g. two ad sets for one user intent). The /<id>/copies
    // edge (ad/ad set/campaign duplication) creates a resource on a non-act_
    // path, so it must be classed as creating too — otherwise a retried copy
    // mints a duplicate ad. The WhatsApp creating edges live on plain-numeric
    // WABA/phone paths: /message_templates, /flows, /message_qrdls create
    // resources, and /request_code sends a real SMS/voice call — all mint
    // duplicates on retry. Other POSTs (updates on /<id>) and DELETEs are
    // idempotent at the API level.
    const isCreatingRequest =
      method === "POST" &&
      (/^\/?act_[A-Za-z0-9]+\//.test(path) ||
        /\/copies$/.test(path) ||
        /\/(message_templates|flows|message_qrdls|request_code)$/.test(path));
    const canRetryTransport = !isCreatingRequest;

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          this.timeout,
        );

        const headers = new Headers(options?.headers);
        headers.set("Authorization", `Bearer ${token}`);
        const response = await fetch(url, {
          method,
          ...options,
          headers,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Update rate-limiter + pacer from response headers — regardless of
        // whether the response was OK. Throttle signals travel on error
        // responses too.
        this.rateLimiter.updateFromHeaders(response.headers, context);
        this.maybeUpdatePacerTierFromHeaders(response.headers, tokenHash, accountId);
        this.maybeLogUsage();

        const body = (await response.json()) as unknown;

        if (isMetaApiError(body)) {
          const classification = classifyMetaError(body.error);
          this.logMetaError(body.error, classification, context, path);

          if (classification.throttled) {
            // Seed the rate-limiter with the retry-after hint so sibling
            // requests back off even before the next header arrives.
            if (classification.retryAfterMs) {
              this.rateLimiter.markRetryAfter(
                context,
                circuitContext.type ?? "unknown",
                classification.retryAfterMs,
              );
            }
            this.circuitBreaker.trip(circuitContext, classification);
            await this.distributedGuard.trip(
              circuitContext,
              classification.retryAfterMs ?? 15 * 60 * 1000,
            );
            // Meta's doc: "If you reach the limit, stop making API calls."
            throw classification.mcpError;
          }

          if (classification.retryable && canRetryTransport && attempt < this.maxRetries) {
            lastError = classification.mcpError;
            await this.backoff(attempt);
            continue;
          }

          throw classification.mcpError;
        }

        if (!response.ok) {
          lastError = new Error(`Meta API request failed with HTTP ${response.status}`);
          if (response.status >= 500 && canRetryTransport && attempt < this.maxRetries) {
            await this.backoff(attempt);
            continue;
          }
          throw lastError;
        }

        return body as T;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          lastError = new Error(`Request timeout after ${this.timeout}ms`);
          if (canRetryTransport && attempt < this.maxRetries) {
            await this.backoff(attempt);
            continue;
          }
          throw lastError;
        }

        // Already-classified errors bubble up unchanged.
        if (error instanceof Error && "code" in error) {
          throw error;
        }

        lastError = error instanceof Error ? error : new Error(String(error));
        if (canRetryTransport && attempt < this.maxRetries) {
          await this.backoff(attempt);
          continue;
        }
        throw lastError;
      }
    }

    logger.error(
      { errorName: lastError?.name, path, event: "meta_retries_exhausted" },
      "Meta request failed after retries",
    );
    throw lastError ?? new Error("Request failed after retries");
  }

  private assertWriteAllowed(method: "POST" | "DELETE", path: string): void {
    if (this.mode === "read_only") {
      throw new Error(
        `Meta ${method} request blocked by read-only policy for path ${path}`,
      );
    }
  }

  private async assertTenantAssetAccess(
    path: string,
    requestUrl: string,
    token: string,
    tokenHash: string,
  ): Promise<void> {
    const tenant = getTenantContext();
    if (!tenant) return;

    const first = path.replace(/^\//, "").split(/[/?]/, 1)[0];
    if (!first) {
      throw new Error("Requested Meta resource is not assigned to this workspace");
    }
    if (first === "me") {
      throw new Error("Workspace-scoped Meta requests cannot use /me edges");
    }

    if (/^act_\d+$/.test(first)) {
      this.assertAccountAllowed(first, tenant);
    } else if (/^\d{1,32}_\d{1,32}$/.test(first)) {
      this.assertPagePostAllowed(first, tenant);
    } else if (/^\d+$/.test(first)) {
      await this.assertObjectAllowed(first, tenant, token, tokenHash);
    }

    const scopedIds = collectScopedIds(new URL(requestUrl));
    for (const accountId of scopedIds.accountIds) {
      this.assertAccountAllowed(accountId, tenant);
    }
    for (const assetId of scopedIds.assetIds) {
      await this.assertObjectAllowed(assetId, tenant, token, tokenHash);
    }
  }

  private assertAccountAllowed(accountId: string, tenant: TenantContext): void {
    const normalized = accountId.startsWith("act_")
      ? accountId
      : `act_${accountId}`;
    if (!tenant.allowedAccountIds.has(normalized)) {
      throw new Error("Requested ad account is not assigned to this workspace");
    }
  }

  private assertPagePostAllowed(postId: string, tenant: TenantContext): void {
    const pageId = postId.split("_", 1)[0];
    if (
      !tenant.allowedAssetIds.has(pageId) ||
      !tenant.allowedPageIds.has(pageId)
    ) {
      throw new Error("Requested Meta object is not assigned to this workspace");
    }
  }

  private async assertObjectAllowed(
    objectId: string,
    tenant: TenantContext,
    token: string,
    tokenHash: string,
  ): Promise<void> {
    if (tenant.allowedAssetIds.has(objectId)) return;

    const cacheKey = `${tenant.workspaceId}:${objectId}`;
    let parent = this.tenantObjectCache.get(cacheKey);
    if (!parent) {
      const resolutionContext: CircuitContext = {
        tokenHash,
        type: "asset_resolution",
      };
      this.circuitBreaker.assertClosed(resolutionContext);
      await this.distributedGuard.beforeRequest(resolutionContext);
      const accountUrl = this.buildUrl(`/${objectId}`, { fields: "account_id" });
      const accountResponse = await fetch(accountUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(Math.min(this.timeout, 10_000)),
      });
      const accountBody = (await accountResponse.json()) as { account_id?: unknown };
      if (
        accountResponse.ok &&
        (typeof accountBody.account_id === "string" || typeof accountBody.account_id === "number")
      ) {
        const rawParent = String(accountBody.account_id);
        parent = `account:${rawParent.startsWith("act_") ? rawParent : `act_${rawParent}`}`;
      } else {
        const ownerUrl = this.buildUrl(`/${objectId}`, { fields: "owner" });
        const ownerResponse = await fetch(ownerUrl, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(Math.min(this.timeout, 10_000)),
        });
        const ownerBody = (await ownerResponse.json()) as { owner?: { id?: unknown } };
        const ownerId = ownerBody.owner?.id;
        if (!ownerResponse.ok || (typeof ownerId !== "string" && typeof ownerId !== "number")) {
          throw new Error("Requested Meta object is not assigned to this workspace");
        }
        parent = `instagram:${String(ownerId)}`;
      }
      this.tenantObjectCache.set(cacheKey, parent);
    }
    if (parent.startsWith("account:")) {
      this.assertAccountAllowed(parent.slice("account:".length), tenant);
      return;
    }
    const instagramId = parent.slice("instagram:".length);
    if (
      !tenant.allowedAssetIds.has(instagramId) ||
      !tenant.allowedInstagramIds.has(instagramId)
    ) {
      throw new Error("Requested Meta object is not assigned to this workspace");
    }
  }

  private async backoff(attempt: number): Promise<void> {
    const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
    const jitter = delay * (Math.random() * 0.4 - 0.2); // ±20%
    await new Promise((resolve) => setTimeout(resolve, delay + jitter));
  }

  private maybeUpdatePacerTierFromHeaders(
    headers: Headers,
    tokenHash: string,
    accountId: string | undefined,
  ): void {
    if (!accountId) return;
    const throttle = headers.get("x-fb-ads-insights-throttle");
    if (throttle) {
      try {
        const parsed = JSON.parse(throttle) as { ads_api_access_tier?: string };
        if (parsed.ads_api_access_tier) {
          this.writePacer.updateTier(tokenHash, accountId, parsed.ads_api_access_tier);
        }
      } catch {
        /* ignore */
      }
    }
    const acc = headers.get("x-ad-account-usage");
    if (acc) {
      try {
        const parsed = JSON.parse(acc) as { ads_api_access_tier?: string };
        if (parsed.ads_api_access_tier) {
          this.writePacer.updateTier(tokenHash, accountId, parsed.ads_api_access_tier);
        }
      } catch {
        /* ignore */
      }
    }
  }

  private logMetaError(
    error: { code: number; error_subcode?: number; message: string; fbtrace_id?: string },
    classification: MetaErrorClassification,
    context: RequestContext,
    path: string,
  ): void {
    const payload = {
      event: "meta_error",
      path,
      meta_error_code: error.code,
      meta_subcode: error.error_subcode,
      fbtrace_id: error.fbtrace_id,
      category: classification.category,
      throttled: classification.throttled,
      retryAfterMs: classification.retryAfterMs,
      tokenHash: context.tokenHash,
      accountId: context.accountId,
    };
    if (classification.critical) {
      logger.fatal(payload, "Meta API rejected the request with a critical condition");
    } else if (
      classification.category === "invalid_params" ||
      classification.category === "duplicate"
    ) {
      // 4xx user-side — count as user_errors signal (Insights formula subtracts
      // 0.001 × user_errors from hourly quota).
      logger.warn({ ...payload, event: "meta_user_error" }, "Meta API rejected request parameters");
    } else {
      logger.error(payload, "Meta API request failed");
    }
  }

  private maybeLogUsage(): void {
    const now = Date.now();
    if (now - this.lastUsageLogAt < USAGE_LOG_INTERVAL_MS) return;
    this.lastUsageLogAt = now;
    const snapshot = this.rateLimiter.snapshot();
    if (snapshot.length === 0) return;
    const tier = snapshot.find((b) => b.adsApiAccessTier)?.adsApiAccessTier;
    logger.info(
      {
        event: "meta_rate_usage",
        buckets: snapshot.length,
        maxCallPct: snapshot.reduce((m, b) => Math.max(m, b.callCount), 0),
        adsApiAccessTier: tier,
      },
      "Meta API usage snapshot",
    );
    if (tier === "development_access") {
      logger.warn(
        { event: "meta_access_tier" },
        "Running on development_access tier — apply for Advanced Access to raise the Ads Management / Insights quota",
      );
    }
  }
}

/**
 * Extract the first id-like segment after the API version. For account-scoped
 * paths like `/act_123/insights` or `/act_123/campaigns`, returns `act_123`.
 * For `/<object_id>/insights` etc., returns `<object_id>`.
 */
function extractAccountId(path: string): string | undefined {
  const stripped = path.startsWith("/") ? path.slice(1) : path;
  const [first] = stripped.split("/");
  if (!first) return undefined;
  if (/^act_\d+$/i.test(first)) return first;
  if (/^\d+$/.test(first)) return first;
  return undefined;
}

const ACCOUNT_ID_KEYS = new Set(["account_id", "ad_account_id"]);
const ASSET_ID_KEYS = new Set([
  "ad_id",
  "adset_id",
  "ad_set_id",
  "campaign_id",
  "creative_id",
  "custom_audience_id",
  "form_id",
  "instagram_actor_id",
  "instagram_user_id",
  "page_id",
  "pixel_id",
  "report_run_id",
  "video_id",
]);

interface ScopedIds {
  accountIds: Set<string>;
  assetIds: Set<string>;
}

function collectScopedIds(url: URL): ScopedIds {
  const result: ScopedIds = {
    accountIds: new Set<string>(),
    assetIds: new Set<string>(),
  };
  for (const [key, rawValue] of url.searchParams) {
    collectScopedValue(key, rawValue, result);
    if (rawValue.startsWith("{") || rawValue.startsWith("[")) {
      try {
        collectScopedObject(JSON.parse(rawValue) as unknown, result);
      } catch {
        // The Graph API will reject malformed JSON. It carries no trusted IDs.
      }
    }
  }
  return result;
}

function collectScopedObject(value: unknown, result: ScopedIds): void {
  if (Array.isArray(value)) {
    for (const item of value) collectScopedObject(item, result);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === "string" || typeof nested === "number") {
      collectScopedValue(key, String(nested), result);
    }
    collectScopedObject(nested, result);
  }
}

function collectScopedValue(
  key: string,
  rawValue: string,
  result: ScopedIds,
): void {
  if (ACCOUNT_ID_KEYS.has(key) && /^(?:act_)?\d+$/.test(rawValue)) {
    result.accountIds.add(
      rawValue.startsWith("act_") ? rawValue : `act_${rawValue}`,
    );
  }
  if (ASSET_ID_KEYS.has(key) && /^\d+$/.test(rawValue)) {
    result.assetIds.add(rawValue);
  }
}

/**
 * Best-effort hint for which BUC pool a request counts against. Used to scope
 * circuit-breaker state — a throttle on Insights should not freeze Audience
 * writes for the same account.
 */
function guessBucType(method: string, path: string): string {
  if (/\/insights(\?|$|\/)/.test(path) || /\/insights$/.test(path)) {
    return "ads_insights";
  }
  if (/\/customaudiences(\?|$|\/)/.test(path) || path.includes("/customaudiences")) {
    return "custom_audience";
  }
  if (method === "POST" || method === "DELETE") {
    return "ads_management";
  }
  return "ads_management";
}

/**
 * Singleton client instance used by all tools.
 */
export const metaApiClient = new MetaApiClient();

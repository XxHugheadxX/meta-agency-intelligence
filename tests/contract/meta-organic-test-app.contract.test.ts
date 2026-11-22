import { beforeAll, describe, expect, it } from "vitest";
import { requestContext } from "../../src/auth/token-store.js";
import {
  MetaFacebookPostReader,
  MetaInstagramContentReader,
  MetaOrganicInsightsReader,
  normalizeFacebookPostInsights,
  normalizeInstagramContentInsights,
  normalizeOrganicInsights,
  ORGANIC_ACCOUNT_METRICS,
  FACEBOOK_POST_METRICS,
  INSTAGRAM_CONTENT_METRICS,
  type OrganicAsset,
  type OrganicContentItem,
} from "../../src/agency/ingestion/index.js";
import { MetaApiClient } from "../../src/meta/client.js";
import { resolveMetaApiVersion } from "../../src/meta/api-version.js";

const enabled = process.env.RUN_META_ORGANIC_CONTRACT_TESTS === "true";
const contractDescribe = enabled ? describe : describe.skip;

const accessToken = process.env.META_CONTRACT_ACCESS_TOKEN?.trim() ?? "";
const pageId = process.env.META_CONTRACT_PAGE_ID?.trim() ?? "";
const facebookPostId = process.env.META_CONTRACT_FACEBOOK_POST_ID?.trim() ?? "";
const instagramId = process.env.META_CONTRACT_INSTAGRAM_ID?.trim() ?? "";
const instagramMediaId = process.env.META_CONTRACT_INSTAGRAM_MEDIA_ID?.trim() ?? "";
const apiVersion = resolveMetaApiVersion(process.env.META_CONTRACT_API_VERSION);
const startDate = process.env.META_CONTRACT_START_DATE?.trim() ?? "";
const endDate = process.env.META_CONTRACT_END_DATE?.trim() ?? "";

function assertConfiguration(): void {
  if (!accessToken) throw new Error("META_CONTRACT_ACCESS_TOKEN is required");
  for (const [name, value] of [
    ["META_CONTRACT_PAGE_ID", pageId],
    ["META_CONTRACT_INSTAGRAM_ID", instagramId],
    ["META_CONTRACT_INSTAGRAM_MEDIA_ID", instagramMediaId],
  ]) {
    if (!/^\d{1,32}$/.test(value)) throw new Error(`${name} must be a numeric test asset ID`);
  }
  if (!new RegExp(`^${pageId}_\\d{1,32}$`).test(facebookPostId)) {
    throw new Error("META_CONTRACT_FACEBOOK_POST_ID must belong to META_CONTRACT_PAGE_ID");
  }
  if (!/^v\d+\.\d+$/.test(apiVersion)) throw new Error("META_CONTRACT_API_VERSION is invalid");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error("META_CONTRACT_START_DATE and META_CONTRACT_END_DATE are required ISO dates");
  }
  if (startDate > endDate) throw new Error("META contract start date must not exceed end date");
}

const pageAsset: OrganicAsset = {
  assetId: pageId,
  assetName: "Meta Test Page",
  platform: "facebook_page",
  currency: "USD",
  timezone: "UTC",
};

const instagramAsset: OrganicAsset = {
  assetId: instagramId,
  assetName: "Meta Test Instagram",
  platform: "instagram",
  currency: "USD",
  timezone: "UTC",
};

const facebookPost: OrganicContentItem = {
  contentId: facebookPostId,
  contentName: "Meta Test Facebook Post",
  contentType: "unknown",
  publishedAt: `${startDate}T00:00:00.000Z`,
  permalink: null,
};

const instagramMedia: OrganicContentItem = {
  contentId: instagramMediaId,
  contentName: "Meta Test Instagram Media",
  contentType: "unknown",
  publishedAt: `${startDate}T00:00:00.000Z`,
  permalink: null,
};

contractDescribe.sequential("Meta organic Test App contract", () => {
  beforeAll(assertConfiguration);

  const client = new MetaApiClient({
    apiVersion,
    mode: "read_only",
    timeout: 15_000,
    maxRetries: 0,
  });
  const accountReader = new MetaOrganicInsightsReader(client);
  const facebookReader = new MetaFacebookPostReader(client);
  const instagramReader = new MetaInstagramContentReader(client);

  function runInTestWorkspace<T>(operation: () => Promise<T>): Promise<T> {
    return requestContext.run({
      accessToken,
      tenantId: "meta-contract-tenant",
      workspaceId: "meta-contract-workspace",
      allowedAccountIds: new Set<string>(),
      allowedAssetIds: new Set([pageId, instagramId]),
      allowedPageIds: new Set([pageId]),
      allowedInstagramIds: new Set([instagramId]),
    }, operation);
  }

  it("reads modern daily Page metrics", async () => {
    const response = await runInTestWorkspace(() => accountReader.readPage({
      asset: pageAsset,
      startDate,
      endDate,
    }));
    expect(Array.isArray(response.data)).toBe(true);
    expect(response.data.every(({ name }) => ORGANIC_ACCOUNT_METRICS.facebook_page.includes(name)))
      .toBe(true);
    expect(() => normalizeOrganicInsights(response.data, {
      asset: pageAsset,
      startDate,
      endDate,
      apiVersion,
      extractedAt: new Date().toISOString(),
      runId: "meta-contract-page",
    })).not.toThrow();
  });

  it("discovers owned Page posts and reads one post without write operations", async () => {
    const discovery = await runInTestWorkspace(() => facebookReader.readContentPage({
      asset: pageAsset,
      startDate,
      endDate,
    }));
    expect(Array.isArray(discovery.data)).toBe(true);
    expect(discovery.data.every(({ id }) => id.startsWith(`${pageId}_`))).toBe(true);

    const response = await runInTestWorkspace(() => facebookReader.readInsights({
      asset: pageAsset,
      content: facebookPost,
    }));
    expect(response.data.every(({ name }) => FACEBOOK_POST_METRICS.includes(name))).toBe(true);
    expect(() => normalizeFacebookPostInsights(facebookPost, response.data, {
      asset: pageAsset,
      apiVersion,
      extractedAt: new Date().toISOString(),
      runId: "meta-contract-facebook-post",
    })).not.toThrow();
  });

  it("reads modern daily Instagram account metrics", async () => {
    const response = await runInTestWorkspace(() => accountReader.readPage({
      asset: instagramAsset,
      startDate,
      endDate,
    }));
    expect(Array.isArray(response.data)).toBe(true);
    expect(response.data.every(({ name }) => ORGANIC_ACCOUNT_METRICS.instagram.includes(name)))
      .toBe(true);
    expect(() => normalizeOrganicInsights(response.data, {
      asset: instagramAsset,
      startDate,
      endDate,
      apiVersion,
      extractedAt: new Date().toISOString(),
      runId: "meta-contract-instagram",
    })).not.toThrow();
  });

  it("discovers owned Instagram media and resolves its owner before insights", async () => {
    const discovery = await runInTestWorkspace(() => instagramReader.readContentPage({
      asset: instagramAsset,
      startDate,
      endDate,
    }));
    expect(Array.isArray(discovery.data)).toBe(true);

    const response = await runInTestWorkspace(() => instagramReader.readInsights({
      asset: instagramAsset,
      content: instagramMedia,
    }));
    expect(response.data.every(({ name }) => INSTAGRAM_CONTENT_METRICS.includes(name))).toBe(true);
    expect(() => normalizeInstagramContentInsights(instagramMedia, response.data, {
      asset: instagramAsset,
      apiVersion,
      extractedAt: new Date().toISOString(),
      runId: "meta-contract-instagram-media",
    })).not.toThrow();
  });
});

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GcsReportObjectStore,
  MetadataServerAccessTokenProvider,
} from "../../src/agency/index.js";

const objectKey = `agency-reports/${"a".repeat(64)}/${"b".repeat(64)}.xlsx`;
const bytes = Uint8Array.of(0x50, 0x4b, 0x03, 0x04);
const digest = createHash("sha256").update(bytes).digest("hex");

describe("GCS report object store", () => {
  it("gets and caches a workload token without placing it in a URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "synthetic-workload-token",
      expires_in: 3600,
      token_type: "Bearer",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const provider = new MetadataServerAccessTokenProvider(fetchMock, () => 1_000_000);

    await expect(provider.getAccessToken()).resolves.toBe("synthetic-workload-token");
    await expect(provider.getAccessToken()).resolves.toBe("synthetic-workload-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain("synthetic-workload-token");
    expect(init.headers).toEqual({ "Metadata-Flavor": "Google" });
  });

  it("uploads through a pinned resumable GCS location with integrity metadata", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 200,
        headers: { location: "https://storage.googleapis.com/upload/session-1" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: objectKey }), { status: 200 }));
    const tokens = { getAccessToken: vi.fn().mockResolvedValue("synthetic-gcp-token") };
    const store = new GcsReportObjectStore("agency-private-reports", tokens, fetchMock);

    await store.putObject({
      objectKey,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes,
      sha256: digest,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [initUrl, initRequest] = fetchMock.mock.calls[0];
    expect(String(initUrl)).toContain("uploadType=resumable");
    expect(String(initUrl)).not.toContain("synthetic-gcp-token");
    expect(JSON.parse(String(initRequest.body))).toMatchObject({
      name: objectKey,
      metadata: { sha256: digest },
    });
    expect(fetchMock.mock.calls[1][0].toString())
      .toBe("https://storage.googleapis.com/upload/session-1");
  });

  it("rejects a resumable upload location outside the pinned GCS host", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 200,
      headers: { location: "https://attacker.example/upload" },
    }));
    const store = new GcsReportObjectStore(
      "agency-private-reports",
      { getAccessToken: vi.fn().mockResolvedValue("synthetic-gcp-token") },
      fetchMock,
    );

    await expect(store.putObject({
      objectKey,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes,
      sha256: digest,
    })).rejects.toThrow("unsafe upload location");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("downloads private bytes with an enforced size budget and handles missing objects", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(bytes, {
        status: 200,
        headers: { "Content-Length": String(bytes.length) },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const store = new GcsReportObjectStore(
      "agency-private-reports",
      { getAccessToken: vi.fn().mockResolvedValue("synthetic-gcp-token") },
      fetchMock,
    );

    await expect(store.getObject({ objectKey, maxBytes: 1024 })).resolves.toEqual(bytes);
    await expect(store.getObject({ objectKey, maxBytes: 1024 })).resolves.toBeNull();
    expect(String(fetchMock.mock.calls[0][0])).toContain("alt=media");
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("synthetic-gcp-token");
  });

  it("refreshes workload authentication once after a 401", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    const tokens = { getAccessToken: vi.fn().mockResolvedValue("synthetic-gcp-token") };
    const store = new GcsReportObjectStore("agency-private-reports", tokens, fetchMock);

    await expect(store.getObject({ objectKey, maxBytes: 1024 })).resolves.toEqual(bytes);
    expect(tokens.getAccessToken).toHaveBeenNthCalledWith(1, false);
    expect(tokens.getAccessToken).toHaveBeenNthCalledWith(2, true);
  });
});

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CloudKmsReportingPayloadSigner } from "../../src/agency/scheduler/index.js";

const keyVersionName =
  "projects/agency-test-123/locations/us-central1/keyRings/reporting/cryptoKeys/job-signing/cryptoKeyVersions/1";

function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (-(crc & 1) & 0x82f63b78);
    }
  }
  return (~crc) >>> 0;
}

function kmsResponse(signature: Uint8Array, overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    name: keyVersionName,
    signature: Buffer.from(signature).toString("base64"),
    signatureCrc32c: String(crc32c(signature)),
    verifiedDigestCrc32c: true,
    ...overrides,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("Cloud KMS reporting payload signer", () => {
  it("signs only a SHA-256 digest and verifies response integrity", async () => {
    const signature = Uint8Array.from({ length: 256 }, (_, index) => index % 251);
    const fetchMock = vi.fn().mockResolvedValue(kmsResponse(signature));
    const tokens = { getAccessToken: vi.fn().mockResolvedValue("synthetic-workload-token") };
    const signer = new CloudKmsReportingPayloadSigner(keyVersionName, tokens, fetchMock);
    const payload = JSON.stringify({ tenantId: "tenant-a", workspaceId: "workspace-a" });

    await expect(signer.sign(payload)).resolves
      .toBe(Buffer.from(signature).toString("base64url"));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://cloudkms.googleapis.com/v1/${keyVersionName}:asymmetricSign`);
    expect(String(url)).not.toContain("synthetic-workload-token");
    const body = JSON.parse(String(init.body));
    const digest = createHash("sha256").update(payload, "utf8").digest();
    expect(body).toEqual({
      digest: { sha256: digest.toString("base64") },
      digestCrc32c: String(crc32c(digest)),
    });
    expect(String(init.body)).not.toContain("tenant-a");
    expect(init.redirect).toBe("error");
  });

  it("refreshes workload authentication once after a 401", async () => {
    const signature = Uint8Array.from({ length: 256 }, () => 7);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(kmsResponse(signature));
    const tokens = { getAccessToken: vi.fn().mockResolvedValue("synthetic-workload-token") };
    const signer = new CloudKmsReportingPayloadSigner(keyVersionName, tokens, fetchMock);

    await signer.sign("{}");
    expect(tokens.getAccessToken).toHaveBeenNthCalledWith(1, false);
    expect(tokens.getAccessToken).toHaveBeenNthCalledWith(2, true);
  });

  it("fails closed on a mismatched key resource or CRC32C", async () => {
    const signature = Uint8Array.from({ length: 256 }, () => 9);
    for (const overrides of [
      { name: `${keyVersionName}0` },
      { verifiedDigestCrc32c: false },
      { signatureCrc32c: "0" },
    ]) {
      const signer = new CloudKmsReportingPayloadSigner(
        keyVersionName,
        { getAccessToken: vi.fn().mockResolvedValue("synthetic-workload-token") },
        vi.fn().mockResolvedValue(kmsResponse(signature, overrides)),
      );
      await expect(signer.sign("{}")).rejects.toThrow("verification");
    }
  });

  it("rejects unsafe key names and oversized payloads before network access", async () => {
    expect(() => new CloudKmsReportingPayloadSigner(
      `${keyVersionName}/../cryptoKeyVersions/2`,
    )).toThrow("key version name");
    const fetchMock = vi.fn();
    const signer = new CloudKmsReportingPayloadSigner(
      keyVersionName,
      { getAccessToken: vi.fn() },
      fetchMock,
    );
    await expect(signer.sign("x".repeat(16 * 1024 + 1))).rejects.toThrow("size limit");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  createReportDownloadHandler,
  type ReportArtifactStore,
} from "../../src/agency/index.js";
import { tenantA, tenantB } from "./fixtures.js";

const bytes = Uint8Array.of(0x50, 0x4b, 0x03, 0x04);

function responseHarness() {
  const response = {
    status: vi.fn(),
    setHeader: vi.fn(),
    json: vi.fn(),
    send: vi.fn(),
  };
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  response.send.mockReturnValue(response);
  return response;
}

function artifactStore(read: ReportArtifactStore["read"]): ReportArtifactStore {
  return {
    store: vi.fn(),
    getMetadata: vi.fn(),
    read,
  };
}

describe("report download handler", () => {
  it("rejects requests without authenticated tenant claims before storage access", async () => {
    const store = artifactStore(vi.fn());
    const response = responseHarness();
    const handler = createReportDownloadHandler(store);

    await handler(
      { auth: undefined, params: { artifactId: "a".repeat(64) } } as never,
      response as never,
      vi.fn(),
    );

    expect(response.status).toHaveBeenCalledWith(401);
    expect(store.read).not.toHaveBeenCalled();
  });

  it("downloads only through the tenant-scoped store and disables caching", async () => {
    const read = vi.fn().mockResolvedValue({
      metadata: {
        ...tenantA,
        artifactId: "a".repeat(64),
        jobId: "weekly-report",
        period: { kind: "week", startDate: "2026-08-24", endDate: "2026-08-30" },
        filename: "agency-weekly-report.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        byteLength: 4,
        sha256: "b".repeat(64),
        createdAt: "2026-08-31T08:00:00.000Z",
        expiresAt: "2026-09-30T08:00:00.000Z",
      },
      bytes,
    });
    const response = responseHarness();
    const handler = createReportDownloadHandler(artifactStore(read));

    await handler(
      {
        auth: { extra: tenantA },
        params: { artifactId: "a".repeat(64) },
      } as never,
      response as never,
      vi.fn(),
    );

    expect(read).toHaveBeenCalledWith(tenantA, "a".repeat(64));
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "private, no-store, max-age=0",
    );
    expect(response.send).toHaveBeenCalledWith(Buffer.from(bytes));
  });

  it("returns the same 404 for invalid, expired, missing, or cross-tenant artifacts", async () => {
    const read = vi.fn().mockResolvedValue(null);
    const response = responseHarness();
    const handler = createReportDownloadHandler(artifactStore(read));

    await handler(
      {
        auth: { extra: tenantA },
        params: { artifactId: "c".repeat(64) },
      } as never,
      response as never,
      vi.fn(),
    );

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({ error: "Report not found" });
  });

  it("sanitizes storage failures", async () => {
    const read = vi.fn().mockRejectedValue(new Error("sensitive backend detail"));
    const response = responseHarness();
    const handler = createReportDownloadHandler(artifactStore(read));

    await handler(
      {
        auth: { extra: tenantA },
        params: { artifactId: "d".repeat(64) },
      } as never,
      response as never,
      vi.fn(),
    );

    expect(response.status).toHaveBeenCalledWith(503);
    expect(JSON.stringify(response.json.mock.calls)).not.toContain("sensitive backend detail");
  });

  it("fails closed when storage returns metadata for another tenant", async () => {
    const read = vi.fn().mockResolvedValue({
      metadata: {
        ...tenantB,
        artifactId: "e".repeat(64),
        jobId: "weekly-report",
        period: { kind: "week", startDate: "2026-08-24", endDate: "2026-08-30" },
        filename: "agency-weekly-report.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        byteLength: bytes.length,
        sha256: "f".repeat(64),
        createdAt: "2026-08-31T08:00:00.000Z",
        expiresAt: "2026-09-30T08:00:00.000Z",
      },
      bytes,
    });
    const response = responseHarness();
    const handler = createReportDownloadHandler(artifactStore(read));

    await handler(
      {
        auth: { extra: tenantA },
        params: { artifactId: "e".repeat(64) },
      } as never,
      response as never,
      vi.fn(),
    );

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.send).not.toHaveBeenCalled();
  });
});

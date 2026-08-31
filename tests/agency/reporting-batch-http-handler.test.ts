import { describe, expect, it, vi } from "vitest";
import { createReportingBatchStatusHandler } from "../../src/agency/index.js";
import { tenantA } from "./fixtures.js";

const batchId = `batch-${"a".repeat(40)}`;

function responseHarness() {
  const response = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return response;
}

function request(auth: unknown = { extra: tenantA }, currentBatchId = batchId) {
  return { auth, params: { batchId: currentBatchId } } as never;
}

describe("reporting batch status handler", () => {
  it("requires authenticated tenant claims before repository access", async () => {
    const get = vi.fn();
    const handler = createReportingBatchStatusHandler({ get }, { getMetadata: vi.fn() });
    const response = responseHarness();
    await handler(request(null), response as never, vi.fn());
    expect(response.status).toHaveBeenCalledWith(401);
    expect(get).not.toHaveBeenCalled();
  });

  it("returns minimal progress without account IDs or storage coordinates", async () => {
    const get = vi.fn().mockResolvedValue({
      batchId, status: "collecting", reportKind: "week",
      startDate: "2026-08-24", endDate: "2026-08-30",
      completedAccounts: 7, expectedAccounts: 20, artifactId: null,
    });
    const handler = createReportingBatchStatusHandler({ get }, { getMetadata: vi.fn() });
    const response = responseHarness();
    await handler(request(), response as never, vi.fn());
    expect(get).toHaveBeenCalledWith(tenantA, batchId);
    expect(response.status).toHaveBeenCalledWith(200);
    const body = response.json.mock.calls[0][0];
    expect(body.progress).toEqual({ completedAccounts: 7, expectedAccounts: 20 });
    expect(body.artifact).toBeNull();
    expect(JSON.stringify(body)).not.toMatch(/tenantId|workspaceId|accountIds|objectKey|https?:\/\//);
  });

  it("returns safe consolidated metadata and an authenticated relative download path", async () => {
    const artifactId = "b".repeat(64);
    const get = vi.fn().mockResolvedValue({
      batchId, status: "complete", reportKind: "month",
      startDate: "2026-08-01", endDate: "2026-08-31",
      completedAccounts: 20, expectedAccounts: 20, artifactId,
    });
    const getMetadata = vi.fn().mockResolvedValue({
      ...tenantA, artifactId, jobId: batchId,
      period: { kind: "month", startDate: "2026-08-01", endDate: "2026-08-31" },
      filename: "meta-agency-consolidated.xlsx", byteLength: 1234,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sha256: "c".repeat(64), createdAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-12-01T00:00:00.000Z",
    });
    const handler = createReportingBatchStatusHandler({ get }, { getMetadata });
    const response = responseHarness();
    await handler(request(), response as never, vi.fn());
    expect(getMetadata).toHaveBeenCalledWith(tenantA, artifactId);
    expect(response.json.mock.calls[0][0].artifact).toEqual({
      artifactId, filename: "meta-agency-consolidated.xlsx", byteLength: 1234,
      createdAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-12-01T00:00:00.000Z",
      downloadPath: `/agency/reports/${artifactId}`,
    });
    expect(JSON.stringify(response.json.mock.calls[0][0])).not.toMatch(/sha256|contentType|tenantId|workspaceId/);
  });

  it("fails closed and sanitizes missing or mismatched backend state", async () => {
    const response = responseHarness();
    const handler = createReportingBatchStatusHandler(
      { get: vi.fn().mockRejectedValue(new Error("sensitive Firestore path")) },
      { getMetadata: vi.fn() },
    );
    await handler(request(), response as never, vi.fn());
    expect(response.status).toHaveBeenCalledWith(503);
    expect(JSON.stringify(response.json.mock.calls)).not.toContain("sensitive Firestore path");

    const artifactId = "d".repeat(64);
    const mismatchResponse = responseHarness();
    const mismatch = createReportingBatchStatusHandler(
      { get: vi.fn().mockResolvedValue({
        batchId, status: "complete", reportKind: "week",
        startDate: "2026-08-24", endDate: "2026-08-30",
        completedAccounts: 20, expectedAccounts: 20, artifactId,
      }) },
      { getMetadata: vi.fn().mockResolvedValue({
        ...tenantA, artifactId, jobId: "another-batch",
        period: { kind: "week", startDate: "2026-08-24", endDate: "2026-08-30" },
      }) },
    );
    await mismatch(request(), mismatchResponse as never, vi.fn());
    expect(mismatchResponse.status).toHaveBeenCalledWith(503);
  });
});

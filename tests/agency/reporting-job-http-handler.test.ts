import express from "express";
import { describe, expect, it, vi } from "vitest";
import { createReportingJobHttpRouter } from "../../src/agency/worker/reporting-job-http-handler.js";
import { ReportingBackpressureError } from "../../src/agency/scheduler/index.js";
import type { AgencyReportingWorkerResult } from "../../src/agency/worker/types.js";
import { tenantA } from "./fixtures.js";

const result: AgencyReportingWorkerResult = {
  ...tenantA,
  jobId: "weekly-report-2026-08-24",
  accountId: "act_100",
  rowsWritten: 1,
  pagesRead: 1,
  watermarkDate: "2026-08-30",
  runId: "weekly-report-2026-08-24",
  artifact: {
    ...tenantA,
    artifactId: "a".repeat(64),
    jobId: "weekly-report-2026-08-24",
    period: { kind: "week", startDate: "2026-08-24", endDate: "2026-08-30" },
    filename: "report.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    byteLength: 4,
    sha256: "b".repeat(64),
    createdAt: "2026-08-31T08:00:00.000Z",
    expiresAt: "2026-09-30T08:00:00.000Z",
  },
};

function verifiedIdentity() {
  return {
    verify: vi.fn().mockResolvedValue({
      issuer: "https://accounts.example.test",
      audience: "https://service.example.test/internal/reporting-jobs",
      subject: "123456789",
      roles: ["scheduler"],
    }),
  };
}

async function withRouter(
  worker: Parameters<typeof createReportingJobHttpRouter>[0],
  identities: Parameters<typeof createReportingJobHttpRouter>[1],
  test: (url: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use("/internal/reporting-jobs", createReportingJobHttpRouter(worker, identities));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  try {
    await test(`http://127.0.0.1:${address.port}/internal/reporting-jobs`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("reporting job HTTP handler", () => {
  it("validates workload identity before accepting the opaque signed envelope", async () => {
    const identities = verifiedIdentity();
    const worker = { run: vi.fn().mockResolvedValue(result) };
    const body = { payload: '{"tenantId":"tenant-a"}', signature: "valid_signature" };
    let responseBody: unknown;

    await withRouter(worker, identities, async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer scheduler-oidc", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      responseBody = await response.json();
    });

    expect(identities.verify).toHaveBeenCalledBefore(worker.run as ReturnType<typeof vi.fn>);
    expect(worker.run).toHaveBeenCalledWith({
      authorization: "Bearer scheduler-oidc",
      payload: '{"tenantId":"tenant-a"}',
      signature: "valid_signature",
    });
    expect(responseBody).toEqual({
      status: "completed",
      jobId: result.jobId,
      artifactId: result.artifact.artifactId,
    });
    const serialized = JSON.stringify(responseBody);
    expect(serialized).not.toContain("bytes");
    expect(serialized).not.toContain("objectKey");
    expect(serialized).not.toContain("scheduler-oidc");
    expect(serialized).not.toContain("tenant-a");
  });

  it("rejects malformed or expanded request bodies before invoking the worker", async () => {
    const identities = verifiedIdentity();
    const worker = { run: vi.fn() };
    await withRouter(worker, identities, async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer scheduler-oidc", "Content-Type": "application/json" },
        body: JSON.stringify({ payload: "{}", signature: "valid_signature", unexpected: true }),
      });
      expect(response.status).toBe(400);
    });

    expect(worker.run).not.toHaveBeenCalled();
  });

  it("sanitizes worker failures", async () => {
    const identities = verifiedIdentity();
    const worker = { run: vi.fn().mockRejectedValue(new Error("Meta token and objectKey leaked")) };
    let responseBody: unknown;
    await withRouter(worker, identities, async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer scheduler-oidc", "Content-Type": "application/json" },
        body: JSON.stringify({ payload: "{}", signature: "valid_signature" }),
      });
      expect(response.status).toBe(400);
      responseBody = await response.json();
    });

    expect(JSON.stringify(responseBody)).not.toContain("Meta token");
    expect(JSON.stringify(responseBody)).not.toContain("objectKey");
  });

  it("returns bounded retry guidance when reporting capacity is exhausted", async () => {
    const identities = verifiedIdentity();
    const worker = { run: vi.fn().mockRejectedValue(new ReportingBackpressureError(7_500)) };
    await withRouter(worker, identities, async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer scheduler-oidc", "Content-Type": "application/json" },
        body: JSON.stringify({ payload: "{}", signature: "valid_signature" }),
      });
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("8");
      await expect(response.json()).resolves.toEqual({
        error: "Reporting capacity is temporarily exhausted",
      });
    });
  });

  it("authenticates before JSON parsing in the router", async () => {
    const identities = { verify: vi.fn().mockRejectedValue(new Error("invalid workload")) };
    const worker = { run: vi.fn() };
    const app = express();
    app.use("/internal/reporting-jobs", createReportingJobHttpRouter(worker, identities));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/internal/reporting-jobs`, {
        method: "POST",
        headers: { Authorization: "Bearer scheduler-oidc", "Content-Type": "application/json" },
        body: "{",
      });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "Unauthorized reporting job request" });
      expect(identities.verify).toHaveBeenCalledWith("Bearer scheduler-oidc");
      expect(worker.run).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects a verified identity without the scheduler role before parsing", async () => {
    const identities = {
      verify: vi.fn().mockResolvedValue({
        issuer: "https://accounts.example.test",
        audience: "https://service.example.test/internal/reporting-jobs",
        subject: "123456789",
        roles: ["analyst"],
      }),
    };
    const worker = { run: vi.fn() };
    const app = express();
    app.use("/internal/reporting-jobs", createReportingJobHttpRouter(worker, identities));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/internal/reporting-jobs`, {
        method: "POST",
        headers: { Authorization: "Bearer scheduler-oidc", "Content-Type": "application/json" },
        body: "{",
      });

      expect(response.status).toBe(401);
      expect(worker.run).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

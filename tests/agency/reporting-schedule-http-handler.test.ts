import express from "express";
import { describe, expect, it, vi } from "vitest";
import {
  createReportingScheduleHttpRouter,
  type ReportingScheduleOptions,
} from "../../src/agency/scheduler/index.js";
import { tenantA } from "./fixtures.js";

const options: ReportingScheduleOptions = {
  timeZone: "America/La_Paz",
  apiVersion: "v23.0",
  attributionWindow: "7d_click",
  retentionDays: 90,
  ingestionLookbackDays: 2,
  now: () => new Date("2026-08-26T16:00:00.000Z"),
};

const identity = {
  issuer: "https://accounts.google.com",
  audience: "https://service.example.test/internal/agency/reporting/schedules",
  subject: "123456789012345678901",
  roles: ["scheduler"],
};

async function withRouter(
  scheduler: Parameters<typeof createReportingScheduleHttpRouter>[0],
  identities: Parameters<typeof createReportingScheduleHttpRouter>[1],
  operation: (url: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use("/internal/agency/reporting/schedules", createReportingScheduleHttpRouter(
    scheduler,
    identities,
    options,
  ));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  try {
    await operation(`http://127.0.0.1:${address.port}/internal/agency/reporting/schedules`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
  }
}

function verifiedIdentity() {
  return { verify: vi.fn().mockResolvedValue(identity) };
}

describe("reporting schedule HTTP handler", () => {
  it("authenticates before parsing and does not reveal request data on rejection", async () => {
    const identities = { verify: vi.fn().mockRejectedValue(new Error("invalid")) };
    const scheduler = { publish: vi.fn() };
    await withRouter(scheduler, identities, async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer invalid", "Content-Type": "application/json" },
        body: "{",
      });
      expect(response.status).toBe(401);
      expect(JSON.stringify(await response.json())).not.toContain("tenant");
    });
    expect(scheduler.publish).not.toHaveBeenCalled();
  });

  it("queues the previous completed week with a bounded ingestion lookback", async () => {
    const scheduler = {
      publish: vi.fn().mockResolvedValue({ ...tenantA, jobsPublished: 20 }),
    };
    await withRouter(scheduler, verifiedIdentity(), async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer synthetic-oidc", "Content-Type": "application/json" },
        body: JSON.stringify({ ...tenantA, reportKind: "week" }),
      });
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body).toEqual({
        status: "queued",
        reportKind: "week",
        reportStartDate: "2026-08-17",
        reportEndDate: "2026-08-23",
        jobsPublished: 20,
      });
      expect(JSON.stringify(body)).not.toContain(tenantA.tenantId);
    });
    expect(scheduler.publish).toHaveBeenCalledWith({
      ...tenantA,
      reportKind: "week",
      reportStartDate: "2026-08-17",
      reportEndDate: "2026-08-23",
      ingestionStartDate: "2026-08-08",
      ingestionEndDate: "2026-08-23",
      level: "ad",
      apiVersion: "v23.0",
      attributionWindow: "7d_click",
      retentionDays: 90,
    });
  });

  it("queues the previous completed calendar month", async () => {
    const scheduler = {
      publish: vi.fn().mockResolvedValue({ ...tenantA, jobsPublished: 2 }),
    };
    await withRouter(scheduler, verifiedIdentity(), async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer synthetic-oidc", "Content-Type": "application/json" },
        body: JSON.stringify({ ...tenantA, reportKind: "month" }),
      });
      expect(response.status).toBe(202);
    });
    expect(scheduler.publish).toHaveBeenCalledWith(expect.objectContaining({
      reportStartDate: "2026-07-01",
      reportEndDate: "2026-07-31",
      ingestionStartDate: "2026-05-30",
      ingestionEndDate: "2026-07-31",
    }));
  });

  it("rejects expanded or malformed triggers without publishing", async () => {
    const scheduler = { publish: vi.fn() };
    await withRouter(scheduler, verifiedIdentity(), async (url) => {
      for (const body of [
        { ...tenantA, reportKind: "week", accessToken: "forbidden" },
        { tenantId: "../tenant", workspaceId: "workspace-a", reportKind: "week" },
        { ...tenantA, reportKind: "day" },
      ]) {
        const response = await fetch(url, {
          method: "POST",
          headers: { Authorization: "Bearer synthetic-oidc", "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
      }
    });
    expect(scheduler.publish).not.toHaveBeenCalled();
  });
});

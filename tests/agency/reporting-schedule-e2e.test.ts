import { generateKeyPairSync, sign, verify } from "node:crypto";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import {
  createReportingScheduleHttpRouter,
  ReportingJobFanOut,
  type SignedReportingMessage,
} from "../../src/agency/scheduler/index.js";
import { tenantA } from "./fixtures.js";

describe("reporting schedule synthetic end-to-end", () => {
  it("fans one authenticated weekly trigger out to twenty isolated signed jobs", async () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const accounts = Array.from({ length: 20 }, (_, index) => ({
      ...tenantA,
      accountId: `act_${String(index + 1).padStart(3, "0")}`,
    }));
    const messages: SignedReportingMessage[] = [];
    const scheduler = new ReportingJobFanOut(
      { listActive: vi.fn().mockResolvedValue(accounts) },
      {
        sign: async (payload) => sign(
          "sha256",
          Buffer.from(payload, "utf8"),
          keys.privateKey,
        ).toString("base64url"),
      },
      { publish: async (message) => { messages.push(structuredClone(message)); } },
    );
    const identities = {
      verify: vi.fn().mockResolvedValue({
        issuer: "https://accounts.google.com",
        audience: "https://service.example.test/internal/agency/reporting/schedules",
        subject: "123456789012345678901",
        roles: ["scheduler"],
      }),
    };
    const app = express();
    app.use("/internal/agency/reporting/schedules", createReportingScheduleHttpRouter(
      scheduler,
      identities,
      {
        timeZone: "America/La_Paz",
        apiVersion: "v23.0",
        attributionWindow: "7d_click",
        retentionDays: 90,
        ingestionLookbackDays: 2,
        now: () => new Date("2026-08-26T16:00:00.000Z"),
      },
    ));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/internal/agency/reporting/schedules`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer synthetic-oidc",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ...tenantA, reportKind: "week" }),
        },
      );
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({ jobsPublished: 20 });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) =>
        error ? reject(error) : resolve()));
    }

    expect(messages).toHaveLength(20);
    const payloads = messages.map((message) => JSON.parse(message.payload));
    expect(new Set(payloads.map((payload) => payload.jobId)).size).toBe(20);
    expect(new Set(payloads.map((payload) => payload.accountId)).size).toBe(20);
    expect(payloads.every((payload) =>
      payload.tenantId === tenantA.tenantId &&
      payload.workspaceId === tenantA.workspaceId &&
      payload.reportStartDate === "2026-08-17" &&
      payload.reportEndDate === "2026-08-23")).toBe(true);
    expect(messages.every((message) => verify(
      "sha256",
      Buffer.from(message.payload, "utf8"),
      keys.publicKey,
      Buffer.from(message.signature, "base64url"),
    ))).toBe(true);
    expect(JSON.stringify(messages)).not.toMatch(/accessToken|authorization|tokenName|privateKey/);
  });
});

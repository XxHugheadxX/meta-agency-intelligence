import { generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ReportingJobFanOut,
  type ReportingFanOutRequest,
  type SignedReportingMessage,
} from "../../src/agency/scheduler/index.js";
import { tenantA, tenantB } from "./fixtures.js";

const request: ReportingFanOutRequest = {
  ...tenantA,
  reportKind: "week",
  reportStartDate: "2026-08-17",
  reportEndDate: "2026-08-23",
  ingestionStartDate: "2026-08-15",
  ingestionEndDate: "2026-08-23",
  level: "ad",
  apiVersion: "v23.0",
  attributionWindow: "7d_click",
  retentionDays: 90,
};

function harness(accounts = [
  { ...tenantA, accountId: "act_200" },
  { ...tenantA, accountId: "act_100" },
]) {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const source = { listActive: vi.fn().mockResolvedValue(accounts) };
  const signer = {
    sign: vi.fn(async (payload: string) =>
      sign("sha256", Buffer.from(payload, "utf8"), keys.privateKey).toString("base64url")),
  };
  const messages: SignedReportingMessage[] = [];
  const publisher = {
    publish: vi.fn(async (message: SignedReportingMessage) => {
      messages.push(structuredClone(message));
    }),
  };
  return { fanOut: new ReportingJobFanOut(source, signer, publisher), keys, messages, publisher, source };
}

describe("reporting job fan-out", () => {
  it("publishes one deterministic signed read-only job per tenant-scoped account", async () => {
    const first = harness();
    await expect(first.fanOut.publish(request)).resolves.toEqual({ ...tenantA, jobsPublished: 2 });
    expect(first.source.listActive).toHaveBeenCalledWith(tenantA);
    expect(first.messages).toHaveLength(2);

    const payloads = first.messages.map((message) => JSON.parse(message.payload));
    expect(payloads.map((payload) => payload.accountId)).toEqual(["act_100", "act_200"]);
    expect(payloads.map((payload) => payload.batchAccountIds)).toEqual([
      ["act_100", "act_200"],
      ["act_100", "act_200"],
    ]);
    expect(payloads[0].batchId).toMatch(/^batch-[a-f0-9]{40}$/);
    expect(payloads[1].batchId).toBe(payloads[0].batchId);
    expect(payloads[0]).toMatchObject({
      ...tenantA,
      mode: "incremental",
      reportKind: "week",
      reportStartDate: "2026-08-17",
      reportEndDate: "2026-08-23",
    });
    expect(payloads[0].jobId).toMatch(/^report-[a-f0-9]{40}$/);
    expect(first.messages.every((message) => verify(
      "sha256",
      Buffer.from(message.payload, "utf8"),
      first.keys.publicKey,
      Buffer.from(message.signature, "base64url"),
    ))).toBe(true);
    expect(JSON.stringify(first.messages)).not.toMatch(/accessToken|authorization|tokenName/);

    const replay = harness();
    await replay.fanOut.publish(request);
    expect(replay.messages.map((message) => JSON.parse(message.payload).jobId))
      .toEqual(payloads.map((payload) => payload.jobId));
    expect(replay.messages.map((message) => JSON.parse(message.payload).batchId))
      .toEqual(payloads.map((payload) => payload.batchId));

    const changedMembership = harness([{ ...tenantA, accountId: "act_100" }]);
    await changedMembership.fanOut.publish(request);
    const changedPayload = JSON.parse(changedMembership.messages[0].payload);
    expect(changedPayload.batchId).not.toBe(payloads[0].batchId);
    expect(changedPayload.jobId).not.toBe(payloads[0].jobId);
  });

  it("rejects cross-tenant or duplicate accounts before signing or publishing", async () => {
    for (const accounts of [
      [{ ...tenantB, accountId: "act_100" }],
      [{ ...tenantA, accountId: "act_100" }, { ...tenantA, accountId: "act_100" }],
    ]) {
      const current = harness(accounts);
      await expect(current.fanOut.publish(request)).rejects.toThrow("account scope");
      expect(current.publisher.publish).not.toHaveBeenCalled();
    }
  });

  it("fails closed on invalid requests, account IDs, and signer output", async () => {
    await expect(harness().fanOut.publish({ ...request, reportEndDate: "2026-08-30" }))
      .rejects.toThrow("date window");
    await expect(harness().fanOut.publish({ ...request, apiVersion: "v23.0-preview" }))
      .rejects.toThrow("API version");
    await expect(harness([{ ...tenantA, accountId: "100" }]).fanOut.publish(request))
      .rejects.toThrow("account scope");

    const current = harness([{ ...tenantA, accountId: "act_100" }]);
    current.publisher.publish.mockClear();
    const invalidSigner = { sign: vi.fn().mockResolvedValue("not+base64") };
    const fanOut = new ReportingJobFanOut(current.source, invalidSigner, current.publisher);
    await expect(fanOut.publish(request)).rejects.toThrow("invalid signature");
    expect(current.publisher.publish).not.toHaveBeenCalled();
  });
});

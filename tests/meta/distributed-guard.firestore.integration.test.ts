import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { DistributedMetaGuard } from "../../src/meta/distributed-guard.js";
import { getFirestore, resetFirestoreForTests } from "../../src/store/firestore.js";

const local = /^(localhost|127\.0\.0\.1):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "");
const emulator = local ? describe : describe.skip;

emulator("distributed Meta guard with Firestore emulator", () => {
  const tokenHash = `quota-fixture-${randomUUID()}`;
  const ids: string[] = [];
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    const db = getFirestore();
    for (const id of ids) {
      await db.collection("meta_request_quotas").doc(id).delete();
      await db.collection("meta_circuits").doc(id).delete();
    }
    await db.terminate();
    resetFirestoreForTests();
  });

  it("enforces one atomic quota across concurrent guards, resets it, and shares circuit state", async () => {
    vi.stubEnv("DISTRIBUTED_RATE_LIMIT_BACKEND", "firestore");
    vi.stubEnv("META_REQUESTS_PER_MINUTE", "2");
    const context = { tokenHash, accountId: "act_100" };
    const id = createHash("sha256").update(`${tokenHash}:act_100:_`).digest("hex");
    const otherId = createHash("sha256").update(`${tokenHash}:act_200:_`).digest("hex");
    ids.push(id, otherId);
    const first = new DistributedMetaGuard();
    const second = new DistributedMetaGuard();
    const results = await Promise.allSettled([
      first.beforeRequest(context), second.beforeRequest(context),
      first.beforeRequest(context), second.beforeRequest(context),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(2);
    for (const result of rejected) {
      if (result.status === "rejected") expect(result.reason.message).toContain("quota exceeded");
    }
    await expect(second.beforeRequest({ ...context, accountId: "act_200" })).resolves.toBeUndefined();
    const quota = getFirestore().collection("meta_request_quotas").doc(id);
    expect((await quota.get()).data()?.count).toBe(2);
    await quota.update({ resetAt: Date.now() - 1 });
    await expect(first.beforeRequest(context)).resolves.toBeUndefined();
    expect((await quota.get()).data()?.count).toBe(1);
    await first.trip(context, 60_000);
    await expect(second.beforeRequest(context)).rejects.toThrow("circuit is open");
  });
});

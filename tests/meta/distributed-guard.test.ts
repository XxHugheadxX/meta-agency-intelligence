import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DistributedMetaGuard } from "../../src/meta/distributed-guard.js";
import { resolveMetaRequestsPerMinute } from "../../src/meta/request-quota.js";

const mock = vi.hoisted(() => ({ getFirestore: vi.fn() }));
vi.mock("../../src/store/firestore.js", () => mock);

describe("distributed Meta quota", () => {
  beforeEach(() => {
    vi.stubEnv("DISTRIBUTED_RATE_LIMIT_BACKEND", "firestore");
    vi.stubEnv("META_REQUESTS_PER_MINUTE", "2");
    mock.getFirestore.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to 120 only when the variable is absent", () => {
    expect(resolveMetaRequestsPerMinute({})).toBe(120);
    expect(() => resolveMetaRequestsPerMinute({ META_REQUESTS_PER_MINUTE: "" })).toThrow();
  });

  it("fails before accessing Firestore when configuration is invalid", async () => {
    vi.stubEnv("META_REQUESTS_PER_MINUTE", "NaN");
    await expect(new DistributedMetaGuard().beforeRequest({ tokenHash: "synthetic", accountId: "act_100" }))
      .rejects.toThrow("positive safe integer");
    expect(mock.getFirestore).not.toHaveBeenCalled();
  });

  it("shares the configured quota between two guards and resets after the window", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const state = new Map<string, { count: number; resetAt: number }>();
      mock.getFirestore.mockReturnValue({
        collection: (collection: string) => ({ doc: (id: string) => ({
          id: `${collection}:${id}`, get: async () => ({ exists: false }),
        }) }),
        runTransaction: async (callback: (transaction: unknown) => Promise<void>) => callback({
          get: async (reference: { id: string }) => ({ data: () => state.get(reference.id) }),
          set: (reference: { id: string }, data: { count: number; resetAt: number }) => state.set(reference.id, data),
        }),
      });
      const context = { tokenHash: "synthetic", accountId: "act_100" };
      const first = new DistributedMetaGuard();
      const second = new DistributedMetaGuard();
      await first.beforeRequest(context);
      await second.beforeRequest(context);
      await expect(first.beforeRequest(context)).rejects.toThrow("quota exceeded");
      await expect(second.beforeRequest(context)).rejects.toThrow("quota exceeded");
      await expect(second.beforeRequest({ ...context, accountId: "act_200" })).resolves.toBeUndefined();
      vi.advanceTimersByTime(60_000);
      await expect(first.beforeRequest(context)).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  InMemoryHistoricalDataRepository,
  historicalMetricId,
} from "../../src/agency/historical-data/index.js";
import { metricFixture, tenantA, tenantB } from "./fixtures.js";

describe("historical reporting data", () => {
  it("upserts the same source identity without duplicating the historical row", async () => {
    const repository = new InMemoryHistoricalDataRepository();
    const first = await repository.upsert(tenantA, metricFixture());
    const replacement = await repository.upsert(
      tenantA,
      metricFixture({ metrics: { spend: 140, clicks: 120, impressions: 2_400 }, rawData: { source: "synthetic", spend: "140" } }),
    );

    expect(replacement.id).toBe(first.id);
    expect(replacement.createdAt).toBe(first.createdAt);
    expect(replacement.metrics.spend).toBe(140);
    expect(replacement.rawData).toEqual({ source: "synthetic", spend: "140" });
    await expect(repository.list(tenantA, { startDate: "2026-08-10", endDate: "2026-08-10" })).resolves.toHaveLength(1);
  });

  it("includes dimensions and tenant/workspace in the idempotency key", () => {
    const base = metricFixture();
    expect(historicalMetricId(tenantA, base)).not.toBe(
      historicalMetricId(tenantB, base),
    );
    expect(historicalMetricId(tenantA, base)).not.toBe(
      historicalMetricId(tenantA, metricFixture({ breakdowns: { age: "25-34" } })),
    );
    expect(historicalMetricId(tenantA, base)).not.toBe(
      historicalMetricId(tenantA, metricFixture({ currency: "USD" })),
    );
    expect(historicalMetricId(tenantA, base)).not.toBe(
      historicalMetricId(tenantA, metricFixture({ apiVersion: "v24.0", schemaVersion: "v2" })),
    );
  });

  it("fails closed and prevents tenant or workspace cross-reads", async () => {
    const repository = new InMemoryHistoricalDataRepository();
    await repository.upsert(tenantA, metricFixture());
    await repository.upsert(tenantB, metricFixture({ accountId: "act_200", accountName: "Inmobiliaria Sur" }));

    await expect(repository.list(tenantA, { startDate: "2026-08-01", endDate: "2026-08-31" })).resolves.toMatchObject([
      { tenantId: "tenant-a", workspaceId: "workspace-a", accountId: "act_100" },
    ]);
    await expect(repository.list({ tenantId: "tenant-a", workspaceId: "workspace-b" }, { startDate: "2026-08-01", endDate: "2026-08-31" })).resolves.toEqual([]);
    await expect(repository.list({ tenantId: "", workspaceId: "workspace-a" }, { startDate: "2026-08-01", endDate: "2026-08-31" })).rejects.toThrow("tenantId");
  });

  it("preserves missing data as null and rejects invalid metric values", async () => {
    const repository = new InMemoryHistoricalDataRepository();
    const row = await repository.upsert(tenantA, metricFixture({ metrics: { spend: 20 } }));
    expect(row.metrics.leads).toBeNull();
    await expect(repository.upsert(tenantA, metricFixture({ metrics: { spend: -1 } }))).rejects.toThrow("spend");
  });

  it("preserves raw snapshots without sharing mutable references", async () => {
    const repository = new InMemoryHistoricalDataRepository();
    const rawData = { source: "synthetic", nested: { result: "original" } };
    const stored = await repository.upsert(tenantA, metricFixture({ rawData }));
    rawData.nested.result = "changed-after-write";
    (stored.rawData.nested as { result: string }).result = "changed-return-value";

    const [reloaded] = await repository.list(tenantA, {
      startDate: "2026-08-10",
      endDate: "2026-08-10",
    });
    expect(reloaded.rawData).toEqual({ source: "synthetic", nested: { result: "original" } });
  });

  it("accepts a bounded agency batch of twenty isolated accounts", async () => {
    const repository = new InMemoryHistoricalDataRepository();
    const inputs = Array.from({ length: 20 }, (_, index) =>
      metricFixture({
        accountId: `act_${index + 1}`,
        accountName: `Cuenta ${index + 1}`,
        adId: `ad_${index + 1}`,
      }),
    );

    await expect(repository.upsertMany(tenantA, inputs)).resolves.toHaveLength(20);
    await expect(
      repository.list(tenantA, { startDate: "2026-08-01", endDate: "2026-08-31" }),
    ).resolves.toHaveLength(20);
    await expect(
      repository.list(tenantB, { startDate: "2026-08-01", endDate: "2026-08-31" }),
    ).resolves.toEqual([]);
  });

  it("rejects impossible calendar dates, unsafe scope paths, and incomplete hierarchy", async () => {
    const repository = new InMemoryHistoricalDataRepository();
    await expect(
      repository.upsert(tenantA, metricFixture({ date: "2026-02-31" })),
    ).rejects.toThrow("ISO calendar date");
    await expect(
      repository.upsert({ tenantId: "tenant/a", workspaceId: "workspace-a" }, metricFixture()),
    ).rejects.toThrow("path separators");
    await expect(
      repository.upsert(tenantA, metricFixture({ adSetId: null })),
    ).rejects.toThrow("adSetId");
    await expect(
      repository.upsert(tenantA, metricFixture({ contentId: "unexpected" })),
    ).rejects.toThrow("do not match");
    await expect(
      repository.upsert(tenantA, metricFixture({
        level: "organic_account",
        contentId: null,
        contentName: null,
        contentType: null,
      })),
    ).rejects.toThrow("do not match");
  });
});

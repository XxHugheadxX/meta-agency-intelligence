import type { HistoricalMetricInput, ReportingScope } from "../../src/agency/historical-data/index.js";

export const tenantA: ReportingScope = { tenantId: "tenant-a", workspaceId: "workspace-a" };
export const tenantB: ReportingScope = { tenantId: "tenant-b", workspaceId: "workspace-b" };

export function metricFixture(overrides: Partial<HistoricalMetricInput> = {}): HistoricalMetricInput {
  return {
    accountId: "act_100",
    accountName: "Inmobiliaria Norte",
    campaignId: "campaign-100",
    campaignName: "Captacion Norte",
    adSetId: "adset-100",
    adSetName: "La Paz",
    adId: "ad-100",
    adName: "Departamento Centro",
    agentId: "agent-ana",
    agentName: "Ana",
    date: "2026-08-10",
    level: "ad",
    metrics: {
      spend: 100,
      reach: 1_000,
      impressions: 2_000,
      clicks: 100,
      messages: 10,
      conversations: 8,
      leads: 5,
      conversions: 2,
    },
    currency: "BOB",
    timezone: "America/La_Paz",
    attributionWindow: "7d_click",
    apiVersion: "v23.0",
    rawData: { source: "synthetic", spend: "100" },
    ...overrides,
  };
}

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  AgencyExcelReportGenerator,
  AgencyReportingService,
  InMemoryHistoricalDataRepository,
} from "../dist/agency/index.js";

const requestedOutput = process.argv[2];
if (!requestedOutput || !requestedOutput.toLowerCase().endsWith(".xlsx")) {
  throw new Error("Usage: node scripts/generate-synthetic-agency-report.mjs <output.xlsx>");
}

const outputPath = resolve(requestedOutput);
const scope = { tenantId: "synthetic-tenant", workspaceId: "synthetic-workspace" };
const repository = new InMemoryHistoricalDataRepository();

function isoDate(day) {
  return `2026-08-${String(day).padStart(2, "0")}`;
}

function paidRow(day, accountIndex, campaignIndex) {
  const accountId = `act_${100 + accountIndex}`;
  const spend = 42 + day * 2 + accountIndex * 11 + campaignIndex * 7;
  const reach = 760 + day * 24 + accountIndex * 130 + campaignIndex * 80;
  const impressions = Math.round(reach * (1.55 + campaignIndex * 0.18));
  const clicks = Math.round(impressions * (0.031 + campaignIndex * 0.006));
  const leads = Math.max(1, Math.round(clicks * (0.075 + accountIndex * 0.01)));
  return {
    accountId,
    accountName: accountIndex === 0 ? "Inmobiliaria Horizonte" : "Inmobiliaria Altura",
    campaignId: `campaign-${campaignIndex + 1}`,
    campaignName: campaignIndex === 0 ? "Captación departamentos" : "Casas familiares",
    adSetId: `adset-${accountIndex + 1}-${campaignIndex + 1}`,
    adSetName: campaignIndex === 0 ? "La Paz 25-44" : "Santa Cruz 30-54",
    adId: `ad-${accountIndex + 1}-${campaignIndex + 1}`,
    adName: campaignIndex === 0 ? "Reel recorrido inmueble" : "Carrusel de propiedades",
    agentId: `agent-${accountIndex + 1}`,
    agentName: accountIndex === 0 ? "Ana" : "Carlos",
    date: isoDate(day),
    level: "ad",
    metrics: {
      spend,
      reach,
      impressions,
      clicks,
      messages: Math.round(clicks * 0.18),
      conversations: Math.round(clicks * 0.14),
      leads,
      conversions: Math.max(0, Math.round(leads * 0.35)),
      interactions: Math.round(reach * 0.065),
    },
    currency: "BOB",
    timezone: "America/La_Paz",
    attributionWindow: "7d_click",
    breakdowns: { publisher_platform: "instagram", device_platform: "mobile" },
    apiVersion: "v25.0",
    extractedAt: "2026-08-31T12:00:00.000Z",
    quality: "complete",
    rawData: { source: "synthetic_visual_qa", objective: "OUTCOME_LEADS" },
  };
}

function organicAccountRow(day, accountIndex) {
  return {
    accountId: `${300 + accountIndex}`,
    accountName: accountIndex === 0 ? "Instagram Horizonte" : "Facebook Altura",
    campaignId: null,
    campaignName: null,
    adSetId: null,
    adSetName: null,
    adId: null,
    adName: null,
    date: isoDate(day),
    level: "organic_account",
    metrics: {
      reach: 540 + day * 17 + accountIndex * 90,
      views: 850 + day * 28 + accountIndex * 120,
      profileVisits: 28 + day + accountIndex * 4,
      interactions: 44 + day * 2 + accountIndex * 8,
      newFollowers: 3 + (day % 4),
      followerCount: 2_200 + day * 5 + accountIndex * 430,
    },
    currency: "BOB",
    timezone: "America/La_Paz",
    attributionWindow: null,
    breakdowns: {
      source: "meta_organic_insights",
      platform: accountIndex === 0 ? "instagram" : "facebook_page",
    },
    apiVersion: "v25.0",
    extractedAt: "2026-08-31T12:00:00.000Z",
    quality: "complete",
    rawData: { source: "synthetic_visual_qa" },
  };
}

function contentRow(day, index) {
  return {
    accountId: `${300 + (index % 2)}`,
    accountName: index % 2 === 0 ? "Instagram Horizonte" : "Facebook Altura",
    campaignId: null,
    campaignName: null,
    adSetId: null,
    adSetName: null,
    adId: null,
    adName: null,
    contentId: `content-${index + 1}`,
    contentName: index % 2 === 0 ? "Tour departamento Sopocachi" : "Consejos para comprar casa",
    contentType: index % 2 === 0 ? "reel" : "facebook_post",
    date: isoDate(day),
    level: "content",
    metrics: {
      reach: 1_100 + index * 230,
      views: 1_680 + index * 310,
      interactions: 125 + index * 18,
      saves: 21 + index * 4,
      shares: 13 + index * 3,
    },
    currency: "BOB",
    timezone: "America/La_Paz",
    attributionWindow: null,
    breakdowns: {
      source: "meta_organic_content_insights",
      platform: index % 2 === 0 ? "instagram" : "facebook_page",
    },
    apiVersion: "v25.0",
    extractedAt: "2026-08-31T12:00:00.000Z",
    quality: "complete",
    rawData: { source: "synthetic_visual_qa" },
  };
}

const rows = [];
for (let day = 17; day <= 30; day += 1) {
  for (let account = 0; account < 2; account += 1) {
    for (let campaign = 0; campaign < 2; campaign += 1) {
      rows.push(paidRow(day, account, campaign));
    }
    rows.push(organicAccountRow(day, account));
  }
}
rows.push(contentRow(24, 0), contentRow(26, 1), contentRow(28, 2), contentRow(30, 3));

await repository.upsertMany(scope, rows);
const reporting = new AgencyReportingService(repository);
const report = await reporting.createUnifiedWeeklyReport(scope, "2026-08-27");
const excel = new AgencyExcelReportGenerator().generate(report, {
  filename: "meta-agency-synthetic-visual-qa.xlsx",
  generatedAt: "2026-08-31T12:00:00.000Z",
});

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, excel.bytes);
process.stdout.write(`${outputPath}\n`);

import { describe, expect, it } from "vitest";
import {
  AgencyExcelReportGenerator,
  EXCEL_CONTENT_TYPE,
  EXCEL_REPORT_SHEETS,
  InMemoryHistoricalDataRepository,
  AgencyReportingService,
} from "../../src/agency/index.js";
import { metricFixture, tenantA } from "./fixtures.js";

function unzipStored(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries = new Map<string, string>();
  let offset = 0;
  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const compression = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const start = offset + 30;
    const name = decoder.decode(bytes.slice(start, start + nameLength));
    const contentStart = start + nameLength + extraLength;
    expect(compression).toBe(0);
    entries.set(name, decoder.decode(bytes.slice(contentStart, contentStart + compressedSize)));
    offset = contentStart + compressedSize;
  }
  return entries;
}

async function sampleReport() {
  const syntheticMetaToken = ["EAA", "12345678901234567890"].join("");
  const repository = new InMemoryHistoricalDataRepository();
  await repository.upsert(tenantA, metricFixture({
    date: "2026-08-10",
    rawData: {
      creative_name: "Apto Centro",
      saves: 3,
      shares: 2,
      access_token: "do-not-export",
      meta_token: syntheticMetaToken,
      source_url: "https://example.test/?access_token=hidden-value",
    },
  }));
  await repository.upsert(tenantA, metricFixture({
    date: "2026-08-11",
    adId: "ad-101",
    adName: "Casa Sur",
    campaignId: "campaign-101",
    campaignName: "Captación Sur",
    metrics: { spend: 50, reach: 500, impressions: 800, clicks: 40, messages: 5, leads: 2, interactions: 20 },
    rawData: { creative_name: "Casa Sur", saves: 4, shares: 1 },
  }));
  return new AgencyReportingService(repository).createWeeklyReport(tenantA, "2026-08-12");
}

describe("AgencyExcelReportGenerator", () => {
  it("creates an editable macro-free XLSX with every reporting worksheet and native charts", async () => {
    const report = await sampleReport();
    const result = new AgencyExcelReportGenerator().generate(report, { generatedAt: "2026-08-12T00:00:00.000Z" });
    const files = unzipStored(result.bytes);

    expect(result.contentType).toBe(EXCEL_CONTENT_TYPE);
    expect(result.filename).toBe("meta-agency-report-2026-08-10-to-2026-08-16.xlsx");
    const workbook = files.get("xl/workbook.xml") ?? "";
    expect(EXCEL_REPORT_SHEETS.every((name) => workbook.includes(`name=\"${name}\"`))).toBe(true);
    expect([...files.keys()].filter((name) => name.startsWith("xl/worksheets/sheet"))).toHaveLength(10);
    expect([...files.keys()].filter((name) => name.startsWith("xl/charts/chart"))).toHaveLength(10);
    expect(files.get("xl/drawings/_rels/drawing1.xml.rels")).toContain("charts/chart10.xml");
    expect(files.get("xl/worksheets/_rels/sheet2.xml.rels")).toContain("drawings/drawing1.xml");
    expect(files.get("xl/charts/chart1.xml")).toContain("Alcance diario");
    expect(files.get("xl/charts/chart10.xml")).toContain("Funnel");
    expect(files.get("xl/worksheets/sheet3.xml")).toContain("Semana desde");
    expect(files.get("xl/worksheets/sheet1.xml")).toContain('ySplit="4" topLeftCell="A5"');
    expect(files.get("xl/worksheets/sheet2.xml")).toContain('ySplit="2" topLeftCell="A3"');
    expect(files.get("xl/worksheets/sheet3.xml")).toContain('<autoFilter ref="A1:V2"/>');
    expect(files.get("xl/worksheets/sheet5.xml")).toContain('<autoFilter ref="A1:X3"/>');
    expect(files.get("xl/worksheets/sheet8.xml")).toContain('<autoFilter ref="A1:M3"/>');
    expect(files.get("xl/worksheets/sheet10.xml")).toContain('<autoFilter ref="A1:AQ3"/>');
    expect(files.get("xl/worksheets/sheet10.xml")).toContain('ySplit="1" topLeftCell="A2"');
    expect(files.get("xl/worksheets/sheet1.xml")).toContain("<v>0.05</v>");
    expect(files.get("xl/worksheets/sheet2.xml")).toContain(
      "<f>&apos;Resumen Ejecutivo&apos;!B5</f><v>1500</v>",
    );
    expect(files.get("xl/worksheets/sheet2.xml")).toContain(
      'min="16" max="16384" width="2" hidden="1"',
    );
    expect(files.get("xl/charts/chart1.xml")).toContain("<c:plotVisOnly val=\"0\"/>");
    expect([...files.keys()].some((name) => /vbaProject|\.xlsm/i.test(name))).toBe(false);
  });

  it("keeps raw analytical data but strips credential-shaped values and formula injection", async () => {
    const report = await sampleReport();
    const before = JSON.stringify(report.rawRows);
    const result = new AgencyExcelReportGenerator().generate(report, { generatedAt: "2026-08-12T00:00:00.000Z" });
    const text = new TextDecoder().decode(result.bytes);
    const rawSheet = unzipStored(result.bytes).get("xl/worksheets/sheet10.xml") ?? "";

    expect(JSON.stringify(report.rawRows)).toBe(before);
    expect(rawSheet).toContain("creative_name");
    expect(rawSheet).toContain("[REDACTED]");
    expect(text).not.toContain("do-not-export");
    expect(text).not.toContain(["EAA", "12345678901234567890"].join(""));
    expect(text).not.toContain("hidden-value");
    expect(rawSheet).toContain("tenant_scope");
    expect(rawSheet).not.toContain(tenantA.tenantId);
    expect(unzipStored(result.bytes).get("xl/worksheets/sheet2.xml")).toContain("&apos;Resumen Ejecutivo&apos;!B5");
  });

  it("rejects unsafe output filenames instead of producing a path-like artifact", async () => {
    const report = await sampleReport();
    expect(() => new AgencyExcelReportGenerator().generate(report, { filename: "../report.xlsm" })).toThrow("safe .xlsx");
  });

  it("renders typed organic content metrics without treating content as an ad", async () => {
    const repository = new InMemoryHistoricalDataRepository();
    await repository.upsert(tenantA, metricFixture({
      level: "content",
      campaignId: null,
      campaignName: null,
      adSetId: null,
      adSetName: null,
      adId: null,
      adName: null,
      contentId: "7001",
      contentName: "Departamento Centro Reel",
      contentType: "reel",
      metrics: { reach: 1_000, views: 1_500, interactions: 120, saves: 18, shares: 12 },
      attributionWindow: null,
      breakdowns: { source: "meta_organic_content_insights", platform: "instagram" },
      rawData: { source: "synthetic-organic-content" },
    }));
    const report = await new AgencyReportingService(repository).createWeeklyReport(
      tenantA,
      "2026-08-12",
      "content",
    );
    const result = new AgencyExcelReportGenerator().generate(report, {
      generatedAt: "2026-08-12T00:00:00.000Z",
    });
    const files = unzipStored(result.bytes);
    const contentSheet = files.get("xl/worksheets/sheet8.xml") ?? "";
    const rawSheet = files.get("xl/worksheets/sheet10.xml") ?? "";

    expect(contentSheet).toContain("7001");
    expect(contentSheet).toContain("Departamento Centro Reel");
    expect(contentSheet).toContain("reel");
    expect(contentSheet).toContain("<v>18</v>");
    expect(contentSheet).toContain("<v>12</v>");
    expect(rawSheet).toContain("content_id");
    expect(rawSheet).toContain("content_type");
  });

  it("creates one unified workbook while keeping paid, organic, and content datasets separate", async () => {
    const repository = new InMemoryHistoricalDataRepository();
    await repository.upsert(tenantA, metricFixture({
      metrics: { spend: 100, reach: 1_000, impressions: 2_000, clicks: 100, leads: 5 },
    }));
    await repository.upsert(tenantA, metricFixture({
      level: "organic_account",
      campaignId: null,
      campaignName: null,
      adSetId: null,
      adSetName: null,
      adId: null,
      adName: null,
      metrics: { reach: 700, views: 900, profileVisits: 40, newFollowers: 8 },
      attributionWindow: null,
      breakdowns: { source: "meta_organic_insights", platform: "instagram" },
      rawData: { source: "synthetic-organic-account" },
    }));
    await repository.upsert(tenantA, metricFixture({
      level: "content",
      campaignId: null,
      campaignName: null,
      adSetId: null,
      adSetName: null,
      adId: null,
      adName: null,
      contentId: "7001",
      contentName: "Reel Departamento Centro",
      contentType: "reel",
      metrics: { reach: 500, views: 800, interactions: 90, saves: 12, shares: 8 },
      attributionWindow: null,
      breakdowns: { source: "meta_organic_content_insights", platform: "instagram" },
      rawData: { source: "synthetic-organic-content" },
    }));
    const report = await new AgencyReportingService(repository).createUnifiedWeeklyReport(
      tenantA,
      "2026-08-12",
    );
    const result = new AgencyExcelReportGenerator().generate(report, {
      generatedAt: "2026-08-12T00:00:00.000Z",
    });
    const files = unzipStored(result.bytes);
    const summary = files.get("xl/worksheets/sheet1.xml") ?? "";
    const dashboard = files.get("xl/worksheets/sheet2.xml") ?? "";
    const contentSheet = files.get("xl/worksheets/sheet8.xml") ?? "";
    const digitalSheet = files.get("xl/worksheets/sheet9.xml") ?? "";
    const rawSheet = files.get("xl/worksheets/sheet10.xml") ?? "";

    expect(summary).toContain("Orgánico de cuenta");
    expect(summary).toContain("Contenido orgánico publicado");
    expect(summary).not.toContain("<v>2200</v>");
    expect(dashboard).toContain("Dataset organic_account; no sumado con Ads");
    expect(contentSheet).toContain("Reel Departamento Centro");
    expect(digitalSheet).toContain("Datasets separados; no sumar alcance entre fuentes.");
    expect(digitalSheet).toContain("Meta Ads");
    expect(rawSheet).toContain("organic_account");
    expect(rawSheet).toContain("content");
    expect(files.get("xl/charts/chart9.xml")).toContain("Reel Departamento Centro");
  });
});

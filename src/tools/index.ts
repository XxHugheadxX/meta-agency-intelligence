import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAccountTools } from "./accounts.js";
import { registerCampaignTools } from "./campaigns.js";
import { registerAdSetTools } from "./adsets.js";
import { registerAdTools } from "./ads.js";
import { registerCreativeTools } from "./creatives.js";
import { registerCreativeMediaTools } from "./creative-media.js";
import { registerInsightsTools } from "./insights.js";
import { registerInsightsViewTools } from "./insights-views.js";
import { registerTargetingTools } from "./targeting.js";
import { registerBudgetTools } from "./budget.js";
import { registerLeadTools } from "./leads.js";
import { registerAudienceTools } from "./audiences.js";
import { registerPreviewTools } from "./previews.js";
import { registerPixelTools } from "./pixels.js";
import { registerCommentTools } from "./comments.js";
import { registerRuleTools } from "./rules.js";
import { registerABTestingTools } from "./abtesting.js";
import { registerReportTools } from "./reports.js";
import { registerBillingTools } from "./billing.js";
import { registerTokenTools } from "./tokens.js";
import { registerInstagramTools } from "./instagram.js";
import { registerAdsLibraryTools } from "./ads-library.js";
import { registerRateStatusTools } from "./rate-status.js";
import { registerEntityTools } from "./entities.js";
import { registerDiagnosticTools } from "./diagnostics.js";
import { registerHelpTools } from "./help.js";
import { registerMacroTools } from "./macros.js";
import { registerBulkAdTools } from "./bulk-ads.js";
import { registerWhatsAppTools } from "./whatsapp.js";
import { registerWhatsAppTemplateTools } from "./whatsapp-templates.js";
import { registerWhatsAppFlowTools } from "./whatsapp-flows.js";
import { registerWhatsAppConfigTools } from "./whatsapp-config.js";

/**
 * Register all Meta Ads tools on the MCP server.
 *
 * v3.0.0 alignment with Meta's official MCP vocabulary:
 *   - all tools prefixed `ads_*` (no more `meta_ads_*`)
 *   - `ad_set` (with underscore) replaces `adset`
 *   - all tools annotated with ToolAnnotations (readOnlyHint / destructiveHint)
 *   - 5 named insight views + diagnostic + help + agency macro-tools added
 */
export function registerAllTools(server: McpServer): void {
  registerToolsWithPolicy(server, {
    mode: process.env.MCP_MODE === "write" ? "write" : "read_only",
    allowLeadPii: process.env.ALLOW_LEAD_PII === "true",
  });
}

export interface ToolRegistrationPolicy {
  mode: "read_only" | "write";
  allowLeadPii: boolean;
}

/**
 * Fail-closed capability catalog for the reporting deployment. A newly added
 * tool is unavailable in read-only mode until its exact name is reviewed and
 * added here. Lead rows, credential administration, paid external calls,
 * WhatsApp and all mutating tools are intentionally absent.
 */
const PURE_READ_TOOL_ALLOWLIST = new Set([
  "ads_diagnose_underperformance",
  "ads_estimate_audience_size",
  "ads_generate_preview",
  "ads_get_account_info",
  "ads_get_ad_accounts",
  "ads_get_ad_comments",
  "ads_get_ad_creatives",
  "ads_get_ad_details",
  "ads_get_ad_entities",
  "ads_get_ad_images",
  "ads_get_ad_preview",
  "ads_get_ad_rules",
  "ads_get_ad_set_details",
  "ads_get_ad_sets",
  "ads_get_ad_studies",
  "ads_get_ad_videos",
  "ads_get_ads",
  "ads_get_audience_details",
  "ads_get_audience_shared_accounts",
  "ads_get_billing_info",
  "ads_get_campaign_details",
  "ads_get_campaigns",
  "ads_get_creative_details",
  "ads_get_creative_media",
  "ads_get_custom_audiences",
  "ads_get_custom_conversions",
  "ads_get_dataset_quality",
  "ads_get_errors",
  "ads_get_help_article",
  "ads_get_insights",
  "ads_get_instagram_account",
  "ads_get_instagram_media",
  "ads_get_interest_suggestions",
  "ads_get_invoices",
  "ads_get_lead_forms",
  "ads_get_opportunity_score",
  "ads_get_pages_for_business",
  "ads_get_pixel_details",
  "ads_get_pixel_events",
  "ads_get_pixels",
  "ads_get_report_results",
  "ads_get_report_status",
  "ads_get_rule_details",
  "ads_get_spend_limit",
  "ads_get_study_details",
  "ads_get_targeting_description",
  "ads_get_video_details",
  "ads_insights_advertiser_context",
  "ads_insights_anomaly_signal",
  "ads_insights_auction_ranking_benchmarks",
  "ads_insights_industry_benchmark",
  "ads_insights_performance_trend",
  "ads_portfolio_summary",
  "ads_rate_status",
  "ads_search_behaviors",
  "ads_search_demographics",
  "ads_search_geo_locations",
  "ads_search_interests",
]);

const LEAD_PII_TOOLS = new Set(["ads_get_leads", "ads_get_ad_leads"]);

/**
 * Register tools through a server-side capability gate. Tool annotations are
 * useful UI hints, but this wrapper turns them into an enforceable policy: a
 * write handler is never registered in a read-only process.
 */
export function registerToolsWithPolicy(
  server: McpServer,
  policy: ToolRegistrationPolicy,
): void {
  const effectiveServer = policy.mode === "read_only"
    ? readOnlyServerView(server, policy)
    : server;

  // ─── Core Ad Management ─────────────────────────────────
  registerAccountTools(effectiveServer);      // 3 tools
  registerCampaignTools(effectiveServer);     // 5 tools
  registerAdSetTools(effectiveServer);        // 6 tools
  registerAdTools(effectiveServer);           // 6 tools
  registerCreativeTools(effectiveServer);     // 9 tools
  registerCreativeMediaTools(effectiveServer); // 1 tool — creative media as inline image blocks
  registerEntityTools(effectiveServer);       // 3 tools — generic helpers (get_ad_entities, update_entity, activate_entity)
  registerInsightsTools(effectiveServer);     // 1 tool  — power-tool ads_get_insights
  registerInsightsViewTools(effectiveServer); // 5 tools — semantic insight views
  registerTargetingTools(effectiveServer);    // 7 tools
  registerBudgetTools(effectiveServer);       // 1 tool

  // ─── Extended Features ──────────────────────────────────
  registerLeadTools(effectiveServer);         // 4 tools — Lead forms & lead download
  registerAudienceTools(effectiveServer);     // 8 tools — Custom & lookalike audiences (+ share/unshare/get-shared-accounts)
  registerPreviewTools(effectiveServer);      // 2 tools — Ad preview links
  registerPixelTools(effectiveServer);        // 5 tools — Pixel & events manager
  registerCommentTools(effectiveServer);      // 4 tools — Ad comment moderation
  registerRuleTools(effectiveServer);         // 5 tools — Automated rules
  registerABTestingTools(effectiveServer);    // 3 tools — A/B split testing
  registerReportTools(effectiveServer);       // 4 tools — Async scheduled reports (+ run_and_wait)
  registerBillingTools(effectiveServer);      // 4 tools — Billing, spend limits & invoices
  registerRateStatusTools(effectiveServer);   // 1 tool — Rate-limit usage + circuit status

  // ─── Diagnostics & Help ─────────────────────────────────
  registerDiagnosticTools(effectiveServer);   // 3 tools — opportunity_score, dataset_quality, errors
  registerHelpTools(effectiveServer);         // 1 tool  — help_article search

  // ─── Agency Macros (cross-account) ──────────────────────
  registerMacroTools(effectiveServer);        // 2 tools — diagnose_underperformance, portfolio_summary
  registerBulkAdTools(effectiveServer);       // 1 tool  — ads_bulk_create_video_ads (upload → creative → ad)

  // ─── Instagram ──────────────────────────────────────────
  registerInstagramTools(effectiveServer);    // 2 tools — IG account & media lookup

  // ─── WhatsApp Business ──────────────────────────────────
  registerWhatsAppTools(effectiveServer);         // 8 tools — WABAs, phone numbers, business profile
  registerWhatsAppTemplateTools(effectiveServer); // 6 tools — message templates + analytics
  registerWhatsAppFlowTools(effectiveServer);     // 6 tools — WhatsApp Flows lifecycle
  registerWhatsAppConfigTools(effectiveServer);   // 7 tools — QR deep links + webhook subscriptions

  // ─── Ad Library scraping (Apify) ─────────────────────────
  registerAdsLibraryTools(effectiveServer);   // 8 tools — competitor ad research via Apify + token mgmt

  // ─── Token Management ────────────────────────────────────
  registerTokenTools(effectiveServer);        // 4 tools — list / set-active / register / delete

  // Total: 135 tools (79 renamed + 14 new in v3 + 3 audience-sharing + 1 invoices + 27 WhatsApp + 1 url-tags + 1 bulk video ads + 1 creative media + 8 Ad Library/Apify)
}

function readOnlyServerView(
  server: McpServer,
  policy: ToolRegistrationPolicy,
): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "registerTool") {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }

      return (...args: unknown[]) => {
        const name = typeof args[0] === "string" ? args[0] : "";
        const config = args[1] as { annotations?: { readOnlyHint?: boolean } } | undefined;
        const isPureRead = config?.annotations?.readOnlyHint === true;
        const isExplicitlyAllowed =
          PURE_READ_TOOL_ALLOWLIST.has(name) ||
          (policy.allowLeadPii && LEAD_PII_TOOLS.has(name));

        if (!isPureRead || !isExplicitlyAllowed) {
          return undefined;
        }
        return Reflect.apply(target.registerTool, target, args);
      };
    },
  });
}

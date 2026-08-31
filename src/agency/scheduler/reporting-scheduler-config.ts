import type { SecurityConfig } from "../../transport/security-config.js";

export type ReportingSchedulerConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly signingKeyVersion: string;
      readonly pubSubTopic: string;
      readonly triggerAudience: string;
      readonly triggerServiceAccountEmail: string;
      readonly triggerServiceAccountSubject: string;
      readonly timeZone: string;
      readonly apiVersion: string;
      readonly attributionWindow: string | null;
      readonly retentionDays: number;
      readonly ingestionLookbackDays: number;
    };

function value(env: NodeJS.ProcessEnv, key: string): string {
  return env[key]?.trim() ?? "";
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const resolved = value(env, key);
  if (!resolved) throw new Error(`${key} is required when the reporting scheduler is enabled`);
  return resolved;
}

function firestoreConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    value(env, "FIRESTORE_PROJECT_ID") ||
    value(env, "GOOGLE_CLOUD_PROJECT") ||
    value(env, "FIRESTORE_EMULATOR_HOST"),
  );
}

function integerSetting(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = Number(value(env, key) || String(fallback));
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${key} must be between ${minimum} and ${maximum}`);
  }
  return resolved;
}

export function resolveReportingSchedulerConfig(
  security: SecurityConfig,
  env: NodeJS.ProcessEnv = process.env,
): ReportingSchedulerConfig {
  const enabled = value(env, "AGENCY_REPORTING_SCHEDULER_ENABLED").toLowerCase();
  if (!enabled || enabled === "false") return { enabled: false };
  if (enabled !== "true") {
    throw new Error("AGENCY_REPORTING_SCHEDULER_ENABLED must be true or false");
  }
  if (security.mcpMode !== "read_only") {
    throw new Error("Agency reporting scheduler requires MCP_MODE=read_only");
  }
  if (!security.multiTenantEnabled) {
    throw new Error("Agency reporting scheduler requires multi-tenant Meta OAuth");
  }
  if (!firestoreConfigured(env)) {
    throw new Error("Agency reporting scheduler requires Firestore");
  }
  const timeZone = required(env, "AGENCY_REPORTING_TIME_ZONE");
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date(0));
  } catch {
    throw new Error("AGENCY_REPORTING_TIME_ZONE must be a valid IANA time zone");
  }
  const apiVersion = required(env, "META_API_VERSION");
  if (!/^v[0-9]+[.][0-9]+$/.test(apiVersion)) {
    throw new Error("META_API_VERSION must use vN.N format");
  }
  const attributionWindow = value(env, "AGENCY_REPORTING_ATTRIBUTION_WINDOW") || "7d_click";
  if (attributionWindow.length > 64) {
    throw new Error("AGENCY_REPORTING_ATTRIBUTION_WINDOW is invalid");
  }
  return {
    enabled: true,
    signingKeyVersion: required(env, "AGENCY_REPORTING_SIGNING_KEY_VERSION"),
    pubSubTopic: required(env, "AGENCY_REPORTING_PUBSUB_TOPIC"),
    triggerAudience: required(env, "AGENCY_REPORTING_TRIGGER_AUDIENCE"),
    triggerServiceAccountEmail: required(
      env,
      "AGENCY_REPORTING_TRIGGER_SERVICE_ACCOUNT",
    ),
    triggerServiceAccountSubject: required(env, "AGENCY_REPORTING_TRIGGER_SUBJECT"),
    timeZone,
    apiVersion,
    attributionWindow,
    retentionDays: integerSetting(env, "AGENCY_REPORTING_RETENTION_DAYS", 90, 1, 365),
    ingestionLookbackDays: integerSetting(
      env,
      "AGENCY_REPORTING_INGESTION_LOOKBACK_DAYS",
      2,
      0,
      30,
    ),
  };
}

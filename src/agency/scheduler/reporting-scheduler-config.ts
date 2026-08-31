import type { SecurityConfig } from "../../transport/security-config.js";

export type ReportingSchedulerConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly signingKeyVersion: string;
      readonly pubSubTopic: string;
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
  return {
    enabled: true,
    signingKeyVersion: required(env, "AGENCY_REPORTING_SIGNING_KEY_VERSION"),
    pubSubTopic: required(env, "AGENCY_REPORTING_PUBSUB_TOPIC"),
  };
}

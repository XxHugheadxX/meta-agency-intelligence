import { createPublicKey } from "node:crypto";
import type { SecurityConfig } from "../../transport/security-config.js";
import { MAX_LEASE_TTL_MS, MIN_LEASE_TTL_MS } from "./reporting-job-lease-repository.js";

export type ReportingJobRuntimeConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly audience: string;
      readonly serviceAccountEmail: string;
      readonly serviceAccountSubject: string;
      readonly jobPublicKey: string;
      readonly reportBucket: string;
      readonly leaseTtlMs: number;
    };

function value(env: NodeJS.ProcessEnv, key: string): string {
  return env[key]?.trim() ?? "";
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const resolved = value(env, key);
  if (!resolved) throw new Error(`${key} is required when agency reporting jobs are enabled`);
  return resolved;
}

function firestoreConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    value(env, "FIRESTORE_PROJECT_ID") ||
    value(env, "GOOGLE_CLOUD_PROJECT") ||
    value(env, "FIRESTORE_EMULATOR_HOST"),
  );
}

export function resolveReportingJobRuntimeConfig(
  security: SecurityConfig,
  env: NodeJS.ProcessEnv = process.env,
): ReportingJobRuntimeConfig {
  const enabled = value(env, "AGENCY_REPORTING_JOBS_ENABLED").toLowerCase();
  if (!enabled || enabled === "false") return { enabled: false };
  if (enabled !== "true") throw new Error("AGENCY_REPORTING_JOBS_ENABLED must be true or false");
  if (security.mcpMode !== "read_only") throw new Error("Agency reporting jobs require MCP_MODE=read_only");
  if (!security.multiTenantEnabled) throw new Error("Agency reporting jobs require multi-tenant Meta OAuth");
  if (!firestoreConfigured(env)) throw new Error("Agency reporting jobs require Firestore");

  const audience = required(env, "AGENCY_SCHEDULER_AUDIENCE");
  const serviceAccountEmail = required(env, "AGENCY_SCHEDULER_SERVICE_ACCOUNT");
  const serviceAccountSubject = required(env, "AGENCY_SCHEDULER_SUBJECT");
  const jobPublicKey = required(env, "AGENCY_REPORTING_JOB_PUBLIC_KEY");
  const reportBucket = required(env, "REPORTS_GCS_BUCKET");
  try {
    const key = createPublicKey(jobPublicKey);
    if (key.type !== "public") throw new Error("not public");
  } catch {
    throw new Error("AGENCY_REPORTING_JOB_PUBLIC_KEY must contain a valid public key");
  }

  const rawTtl = value(env, "AGENCY_REPORTING_LEASE_TTL_MS") || "60000";
  const leaseTtlMs = Number(rawTtl);
  if (
    !Number.isInteger(leaseTtlMs) ||
    leaseTtlMs < MIN_LEASE_TTL_MS ||
    leaseTtlMs > MAX_LEASE_TTL_MS
  ) {
    throw new Error(
      `AGENCY_REPORTING_LEASE_TTL_MS must be between ${MIN_LEASE_TTL_MS} and ${MAX_LEASE_TTL_MS}`,
    );
  }

  return {
    enabled: true,
    audience,
    serviceAccountEmail,
    serviceAccountSubject,
    jobPublicKey,
    reportBucket,
    leaseTtlMs,
  };
}

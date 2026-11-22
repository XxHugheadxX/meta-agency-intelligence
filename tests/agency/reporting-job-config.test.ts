import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SecurityConfig } from "../../src/transport/security-config.js";
import { resolveReportingJobRuntimeConfig } from "../../src/agency/worker/index.js";

const readOnlySecurity: SecurityConfig = {
  metaAppConfigured: true,
  allowlistConfigured: true,
  multiTenantEnabled: true,
  mcpMode: "read_only",
  allowLeadPii: false,
};
const PUBLIC_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .publicKey.export({ type: "spki", format: "pem" }).toString();

function enabledEnv(): NodeJS.ProcessEnv {
  return {
    AGENCY_REPORTING_JOBS_ENABLED: "true",
    AGENCY_SCHEDULER_AUDIENCE: "https://service.example.test/internal/agency/reporting/jobs",
    AGENCY_SCHEDULER_SERVICE_ACCOUNT: "scheduler@example.iam.gserviceaccount.com",
    AGENCY_SCHEDULER_SUBJECT: "123456789012345678901",
    AGENCY_REPORTING_JOB_PUBLIC_KEY: PUBLIC_KEY,
    REPORTS_GCS_BUCKET: "private-agency-reports",
    FIRESTORE_PROJECT_ID: "agency-project",
  };
}

describe("reporting job runtime configuration", () => {
  it("is disabled by default without reading reporting secrets", () => {
    expect(resolveReportingJobRuntimeConfig(readOnlySecurity, {})).toEqual({ enabled: false });
  });

  it("accepts a complete read-only multi-tenant configuration", () => {
    expect(resolveReportingJobRuntimeConfig(readOnlySecurity, enabledEnv())).toMatchObject({
      enabled: true,
      reportBucket: "private-agency-reports",
      leaseTtlMs: 60_000,
    });
  });

  it.each([
    "AGENCY_SCHEDULER_AUDIENCE",
    "AGENCY_SCHEDULER_SERVICE_ACCOUNT",
    "AGENCY_SCHEDULER_SUBJECT",
    "AGENCY_REPORTING_JOB_PUBLIC_KEY",
    "REPORTS_GCS_BUCKET",
  ])("fails closed when %s is missing", (key) => {
    const env = enabledEnv();
    delete env[key];
    expect(() => resolveReportingJobRuntimeConfig(readOnlySecurity, env)).toThrow(key);
  });

  it("rejects write mode, single-tenant mode, and missing Firestore", () => {
    expect(() => resolveReportingJobRuntimeConfig(
      { ...readOnlySecurity, mcpMode: "write" },
      enabledEnv(),
    )).toThrow("read_only");
    expect(() => resolveReportingJobRuntimeConfig(
      { ...readOnlySecurity, multiTenantEnabled: false },
      enabledEnv(),
    )).toThrow("multi-tenant");
    const env = enabledEnv();
    delete env.FIRESTORE_PROJECT_ID;
    expect(() => resolveReportingJobRuntimeConfig(readOnlySecurity, env)).toThrow("Firestore");
  });

  it("rejects invalid public keys and lease TTL values", () => {
    expect(() => resolveReportingJobRuntimeConfig(readOnlySecurity, {
      ...enabledEnv(),
      AGENCY_REPORTING_JOB_PUBLIC_KEY: "not-a-key",
    })).toThrow("valid public key");
    expect(() => resolveReportingJobRuntimeConfig(readOnlySecurity, {
      ...enabledEnv(),
      AGENCY_REPORTING_LEASE_TTL_MS: "9999999",
    })).toThrow("LEASE_TTL_MS");
  });
});

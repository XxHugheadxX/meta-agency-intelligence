import { generateKeyPairSync } from "node:crypto";
import type { Firestore } from "@google-cloud/firestore";
import { describe, expect, it, vi } from "vitest";
import { createReportingJobEndpointDependencies } from "../../src/agency/worker/index.js";
import type { SecurityConfig } from "../../src/transport/security-config.js";

const security: SecurityConfig = {
  metaAppConfigured: true,
  allowlistConfigured: true,
  multiTenantEnabled: true,
  mcpMode: "read_only",
  allowLeadPii: false,
};
const publicKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .publicKey.export({ type: "spki", format: "pem" }).toString();

function enabledEnv(): NodeJS.ProcessEnv {
  return {
    AGENCY_REPORTING_JOBS_ENABLED: "true",
    AGENCY_SCHEDULER_AUDIENCE: "https://service.example.test/internal/agency/reporting/jobs",
    AGENCY_SCHEDULER_SERVICE_ACCOUNT: "scheduler@example.iam.gserviceaccount.com",
    AGENCY_SCHEDULER_SUBJECT: "123456789012345678901",
    AGENCY_REPORTING_JOB_PUBLIC_KEY: publicKey,
    REPORTS_GCS_BUCKET: "private-agency-reports",
    FIRESTORE_PROJECT_ID: "agency-project",
  };
}

describe("reporting job production bootstrap", () => {
  it("does not initialize Firestore while reporting jobs are disabled", () => {
    const getDb = vi.fn();
    expect(createReportingJobEndpointDependencies({
      getDb,
      security,
      serverUrl: new URL("https://service.example.test/"),
      env: {},
    })).toBeNull();
    expect(getDb).not.toHaveBeenCalled();
  });

  it("composes the authenticated worker only after the full gate passes", () => {
    const getDb = vi.fn(() => ({} as Firestore));
    const dependencies = createReportingJobEndpointDependencies({
      getDb,
      security,
      serverUrl: new URL("https://service.example.test/"),
      env: enabledEnv(),
    });
    expect(dependencies).toMatchObject({
      worker: { run: expect.any(Function) },
      identities: { verify: expect.any(Function) },
    });
    expect(getDb).toHaveBeenCalledOnce();
  });

  it("fails before Firestore initialization when a required value is missing", () => {
    const env = enabledEnv();
    delete env.REPORTS_GCS_BUCKET;
    const getDb = vi.fn();
    expect(() => createReportingJobEndpointDependencies({
      getDb,
      security,
      serverUrl: new URL("https://service.example.test/"),
      env,
    })).toThrow("REPORTS_GCS_BUCKET");
    expect(getDb).not.toHaveBeenCalled();
  });
});

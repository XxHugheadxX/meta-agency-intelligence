import type { Firestore } from "@google-cloud/firestore";
import { describe, expect, it, vi } from "vitest";
import {
  createReportingScheduler,
  resolveReportingSchedulerConfig,
} from "../../src/agency/scheduler/index.js";
import type { SecurityConfig } from "../../src/transport/security-config.js";

const security: SecurityConfig = {
  metaAppConfigured: true,
  allowlistConfigured: true,
  multiTenantEnabled: true,
  mcpMode: "read_only",
  allowLeadPii: false,
};

function enabledEnv(): NodeJS.ProcessEnv {
  return {
    AGENCY_REPORTING_SCHEDULER_ENABLED: "true",
    AGENCY_REPORTING_SIGNING_KEY_VERSION:
      "projects/agency-test-123/locations/us-central1/keyRings/reporting/cryptoKeys/job-signing/cryptoKeyVersions/1",
    AGENCY_REPORTING_PUBSUB_TOPIC:
      "projects/agency-test-123/topics/agency-reporting-jobs",
    FIRESTORE_PROJECT_ID: "agency-test-123",
  };
}

describe("reporting scheduler production bootstrap", () => {
  it("is disabled by default without initializing Firestore", () => {
    const getDb = vi.fn();
    expect(createReportingScheduler({ getDb, security, env: {} })).toBeNull();
    expect(getDb).not.toHaveBeenCalled();
  });

  it("composes Firestore, KMS, and Pub/Sub only after the full gate passes", () => {
    const getDb = vi.fn(() => ({} as Firestore));
    const scheduler = createReportingScheduler({ getDb, security, env: enabledEnv() });
    expect(scheduler).not.toBeNull();
    expect(scheduler?.publish).toBeTypeOf("function");
    expect(getDb).toHaveBeenCalledOnce();
  });

  it.each([
    "AGENCY_REPORTING_SIGNING_KEY_VERSION",
    "AGENCY_REPORTING_PUBSUB_TOPIC",
  ])("fails before Firestore initialization when %s is missing", (key) => {
    const env = enabledEnv();
    delete env[key];
    const getDb = vi.fn();
    expect(() => createReportingScheduler({ getDb, security, env })).toThrow(key);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("rejects write mode, single-tenant mode, and missing Firestore", () => {
    expect(() => resolveReportingSchedulerConfig(
      { ...security, mcpMode: "write" },
      enabledEnv(),
    )).toThrow("read_only");
    expect(() => resolveReportingSchedulerConfig(
      { ...security, multiTenantEnabled: false },
      enabledEnv(),
    )).toThrow("multi-tenant");
    const env = enabledEnv();
    delete env.FIRESTORE_PROJECT_ID;
    expect(() => resolveReportingSchedulerConfig(security, env)).toThrow("Firestore");
  });

  it("rejects unsafe KMS and Pub/Sub resource names before reading Firestore", () => {
    const getDb = vi.fn();
    expect(() => createReportingScheduler({
      getDb,
      security,
      env: { ...enabledEnv(), AGENCY_REPORTING_PUBSUB_TOPIC: "https://attacker.test" },
    })).toThrow("topic name");
    expect(() => createReportingScheduler({
      getDb,
      security,
      env: { ...enabledEnv(), AGENCY_REPORTING_SIGNING_KEY_VERSION: "../key" },
    })).toThrow("key version name");
    expect(getDb).not.toHaveBeenCalled();
  });
});

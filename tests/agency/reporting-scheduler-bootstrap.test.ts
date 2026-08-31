import type { Firestore } from "@google-cloud/firestore";
import { describe, expect, it, vi } from "vitest";
import {
  createReportingScheduleEndpointDependencies,
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
    AGENCY_REPORTING_TRIGGER_AUDIENCE:
      "https://service.example.test/internal/agency/reporting/schedules",
    AGENCY_REPORTING_TRIGGER_SERVICE_ACCOUNT:
      "agency-reporting-trigger@agency-test-123.iam.gserviceaccount.com",
    AGENCY_REPORTING_TRIGGER_SUBJECT: "123456789012345678901",
    AGENCY_REPORTING_TIME_ZONE: "America/La_Paz",
    META_API_VERSION: "v23.0",
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

  it("composes the OIDC-protected schedule endpoint with no private key", () => {
    const getDb = vi.fn(() => ({} as Firestore));
    const dependencies = createReportingScheduleEndpointDependencies({
      getDb,
      security,
      env: enabledEnv(),
    });
    expect(dependencies).not.toBeNull();
    expect(dependencies?.scheduler.publish).toBeTypeOf("function");
    expect(dependencies?.identities.verify).toBeTypeOf("function");
    expect(dependencies?.options).toEqual({
      timeZone: "America/La_Paz",
      apiVersion: "v23.0",
      attributionWindow: "7d_click",
      retentionDays: 90,
      ingestionLookbackDays: 2,
    });
    expect(JSON.stringify(dependencies)).not.toMatch(/private.?key/i);
    expect(getDb).toHaveBeenCalledOnce();
  });

  it.each([
    "AGENCY_REPORTING_SIGNING_KEY_VERSION",
    "AGENCY_REPORTING_PUBSUB_TOPIC",
    "AGENCY_REPORTING_TRIGGER_AUDIENCE",
    "AGENCY_REPORTING_TRIGGER_SERVICE_ACCOUNT",
    "AGENCY_REPORTING_TRIGGER_SUBJECT",
    "AGENCY_REPORTING_TIME_ZONE",
    "META_API_VERSION",
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

  it("rejects invalid calendar and retention settings", () => {
    expect(() => resolveReportingSchedulerConfig(security, {
      ...enabledEnv(),
      AGENCY_REPORTING_TIME_ZONE: "Not/AZone",
    })).toThrow("IANA");
    expect(() => resolveReportingSchedulerConfig(security, {
      ...enabledEnv(),
      AGENCY_REPORTING_RETENTION_DAYS: "0",
    })).toThrow("RETENTION_DAYS");
    expect(() => resolveReportingSchedulerConfig(security, {
      ...enabledEnv(),
      META_API_VERSION: "v23.0-preview",
    })).toThrow("vN.N");
  });
});

import { assertReportingScope, type ReportingScope } from "../historical-data/index.js";
import type { ReportingFailureKind } from "./retry-policy.js";

const FAILURE_KINDS = new Set<ReportingFailureKind>([
  "busy",
  "transient",
  "rate_limited",
  "abuse_signal",
  "authentication",
  "validation",
  "unknown",
]);

export interface ReportingDeadLetterInput extends ReportingScope {
  readonly jobId: string;
  readonly requestFingerprint: string;
  readonly attempts: number;
  readonly failureKind: ReportingFailureKind;
  readonly occurredAt: string;
}

export interface ReportingDeadLetterRecord extends ReportingDeadLetterInput {
  readonly schemaVersion: 1;
}

export function createReportingDeadLetterRecord(
  input: ReportingDeadLetterInput,
): ReportingDeadLetterRecord {
  assertReportingScope(input);
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.jobId)) {
    throw new Error("Dead-letter jobId is invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(input.requestFingerprint)) {
    throw new Error("Dead-letter requestFingerprint must be a lowercase SHA-256 digest");
  }
  if (!Number.isSafeInteger(input.attempts) || input.attempts < 1) {
    throw new Error("Dead-letter attempts must be a positive safe integer");
  }
  if (!FAILURE_KINDS.has(input.failureKind)) {
    throw new Error("Dead-letter failureKind is invalid");
  }
  const occurredAt = Date.parse(input.occurredAt);
  if (Number.isNaN(occurredAt) || new Date(occurredAt).toISOString() !== input.occurredAt) {
    throw new Error("Dead-letter occurredAt must be an ISO instant");
  }
  return {
    schemaVersion: 1,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    requestFingerprint: input.requestFingerprint,
    attempts: input.attempts,
    failureKind: input.failureKind,
    occurredAt: input.occurredAt,
  };
}

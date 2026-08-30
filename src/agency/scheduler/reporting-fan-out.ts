import { createHash } from "node:crypto";
import {
  assertIsoDate,
  assertReportingScope,
  type HistoricalMetricLevel,
  type ReportingScope,
} from "../historical-data/index.js";
import type { ReportingJobPayload } from "../worker/types.js";
import {
  parseSignedReportingMessage,
  type SignedReportingMessage,
} from "./pubsub-envelope.js";

const MAX_SCHEDULED_ACCOUNTS = 100;

export interface ScheduledReportingAccount extends ReportingScope {
  readonly accountId: string;
}

export interface ScheduledReportingAccountSource {
  listActive(scope: ReportingScope): Promise<readonly ScheduledReportingAccount[]>;
}

export interface ReportingPayloadSigner {
  sign(payload: string): Promise<string>;
}

export interface ReportingQueuePublisher {
  publish(message: SignedReportingMessage): Promise<void>;
}

export interface ReportingFanOutRequest extends ReportingScope {
  readonly reportKind: "week" | "month";
  readonly reportStartDate: string;
  readonly reportEndDate: string;
  readonly ingestionStartDate: string;
  readonly ingestionEndDate: string;
  readonly level: HistoricalMetricLevel;
  readonly apiVersion: string;
  readonly attributionWindow?: string | null;
  readonly retentionDays?: number;
}

export interface ReportingFanOutResult extends ReportingScope {
  readonly jobsPublished: number;
}

function assertRequest(request: ReportingFanOutRequest): void {
  assertReportingScope(request);
  assertIsoDate(request.reportStartDate, "reportStartDate");
  assertIsoDate(request.reportEndDate, "reportEndDate");
  assertIsoDate(request.ingestionStartDate, "ingestionStartDate");
  assertIsoDate(request.ingestionEndDate, "ingestionEndDate");
  if (
    request.reportStartDate > request.reportEndDate ||
    request.ingestionStartDate > request.ingestionEndDate ||
    request.reportStartDate < request.ingestionStartDate ||
    request.reportEndDate > request.ingestionEndDate
  ) {
    throw new Error("Reporting schedule has an invalid date window");
  }
  if (request.reportKind !== "week" && request.reportKind !== "month") {
    throw new Error("Reporting schedule has an invalid report kind");
  }
  if (!/^v[0-9]+[.][0-9]+$/.test(request.apiVersion)) {
    throw new Error("Reporting schedule has an invalid Meta API version");
  }
  if (!(["account", "campaign", "ad_set", "ad"] as const).includes(request.level)) {
    throw new Error("Reporting schedule has an invalid metric level");
  }
  if (
    request.attributionWindow !== undefined &&
    request.attributionWindow !== null &&
    (request.attributionWindow.length === 0 || request.attributionWindow.length > 64)
  ) {
    throw new Error("Reporting schedule has an invalid attribution window");
  }
  if (
    request.retentionDays !== undefined &&
    (!Number.isInteger(request.retentionDays) ||
      request.retentionDays < 1 ||
      request.retentionDays > 365)
  ) {
    throw new Error("Reporting schedule has invalid retentionDays");
  }
}

function jobIdFor(request: ReportingFanOutRequest, accountId: string): string {
  const fingerprint = JSON.stringify([
    request.tenantId,
    request.workspaceId,
    accountId,
    request.reportKind,
    request.reportStartDate,
    request.reportEndDate,
    request.ingestionStartDate,
    request.ingestionEndDate,
    request.level,
    request.apiVersion,
    request.attributionWindow ?? null,
    request.retentionDays ?? null,
  ]);
  return `report-${createHash("sha256").update(fingerprint, "utf8").digest("hex").slice(0, 40)}`;
}

function payloadFor(
  request: ReportingFanOutRequest,
  accountId: string,
): ReportingJobPayload {
  return {
    tenantId: request.tenantId,
    workspaceId: request.workspaceId,
    jobId: jobIdFor(request, accountId),
    accountId,
    startDate: request.ingestionStartDate,
    endDate: request.ingestionEndDate,
    level: request.level,
    apiVersion: request.apiVersion,
    attributionWindow: request.attributionWindow ?? null,
    mode: "incremental",
    reportKind: request.reportKind,
    reportStartDate: request.reportStartDate,
    reportEndDate: request.reportEndDate,
    ...(request.retentionDays === undefined ? {} : { retentionDays: request.retentionDays }),
  };
}

function assertAccounts(
  scope: ReportingScope,
  accounts: readonly ScheduledReportingAccount[],
): void {
  if (accounts.length > MAX_SCHEDULED_ACCOUNTS) {
    throw new Error("Reporting schedule exceeds its account limit");
  }
  const seen = new Set<string>();
  for (const account of accounts) {
    if (
      account.tenantId !== scope.tenantId ||
      account.workspaceId !== scope.workspaceId ||
      !/^act_[0-9]+$/.test(account.accountId) ||
      seen.has(account.accountId)
    ) {
      throw new Error("Reporting schedule account scope is invalid");
    }
    seen.add(account.accountId);
  }
}

export class ReportingJobFanOut {
  constructor(
    private readonly accounts: ScheduledReportingAccountSource,
    private readonly signer: ReportingPayloadSigner,
    private readonly publisher: ReportingQueuePublisher,
  ) {}

  async publish(request: ReportingFanOutRequest): Promise<ReportingFanOutResult> {
    assertRequest(request);
    const scope = { tenantId: request.tenantId, workspaceId: request.workspaceId };
    const accounts = await this.accounts.listActive(scope);
    assertAccounts(scope, accounts);

    let jobsPublished = 0;
    for (const account of [...accounts].sort((left, right) =>
      left.accountId.localeCompare(right.accountId))) {
      const payload = JSON.stringify(payloadFor(request, account.accountId));
      const signature = await this.signer.sign(payload);
      const message = parseSignedReportingMessage({ payload, signature });
      if (!message) throw new Error("Reporting signer returned an invalid signature");
      await this.publisher.publish(message);
      jobsPublished += 1;
    }
    return { ...scope, jobsPublished };
  }
}

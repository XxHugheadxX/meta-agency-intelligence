import express, {
  type ErrorRequestHandler,
  type RequestHandler,
  type Router,
} from "express";
import type { WorkloadIdentityVerifier } from "../worker/types.js";
import type {
  ReportingFanOutRequest,
  ReportingFanOutResult,
} from "./reporting-fan-out.js";

const MAX_AUTHORIZATION_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 4 * 1024;

export type ReportingSchedulePublisher = {
  publish(request: ReportingFanOutRequest): Promise<ReportingFanOutResult>;
};

export interface ReportingScheduleOptions {
  readonly timeZone: string;
  readonly apiVersion: string;
  readonly attributionWindow: string | null;
  readonly retentionDays: number;
  readonly ingestionLookbackDays: number;
  readonly now?: () => Date;
}

interface ReportingScheduleTrigger {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly reportKind: "week" | "month";
}

function authorizationFromRequest(request: {
  headers: { authorization?: string | string[] };
}): string | null {
  const authorization = request.headers.authorization;
  if (
    typeof authorization !== "string" ||
    Buffer.byteLength(authorization, "utf8") > MAX_AUTHORIZATION_BYTES ||
    !/^Bearer \S+$/.test(authorization)
  ) {
    return null;
  }
  return authorization;
}

function setNoStore(response: { setHeader(name: string, value: string): unknown }): void {
  response.setHeader("Cache-Control", "no-store");
}

function unauthorized(response: {
  status(code: number): { json(body: unknown): unknown };
  setHeader(name: string, value: string): unknown;
}): void {
  setNoStore(response);
  response.status(401).json({ error: "Unauthorized reporting schedule request" });
}

function invalidRequest(response: {
  status(code: number): { json(body: unknown): unknown };
  setHeader(name: string, value: string): unknown;
}): void {
  setNoStore(response);
  response.status(400).json({ error: "Invalid reporting schedule request" });
}

function authenticate(identities: WorkloadIdentityVerifier): RequestHandler {
  return async (request, response, next) => {
    const authorization = authorizationFromRequest(request);
    if (!authorization) {
      unauthorized(response);
      return;
    }
    try {
      const identity = await identities.verify(authorization);
      if (
        !identity.subject.trim() ||
        !identity.issuer.trim() ||
        !identity.audience.trim() ||
        !identity.roles.includes("scheduler")
      ) {
        throw new Error("Untrusted reporting trigger identity");
      }
      next();
    } catch {
      unauthorized(response);
    }
  };
}

function parseTrigger(value: unknown): ReportingScheduleTrigger | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join("\u001f") !== ["reportKind", "tenantId", "workspaceId"].join("\u001f")) {
    return null;
  }
  if (
    typeof record.tenantId !== "string" ||
    typeof record.workspaceId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(record.tenantId) ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(record.workspaceId) ||
    (record.reportKind !== "week" && record.reportKind !== "month")
  ) {
    return null;
  }
  return {
    tenantId: record.tenantId,
    workspaceId: record.workspaceId,
    reportKind: record.reportKind,
  };
}

function calendarDate(now: Date, timeZone: string): Date {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("Reporting schedule clock is invalid");
  }
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: "year" | "month" | "day") =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  const year = part("year");
  const month = part("month");
  const day = part("day");
  const result = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(result.getTime())) throw new Error("Reporting schedule date is invalid");
  return result;
}

function addDays(value: Date, days: number): Date {
  const result = new Date(value.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function completedPeriod(
  reportKind: "week" | "month",
  currentDate: Date,
): { startDate: Date; endDate: Date } {
  if (reportKind === "week") {
    const daysSinceMonday = (currentDate.getUTCDay() + 6) % 7;
    const currentMonday = addDays(currentDate, -daysSinceMonday);
    return {
      startDate: addDays(currentMonday, -7),
      endDate: addDays(currentMonday, -1),
    };
  }
  const firstCurrentMonth = new Date(Date.UTC(
    currentDate.getUTCFullYear(),
    currentDate.getUTCMonth(),
    1,
  ));
  return {
    startDate: new Date(Date.UTC(
      firstCurrentMonth.getUTCFullYear(),
      firstCurrentMonth.getUTCMonth() - 1,
      1,
    )),
    endDate: addDays(firstCurrentMonth, -1),
  };
}

function fanOutRequest(
  trigger: ReportingScheduleTrigger,
  options: ReportingScheduleOptions,
): ReportingFanOutRequest {
  const currentDate = calendarDate((options.now ?? (() => new Date()))(), options.timeZone);
  const period = completedPeriod(trigger.reportKind, currentDate);
  return {
    ...trigger,
    reportStartDate: isoDate(period.startDate),
    reportEndDate: isoDate(period.endDate),
    ingestionStartDate: isoDate(addDays(period.startDate, -options.ingestionLookbackDays)),
    ingestionEndDate: isoDate(period.endDate),
    level: "ad",
    apiVersion: options.apiVersion,
    attributionWindow: options.attributionWindow,
    retentionDays: options.retentionDays,
  };
}

function execute(
  scheduler: ReportingSchedulePublisher,
  options: ReportingScheduleOptions,
): RequestHandler {
  return async (request, response) => {
    const trigger = parseTrigger(request.body);
    if (!trigger) {
      invalidRequest(response);
      return;
    }
    try {
      const scheduled = fanOutRequest(trigger, options);
      const result = await scheduler.publish(scheduled);
      setNoStore(response);
      response.status(202).json({
        status: "queued",
        reportKind: scheduled.reportKind,
        reportStartDate: scheduled.reportStartDate,
        reportEndDate: scheduled.reportEndDate,
        jobsPublished: result.jobsPublished,
      });
    } catch {
      invalidRequest(response);
    }
  };
}

const malformedBody: ErrorRequestHandler = (_error, _request, response, _next) => {
  invalidRequest(response);
};

export function createReportingScheduleHttpRouter(
  scheduler: ReportingSchedulePublisher,
  identities: WorkloadIdentityVerifier,
  options: ReportingScheduleOptions,
): Router {
  const router = express.Router();
  router.post(
    "/",
    authenticate(identities),
    express.json({ limit: MAX_BODY_BYTES, strict: true }),
    execute(scheduler, options),
    malformedBody,
  );
  return router;
}

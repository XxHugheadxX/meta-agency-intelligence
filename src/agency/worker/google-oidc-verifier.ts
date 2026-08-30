import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import type {
  VerifiedWorkloadIdentity,
  WorkloadIdentityVerifier,
} from "./types.js";

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"] as const;
const GOOGLE_JWKS_URL = new URL("https://www.googleapis.com/oauth2/v3/certs");
const MAX_AUTHORIZATION_BYTES = 16 * 1024;

export interface GoogleOidcWorkloadIdentityOptions {
  readonly audience: string;
  readonly serviceAccountEmail: string;
  readonly serviceAccountSubject: string;
  readonly jwks?: JWTVerifyGetKey;
}

function validateAudience(value: string): string {
  let audience: URL;
  try {
    audience = new URL(value);
  } catch {
    throw new Error("Scheduler OIDC audience must be an absolute URL");
  }
  if (
    audience.protocol !== "https:" ||
    audience.username ||
    audience.password ||
    audience.hash
  ) {
    throw new Error("Scheduler OIDC audience must be a safe HTTPS URL");
  }
  if (audience.href !== value) {
    throw new Error("Scheduler OIDC audience must use its canonical URL form");
  }
  return value;
}

function validateServiceAccountEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}@[a-z0-9][a-z0-9.-]+\.iam\.gserviceaccount\.com$/.test(email)) {
    throw new Error("Scheduler service account email is invalid");
  }
  return email;
}

function bearerToken(authorization: string): string {
  if (Buffer.byteLength(authorization, "utf8") > MAX_AUTHORIZATION_BYTES) {
    throw new Error("Workload authorization header exceeds its size limit");
  }
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
    authorization,
  );
  if (!match) throw new Error("Workload authorization header is invalid");
  return match[1];
}

export class GoogleOidcWorkloadIdentityVerifier implements WorkloadIdentityVerifier {
  private readonly audience: string;
  private readonly serviceAccountEmail: string;
  private readonly serviceAccountSubject: string;
  private readonly jwks: JWTVerifyGetKey;

  constructor(options: GoogleOidcWorkloadIdentityOptions) {
    this.audience = validateAudience(options.audience);
    this.serviceAccountEmail = validateServiceAccountEmail(options.serviceAccountEmail);
    if (
      !/^\d{6,32}$/.test(options.serviceAccountSubject)
    ) {
      throw new Error("Scheduler service account subject is invalid");
    }
    this.serviceAccountSubject = options.serviceAccountSubject;
    this.jwks = options.jwks ?? createRemoteJWKSet(GOOGLE_JWKS_URL, {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60 * 1_000,
    });
  }

  async verify(authorization: string): Promise<VerifiedWorkloadIdentity> {
    try {
      const token = bearerToken(authorization);
      const { payload } = await jwtVerify(token, this.jwks, {
        algorithms: ["RS256"],
        issuer: [...GOOGLE_ISSUERS],
        audience: this.audience,
        clockTolerance: 5,
        maxTokenAge: "10 minutes",
      });
      if (typeof payload.aud !== "string" || payload.aud !== this.audience) {
        throw new Error("Untrusted scheduler audience");
      }
      const email = typeof payload.email === "string" ? payload.email.toLowerCase() : null;
      if (
        email !== this.serviceAccountEmail ||
        payload.email_verified !== true ||
        typeof payload.sub !== "string" ||
        !/^\d{6,32}$/.test(payload.sub) ||
        payload.sub !== this.serviceAccountSubject
      ) {
        throw new Error("Untrusted scheduler identity");
      }
      return {
        issuer: String(payload.iss),
        audience: this.audience,
        subject: payload.sub,
        roles: ["scheduler"],
      };
    } catch {
      throw new Error("Workload identity token is invalid");
    }
  }
}

export function createGoogleOidcWorkloadIdentityVerifierFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GoogleOidcWorkloadIdentityVerifier {
  const audience = env.AGENCY_SCHEDULER_AUDIENCE?.trim();
  const serviceAccountEmail = env.AGENCY_SCHEDULER_SERVICE_ACCOUNT?.trim();
  const serviceAccountSubject = env.AGENCY_SCHEDULER_SUBJECT?.trim();
  if (!audience || !serviceAccountEmail || !serviceAccountSubject) {
    throw new Error(
      "AGENCY_SCHEDULER_AUDIENCE, AGENCY_SCHEDULER_SERVICE_ACCOUNT and AGENCY_SCHEDULER_SUBJECT are required",
    );
  }
  return new GoogleOidcWorkloadIdentityVerifier({
    audience,
    serviceAccountEmail,
    serviceAccountSubject,
  });
}

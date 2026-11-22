import { generateKeyPairSync } from "node:crypto";
import {
  createLocalJWKSet,
  exportJWK,
  SignJWT,
  type JWK,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createGoogleOidcWorkloadIdentityVerifierFromEnv,
  GoogleOidcWorkloadIdentityVerifier,
} from "../../src/agency/index.js";

const audience = "https://agency.example.test/internal/reporting";
const email = "agency-scheduler@example-project.iam.gserviceaccount.com";
const subject = "123456789012345678901";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
let jwks: ReturnType<typeof createLocalJWKSet>;

async function token(overrides: {
  readonly audience?: string;
  readonly audiences?: string[];
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly issuer?: string;
  readonly subject?: string;
  readonly expiresAt?: number;
} = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    email: overrides.email ?? email,
    email_verified: overrides.emailVerified ?? true,
  })
    .setProtectedHeader({ alg: "RS256", kid: "scheduler-key", typ: "JWT" })
    .setIssuer(overrides.issuer ?? "https://accounts.google.com")
    .setAudience(overrides.audiences ?? overrides.audience ?? audience)
    .setSubject(overrides.subject ?? subject)
    .setIssuedAt(now)
    .setExpirationTime(overrides.expiresAt ?? now + 300)
    .sign(privateKey);
}

describe("Google OIDC workload identity verifier", () => {
  beforeAll(async () => {
    const key = await exportJWK(publicKey) as JWK;
    key.kid = "scheduler-key";
    key.alg = "RS256";
    key.use = "sig";
    jwks = createLocalJWKSet({ keys: [key] });
  });

  it("accepts only the configured scheduler identity and grants its fixed role", async () => {
    const verifier = new GoogleOidcWorkloadIdentityVerifier({
      audience,
      serviceAccountEmail: email,
      serviceAccountSubject: subject,
      jwks,
    });

    await expect(verifier.verify(`Bearer ${await token()}`)).resolves.toEqual({
      issuer: "https://accounts.google.com",
      audience,
      subject,
      roles: ["scheduler"],
    });
  });

  it.each([
    ["wrong audience", { audience: "https://attacker.example/internal/reporting" }],
    ["wrong issuer", { issuer: "https://attacker.example" }],
    ["wrong service account", { email: "other@example-project.iam.gserviceaccount.com" }],
    ["unverified email", { emailVerified: false }],
    ["wrong subject", { subject: "999999999999999999999" }],
    ["expired token", { expiresAt: 1 }],
  ])("rejects %s with a sanitized error", async (_label, overrides) => {
    const verifier = new GoogleOidcWorkloadIdentityVerifier({
      audience,
      serviceAccountEmail: email,
      serviceAccountSubject: subject,
      jwks,
    });
    const authorization = `Bearer ${await token(overrides)}`;

    const error = await verifier.verify(authorization).catch((reason: Error) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Workload identity token is invalid");
    expect(error.message).not.toContain(email);
    expect(error.message).not.toContain(authorization);
  });

  it("rejects a token with multiple audiences", async () => {
    const verifier = new GoogleOidcWorkloadIdentityVerifier({
      audience,
      serviceAccountEmail: email,
      serviceAccountSubject: subject,
      jwks,
    });

    await expect(verifier.verify(
      `Bearer ${await token({ audiences: [audience, "https://attacker.example"] })}`,
    )).rejects.toThrow("Workload identity token is invalid");
  });

  it("rejects malformed and oversized authorization before JWKS resolution", async () => {
    const verifier = new GoogleOidcWorkloadIdentityVerifier({
      audience,
      serviceAccountEmail: email,
      serviceAccountSubject: subject,
      jwks,
    });

    await expect(verifier.verify("Basic synthetic"))
      .rejects.toThrow("Workload identity token is invalid");
    await expect(verifier.verify(`Bearer ${"a".repeat(17 * 1024)}`))
      .rejects.toThrow("Workload identity token is invalid");
  });

  it("fails closed when required scheduler configuration is missing", () => {
    expect(() => createGoogleOidcWorkloadIdentityVerifierFromEnv({}))
      .toThrow("are required");
    expect(() => createGoogleOidcWorkloadIdentityVerifierFromEnv({
      AGENCY_SCHEDULER_AUDIENCE: audience,
      AGENCY_SCHEDULER_SERVICE_ACCOUNT: email,
    })).toThrow("AGENCY_SCHEDULER_SUBJECT");
  });
});

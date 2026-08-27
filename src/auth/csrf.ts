import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { SessionPayload } from "./session.js";
import { InMemoryJtiStore, type JtiStore } from "../store/persistent-jti-store.js";

const CSRF_AUDIENCE = "mcp-csrf-form";
const CSRF_TTL_SECONDS = 10 * 60;

let csrfStore: JtiStore = new InMemoryJtiStore();

export function configureCsrfJtiStore(store: JtiStore): void {
  csrfStore = store;
}

function csrfSecret(): Uint8Array {
  const raw = process.env.SESSION_COOKIE_SECRET;
  if (!raw || raw.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SESSION_COOKIE_SECRET is required for CSRF protection");
    }
    return new TextEncoder().encode("test-only-csrf-secret-must-not-be-used-in-production");
  }
  return new TextEncoder().encode(raw);
}

export async function issueCsrfToken(session: SessionPayload): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + CSRF_TTL_SECONDS;
  const jti = crypto.randomBytes(16).toString("hex");
  await csrfStore.put(jti, {
    expiresAt,
    meta: { sessionId: session.sessionId, fbUserId: session.fbUserId },
  });
  return new SignJWT({
    sid: session.sessionId,
    fb: session.fbUserId,
    jti,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .setAudience(CSRF_AUDIENCE)
    .sign(csrfSecret());
}

export async function consumeCsrfToken(
  token: unknown,
  session: SessionPayload,
): Promise<boolean> {
  if (typeof token !== "string" || token.length === 0) return false;
  try {
    const { payload } = await jwtVerify(token, csrfSecret(), {
      algorithms: ["HS256"],
      audience: CSRF_AUDIENCE,
    });
    if (
      payload.sid !== session.sessionId ||
      payload.fb !== session.fbUserId ||
      typeof payload.jti !== "string"
    ) {
      return false;
    }
    return csrfStore.consume(payload.jti);
  } catch {
    return false;
  }
}

export function resetCsrfForTests(): void {
  csrfStore = new InMemoryJtiStore();
}


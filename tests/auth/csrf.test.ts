import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumeCsrfToken,
  issueCsrfToken,
  resetCsrfForTests,
} from "../../src/auth/csrf.js";

const session = {
  fbUserId: "user-a",
  email: null,
  name: "A",
  sessionId: "session-a",
};

describe("one-time CSRF tokens", () => {
  beforeEach(() => {
    process.env.SESSION_COOKIE_SECRET = "s".repeat(40);
    resetCsrfForTests();
  });

  afterEach(() => {
    delete process.env.SESSION_COOKIE_SECRET;
    resetCsrfForTests();
  });

  it("accepts one matching form submission and rejects replay", async () => {
    const token = await issueCsrfToken(session);
    await expect(consumeCsrfToken(token, session)).resolves.toBe(true);
    await expect(consumeCsrfToken(token, session)).resolves.toBe(false);
  });

  it("rejects missing tokens and tokens bound to another session", async () => {
    const token = await issueCsrfToken(session);
    await expect(consumeCsrfToken(undefined, session)).resolves.toBe(false);
    await expect(
      consumeCsrfToken(token, { ...session, sessionId: "session-b" }),
    ).resolves.toBe(false);
  });
});

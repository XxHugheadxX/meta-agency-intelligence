import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptToken,
  encryptToken,
  reencryptToken,
  resetKeyCacheForTests,
} from "../../src/auth/crypto.js";

const HEX64 = "0".repeat(63) + "1";
const NEXT_HEX64 = "0".repeat(63) + "2";

describe("crypto encryptToken / decryptToken", () => {
  const original = process.env.TOKEN_ENCRYPTION_KEY;
  const originalVersion = process.env.TOKEN_ENCRYPTION_KEY_VERSION;
  const originalOldKeys = process.env.TOKEN_ENCRYPTION_OLD_KEYS;

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = HEX64;
    process.env.TOKEN_ENCRYPTION_KEY_VERSION = "v1";
    delete process.env.TOKEN_ENCRYPTION_OLD_KEYS;
    resetKeyCacheForTests();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = original;
    if (originalVersion === undefined) delete process.env.TOKEN_ENCRYPTION_KEY_VERSION;
    else process.env.TOKEN_ENCRYPTION_KEY_VERSION = originalVersion;
    if (originalOldKeys === undefined) delete process.env.TOKEN_ENCRYPTION_OLD_KEYS;
    else process.env.TOKEN_ENCRYPTION_OLD_KEYS = originalOldKeys;
    resetKeyCacheForTests();
  });

  it("roundtrips arbitrary strings", () => {
    const plaintext = "EAA-test-token-fixture-roundtrip";
    const encrypted = encryptToken(plaintext);
    expect(encrypted.ciphertext).not.toContain(plaintext);
    expect(decryptToken(encrypted)).toBe(plaintext);
  });

  it("produces different ciphertext for the same plaintext (random IV)", () => {
    const a = encryptToken("hello");
    const b = encryptToken("hello");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(decryptToken(a)).toBe("hello");
    expect(decryptToken(b)).toBe("hello");
  });

  it("rejects tampered ciphertext", () => {
    const enc = encryptToken("secret");
    const tampered = {
      ...enc,
      ciphertext: Buffer.from(enc.ciphertext, "base64")
        .map((b) => b ^ 0x01)
        .toString("base64"),
    };
    expect(() => decryptToken(tampered)).toThrow();
  });

  it("rejects malformed encryption keys", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "abc";
    resetKeyCacheForTests();
    expect(() => encryptToken("x")).toThrow(/64 hex characters/);
  });

  it("CODE-B1: AAD round-trips when same value supplied on both sides", () => {
    const enc = encryptToken("secret-token", "user-1:byads");
    expect(decryptToken(enc, "user-1:byads")).toBe("secret-token");
  });

  it("CODE-B1: rejects ciphertext when a different AAD is supplied (rebind defense)", () => {
    const enc = encryptToken("secret-token", "user-1:byads");
    expect(() => decryptToken(enc, "user-2:byads")).toThrow();
    expect(() => decryptToken(enc, "user-1:other-name")).toThrow();
  });

  it("CODE-B1: rejects ciphertext encrypted-with-AAD when decrypted-without-AAD", () => {
    const enc = encryptToken("secret-token", "user-1:byads");
    expect(() => decryptToken(enc)).toThrow();
  });

  it("CODE-B1: legacy ciphertext (no AAD) still decrypts when no AAD is supplied", () => {
    const enc = encryptToken("legacy-token");
    expect(decryptToken(enc)).toBe("legacy-token");
  });

  it("re-encrypts a tenant-bound payload with the active key and survives old-key retirement", () => {
    const aad = "mcp_token:workspace-fixture:reporting";
    process.env.TOKEN_ENCRYPTION_KEY_VERSION = "v1";
    const originalDocument = encryptToken("synthetic-meta-token", aad);
    expect(originalDocument.keyVersion).toBe("v1");

    process.env.TOKEN_ENCRYPTION_KEY = NEXT_HEX64;
    process.env.TOKEN_ENCRYPTION_KEY_VERSION = "v2";
    process.env.TOKEN_ENCRYPTION_OLD_KEYS = JSON.stringify({ v1: HEX64 });
    resetKeyCacheForTests();

    const rotatedDocument = reencryptToken(originalDocument, aad);
    expect(rotatedDocument.keyVersion).toBe("v2");
    expect(rotatedDocument.ciphertext).not.toBe(originalDocument.ciphertext);
    expect(decryptToken(rotatedDocument, aad)).toBe("synthetic-meta-token");

    delete process.env.TOKEN_ENCRYPTION_OLD_KEYS;
    resetKeyCacheForTests();
    expect(decryptToken(rotatedDocument, aad)).toBe("synthetic-meta-token");
    expect(() => decryptToken(originalDocument, aad)).toThrow(/No encryption key configured/);
  });

  it("restores a backed-up old-version document while the rotation window is open", () => {
    const aad = "mcp_token:workspace-fixture:restore";
    process.env.TOKEN_ENCRYPTION_KEY_VERSION = "v1";
    const encryptedBackup = JSON.parse(JSON.stringify(
      encryptToken("synthetic-restore-token", aad),
    ));

    process.env.TOKEN_ENCRYPTION_KEY = NEXT_HEX64;
    process.env.TOKEN_ENCRYPTION_KEY_VERSION = "v2";
    process.env.TOKEN_ENCRYPTION_OLD_KEYS = JSON.stringify({ v1: HEX64 });
    resetKeyCacheForTests();

    expect(decryptToken(encryptedBackup, aad)).toBe("synthetic-restore-token");
    const restoredOnCurrentKey = reencryptToken(encryptedBackup, aad);
    expect(restoredOnCurrentKey.keyVersion).toBe("v2");
    expect(decryptToken(restoredOnCurrentKey, aad)).toBe("synthetic-restore-token");
    expect(() => decryptToken(encryptedBackup, "mcp_token:other-workspace:restore")).toThrow();
  });
});

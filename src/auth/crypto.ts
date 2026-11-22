import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

const cachedKeys = new Map<string, Buffer>();

function parseRawKey(raw: string, label: string): Buffer {
  if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length !== KEY_LENGTH * 2) {
    throw new Error(`${label} must be ${KEY_LENGTH * 2} hex characters (32 bytes)`);
  }
  return Buffer.from(raw, "hex");
}

function currentKeyVersion(): string {
  return process.env.TOKEN_ENCRYPTION_KEY_VERSION?.trim() || "v1";
}

function getKey(version?: string): Buffer {
  const wantedVersion = version ?? currentKeyVersion();
  const cached = cachedKeys.get(wantedVersion);
  if (cached) return cached;

  const raw = process.env.TOKEN_ENCRYPTION_KEY?.trim();
  if (raw && wantedVersion === currentKeyVersion()) {
    const key = parseRawKey(raw, "TOKEN_ENCRYPTION_KEY");
    cachedKeys.set(wantedVersion, key);
    return key;
  }

  const oldKeysRaw = process.env.TOKEN_ENCRYPTION_OLD_KEYS?.trim();
  if (oldKeysRaw) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(oldKeysRaw) as Record<string, unknown>;
    } catch {
      throw new Error("TOKEN_ENCRYPTION_OLD_KEYS must be a JSON object");
    }
    const oldRaw = parsed[wantedVersion];
    if (typeof oldRaw === "string") {
      const key = parseRawKey(oldRaw, `TOKEN_ENCRYPTION_OLD_KEYS.${wantedVersion}`);
      cachedKeys.set(wantedVersion, key);
      return key;
    }
  }

  if (!raw && wantedVersion === currentKeyVersion()) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("TOKEN_ENCRYPTION_KEY is required in production");
    }
    const generated = crypto.randomBytes(KEY_LENGTH);
    cachedKeys.set(wantedVersion, generated);
    return generated;
  }
  throw new Error(`No encryption key configured for key version ${wantedVersion}`);
}

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion?: string;
}

/**
 * Encrypt a token with AES-256-GCM.
 *
 * If `aad` is provided, it is bound into the GCM authentication tag
 * (CODE-B1). At decrypt time the same AAD must be supplied or the auth
 * check fails — this prevents an attacker who has Firestore write access
 * from copying a valid (ciphertext, iv, tag) tuple from one
 * `users/A/meta_tokens/X` doc to another `users/B/meta_tokens/Y` doc and
 * having the server happily decrypt it as B's token. Recommended AAD is
 * `${fbUserId}:${name}` — stable and unique per doc.
 *
 * Records encrypted before this parameter existed will continue to
 * decrypt with `aad` left out (the AAD defaults to empty), so this is
 * fully backward-compatible.
 */
export function encryptToken(
  plaintext: string,
  aad?: string,
): EncryptedPayload {
  const keyVersion = currentKeyVersion();
  const key = getKey(keyVersion);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    keyVersion,
  };
}

export function decryptToken(payload: EncryptedPayload, aad?: string): string {
  const key = getKey(
    payload.keyVersion ?? process.env.TOKEN_ENCRYPTION_LEGACY_KEY_VERSION,
  );
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return plaintext.toString("utf8");
}

/**
 * Re-encrypt an existing payload with the currently active key version.
 *
 * The source key remains selected from payload.keyVersion, so rotations can
 * use TOKEN_ENCRYPTION_OLD_KEYS for dual-read while all new ciphertext is
 * written with TOKEN_ENCRYPTION_KEY_VERSION. AAD must be the stable binding
 * for the document being migrated.
 */
export function reencryptToken(
  payload: EncryptedPayload,
  aad?: string,
): EncryptedPayload {
  return encryptToken(decryptToken(payload, aad), aad);
}

export function resetKeyCacheForTests(): void {
  cachedKeys.clear();
}

#!/usr/bin/env node
// Safe, resumable AES-256-GCM rotation for tenant-bound Meta and Apify tokens.
// Required: OLD_KEY, NEW_KEY, OLD_KEY_VERSION, NEW_KEY_VERSION, PROJECT_ID.
// DRY_RUN=1 performs reads and cryptographic verification without Firestore writes.

import { Firestore } from "@google-cloud/firestore";
import crypto from "node:crypto";

const ALG = "aes-256-gcm";
const IV_LEN = 12;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseKey(name) {
  const raw = required(name);
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`${name} must be 64 hex chars`);
  return Buffer.from(raw, "hex");
}

function encrypt(plaintext, key, aad, keyVersion) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    keyVersion,
  };
}

function decrypt(payload, key, aad) {
  const decipher = crypto.createDecipheriv(ALG, key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function decryptWithoutAad(payload, key) {
  const decipher = crypto.createDecipheriv(ALG, key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function decryptForRotation(payload, key, aad, allowLegacyNoAad) {
  try {
    return decrypt(payload, key, aad);
  } catch (error) {
    if (!allowLegacyNoAad || payload.keyVersion) throw error;
    return decryptWithoutAad(payload, key);
  }
}

function localSmokeTest(oldKey, newKey, oldVersion, newVersion) {
  const aad = "rotation_probe:local:default";
  const plaintext = `probe-${Date.now()}`;
  const oldPayload = encrypt(plaintext, oldKey, aad, oldVersion);
  const newPayload = encrypt(decrypt(oldPayload, oldKey, aad), newKey, aad, newVersion);
  if (decrypt(newPayload, newKey, aad) !== plaintext) throw new Error("Local smoke test failed");
}

async function collectTokenRefs(db) {
  const users = await db.collection("users").get();
  const items = [];
  for (const user of users.docs) {
    const meta = await user.ref.collection("meta_tokens").get();
    for (const token of meta.docs) {
      items.push({ ref: token.ref, aad: `mcp_token:${user.id}:${token.id}`, label: "meta" });
    }
    const apify = await user.ref.collection("apify_tokens").get();
    for (const token of apify.docs) {
      items.push({ ref: token.ref, aad: `apify_token:${user.id}:${token.id}`, label: "apify" });
    }
  }
  return items;
}

async function main() {
  const oldKey = parseKey("OLD_KEY");
  const newKey = parseKey("NEW_KEY");
  const oldVersion = required("OLD_KEY_VERSION");
  const newVersion = required("NEW_KEY_VERSION");
  const projectId = required("PROJECT_ID");
  const dryRun = process.env.DRY_RUN === "1";
  const allowLegacyNoAad = process.env.ALLOW_LEGACY_NO_AAD === "1";

  if (oldKey.equals(newKey) || oldVersion === newVersion) {
    throw new Error("Old and new key material/version must differ");
  }
  localSmokeTest(oldKey, newKey, oldVersion, newVersion);

  const db = new Firestore({ projectId, ignoreUndefinedProperties: true });
  const items = await collectTokenRefs(db);
  let rotated = 0;
  let skipped = 0;
  const failures = [];

  for (const item of items) {
    try {
      const snap = await item.ref.get();
      const data = snap.data();
      if (!data?.encryptedToken || data.encryptedToken.keyVersion === newVersion) {
        skipped++;
        continue;
      }
      if (data.encryptedToken.keyVersion && data.encryptedToken.keyVersion !== oldVersion) {
        throw new Error("unexpected key version");
      }
      const plaintext = decryptForRotation(
        data.encryptedToken,
        oldKey,
        item.aad,
        allowLegacyNoAad,
      );
      const next = encrypt(plaintext, newKey, item.aad, newVersion);
      if (decrypt(next, newKey, item.aad) !== plaintext) throw new Error("verification failed");

      if (!dryRun) {
        const backupRef = db.collection("token_rotation_backups").doc(`${oldVersion}-${crypto.randomUUID()}`);
        await db.runTransaction(async (tx) => {
          const current = await tx.get(item.ref);
          const currentData = current.data();
          if (!currentData?.encryptedToken) throw new Error("token disappeared during rotation");
          tx.create(backupRef, {
            sourcePath: item.ref.path,
            encryptedToken: currentData.encryptedToken,
            rotatedAt: Math.floor(Date.now() / 1000),
            fromKeyVersion: oldVersion,
            toKeyVersion: newVersion,
          });
          tx.update(item.ref, {
            encryptedToken: next,
            keyVersion: newVersion,
            updatedAt: Math.floor(Date.now() / 1000),
          });
        });
      }
      rotated++;
    } catch (error) {
      failures.push({ kind: item.label, error: error instanceof Error ? error.message : "unknown" });
    }
  }

  console.log(JSON.stringify({ total: items.length, rotated, skipped, failed: failures.length, dryRun }));
  await db.terminate();
  if (failures.length) process.exit(2);
}

main().catch((error) => {
  console.error("Rotation failed:", error instanceof Error ? error.message : "unknown error");
  process.exit(1);
});

import { createHash } from "node:crypto";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { getFirestore } from "../store/firestore.js";
import type { CircuitContext } from "./circuit-breaker.js";

const WINDOW_MS = 60_000;

function docId(context: CircuitContext): string {
  return createHash("sha256")
    .update(`${context.tokenHash}:${context.accountId ?? "_"}:${context.type ?? "_"}`)
    .digest("hex");
}

export class DistributedMetaGuard {
  private get enabled(): boolean {
    return process.env.DISTRIBUTED_RATE_LIMIT_BACKEND === "firestore";
  }

  async beforeRequest(context: CircuitContext): Promise<void> {
    if (!this.enabled) return;
    const db = getFirestore();
    const id = docId(context);
    const circuit = await db.collection("meta_circuits").doc(id).get();
    const openUntil = circuit.exists ? Number(circuit.data()?.openUntil ?? 0) : 0;
    if (openUntil > Date.now()) {
      throw new McpError(ErrorCode.InvalidRequest, "Meta circuit is open for this workspace asset");
    }

    const limit = Math.max(1, Number(process.env.META_REQUESTS_PER_MINUTE ?? 120));
    const quotaRef = db.collection("meta_request_quotas").doc(id);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(quotaRef);
      const now = Date.now();
      const data = snap.data();
      const resetAt = Number(data?.resetAt ?? 0);
      const count = resetAt > now ? Number(data?.count ?? 0) : 0;
      if (count >= limit) {
        throw new McpError(ErrorCode.InvalidRequest, "Workspace Meta request quota exceeded");
      }
      tx.set(quotaRef, {
        count: count + 1,
        resetAt: resetAt > now ? resetAt : now + WINDOW_MS,
        updatedAt: now,
      });
    });
  }

  async trip(context: CircuitContext, retryAfterMs: number): Promise<void> {
    if (!this.enabled) return;
    const openUntil = Date.now() + Math.max(1_000, retryAfterMs);
    await getFirestore().collection("meta_circuits").doc(docId(context)).set(
      { openUntil, updatedAt: Date.now() },
      { merge: true },
    );
  }
}

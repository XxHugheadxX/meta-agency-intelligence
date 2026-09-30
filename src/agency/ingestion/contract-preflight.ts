import { requestContext } from "../../auth/token-store.js";
import type { MetaApiClient } from "../../meta/client.js";

export function assertAdsOnlyReadPermissions(response: unknown): void {
  const data = (response as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("Meta permission response is invalid");
  const granted = new Set<string>();
  for (const item of data) {
    if (!item || typeof item.permission !== "string" || typeof item.status !== "string") {
      throw new Error("Meta permission response is invalid");
    }
    if (item.status === "granted") granted.add(item.permission);
  }
  if (!granted.has("ads_read")) throw new Error("Test token requires granted ads_read");
  if ([...granted].some((permission) => !["ads_read", "public_profile"].includes(permission))) {
    throw new Error("Ads-only contract rejects additional scopes; generate a minimum-privilege test token");
  }
}
export async function preflightAdsOnlyTestToken(client: Pick<MetaApiClient, "get">, accessToken: string): Promise<void> {
  if (!accessToken.trim()) throw new Error("Test token is required");
  // Identity-level permission discovery is a control-plane operation, not an
  // asset request. Keep /me blocked in tenant-scoped reporting clients.
  const permissions = await requestContext.run({ accessToken }, () => client.get<unknown>("/me/permissions"));
  assertAdsOnlyReadPermissions(permissions);
}

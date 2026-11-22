import type { MetaApiResponse } from "../../meta/types/common.js";
import type { IngestionAccount, ReadOnlyMetaClient } from "./types.js";

const MAX_ADS_PER_REQUEST = 50;

export interface AdCreativeRecord {
  id?: unknown;
  account_id?: unknown;
  creative?: { id?: unknown } | null;
}

export interface AdCreativeQuery {
  readonly account: IngestionAccount;
  readonly adIds: readonly string[];
}

export interface AdCreativeReader {
  read(query: AdCreativeQuery): Promise<MetaApiResponse<AdCreativeRecord>>;
}

export class MetaAdCreativeReader implements AdCreativeReader {
  constructor(private readonly client: ReadOnlyMetaClient) {}

  async read(query: AdCreativeQuery): Promise<MetaApiResponse<AdCreativeRecord>> {
    if (!/^act_\d+$/.test(query.account.accountId)) {
      throw new Error("Meta ad creative lookup requires an act_<digits> accountId");
    }
    if (
      query.adIds.length < 1 ||
      query.adIds.length > MAX_ADS_PER_REQUEST ||
      query.adIds.some((adId) => !/^\d{1,32}$/.test(adId))
    ) {
      throw new Error("Meta ad creative lookup requires 1 to 50 numeric ad IDs");
    }
    return this.client.get<MetaApiResponse<AdCreativeRecord>>(
      `/${query.account.accountId}/ads`,
      {
        fields: "id,account_id,creative{id}",
        filtering: JSON.stringify([{ field: "id", operator: "IN", value: query.adIds }]),
        limit: query.adIds.length,
      },
    );
  }
}

/**
 * Resolves the creative each ad really uses. An ad Meta does not return maps
 * to null so callers can never fall back to the ad ID as a creative ID.
 */
export async function resolveAdCreativeIds(
  reader: AdCreativeReader,
  account: IngestionAccount,
  adIds: readonly string[],
  known: Map<string, string | null>,
): Promise<void> {
  const pending = [...new Set(adIds)].filter((adId) => !known.has(adId)).sort();
  for (let start = 0; start < pending.length; start += MAX_ADS_PER_REQUEST) {
    const requested = pending.slice(start, start + MAX_ADS_PER_REQUEST);
    const page = await reader.read({ account, adIds: requested });
    if (!Array.isArray(page.data)) {
      throw new Error("Meta ad creative response data must be an array");
    }
    if (page.data.length > requested.length || page.paging?.next) {
      throw new Error("Meta ad creative response exceeds the requested ads");
    }
    const resolved = new Map<string, string | null>();
    for (const record of page.data) {
      const adId = typeof record.id === "string" ? record.id : "";
      if (!requested.includes(adId) || resolved.has(adId)) {
        throw new Error("Meta ad creative response contains an ad that was not requested");
      }
      const accountId = typeof record.account_id === "string" || typeof record.account_id === "number"
        ? `act_${String(record.account_id).replace(/^act_/, "")}`
        : null;
      if (accountId !== null && accountId !== account.accountId) {
        throw new Error("Meta ad creative account_id does not match the authorized account");
      }
      const creativeId = record.creative?.id;
      if (creativeId === undefined || creativeId === null) {
        resolved.set(adId, null);
      } else if (typeof creativeId === "string" && /^\d{1,32}$/.test(creativeId)) {
        resolved.set(adId, creativeId);
      } else {
        throw new Error("Meta ad creative id must be a numeric string");
      }
    }
    for (const adId of requested) known.set(adId, resolved.get(adId) ?? null);
  }
}

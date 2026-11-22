export function resolveMetaRequestsPerMinute(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.META_REQUESTS_PER_MINUTE;
  if (raw === undefined) return 120;
  const value = raw.trim();
  const limit = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(limit)) {
    throw new Error("META_REQUESTS_PER_MINUTE must be a positive safe integer");
  }
  return limit;
}

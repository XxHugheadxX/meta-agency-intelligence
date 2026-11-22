export const DEFAULT_META_API_VERSION = "v25.0";

export function resolveMetaApiVersion(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  const version = override?.trim() || env.META_API_VERSION?.trim() || DEFAULT_META_API_VERSION;
  if (!/^v\d{1,3}\.\d{1,2}$/.test(version)) {
    throw new Error("Meta API version must use vN.N format");
  }
  return version;
}

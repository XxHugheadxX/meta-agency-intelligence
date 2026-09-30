import { describe, expect, it } from "vitest";
import { DEFAULT_META_API_VERSION, resolveMetaApiVersion } from "../../src/meta/api-version.js";

describe("shared Meta API version", () => {
  it("uses the same default, environment and explicit override precedence", () => {
    expect(resolveMetaApiVersion(undefined, {})).toBe(DEFAULT_META_API_VERSION);
    expect(resolveMetaApiVersion(undefined, { META_API_VERSION: " v26.0 " })).toBe("v26.0");
    expect(resolveMetaApiVersion("v25.0", { META_API_VERSION: "v26.0" })).toBe("v25.0");
    expect(resolveMetaApiVersion(undefined, { META_API_VERSION: " " })).toBe(DEFAULT_META_API_VERSION);
  });
  it("rejects URL-shaped or malformed versions without reflecting the value", () => {
    for (const value of ["https://example.test", "v25.0?secret=hidden", "25.0", "v25.0/path"]) {
      expect(() => resolveMetaApiVersion(value, {})).toThrow("Meta API version must use vN.N format");
    }
  });
});

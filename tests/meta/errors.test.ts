import { describe, it, expect } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  mapMetaErrorToMcp,
  classifyMetaError,
  isMetaApiError,
} from "../../src/meta/errors.js";
import type { MetaApiError } from "../../src/meta/types/common.js";

describe("isMetaApiError", () => {
  it("returns true for valid Meta API error response", () => {
    expect(
      isMetaApiError({
        error: { message: "test", type: "OAuthException", code: 190 },
      }),
    ).toBe(true);
  });

  it("returns false for null", () => {
    expect(isMetaApiError(null)).toBe(false);
  });

  it("returns false for non-object", () => {
    expect(isMetaApiError("string")).toBe(false);
  });

  it("returns false for object without error key", () => {
    expect(isMetaApiError({ data: [] })).toBe(false);
  });

  it("returns false for object where error is not an object", () => {
    expect(isMetaApiError({ error: "string" })).toBe(false);
  });

  it("returns true even with minimal error object", () => {
    expect(isMetaApiError({ error: {} })).toBe(true);
  });
});

function makeError(overrides: Partial<MetaApiError>): MetaApiError {
  return {
    message: "Test error",
    type: "OAuthException",
    code: 0,
    ...overrides,
  };
}

describe("mapMetaErrorToMcp (legacy)", () => {
  it("maps auth error code 190 to InvalidRequest", () => {
    const err = mapMetaErrorToMcp(makeError({ code: 190 }));
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(ErrorCode.InvalidRequest);
    expect(err.message).toContain("Invalid or expired access token");
  });

  it("maps permission error code 10 to InvalidRequest", () => {
    const err = mapMetaErrorToMcp(makeError({ code: 10 }));
    expect(err.code).toBe(ErrorCode.InvalidRequest);
    expect(err.message).toContain("Insufficient permissions");
  });

  it("maps auth error code 102 to InvalidRequest", () => {
    const err = mapMetaErrorToMcp(makeError({ code: 102 }));
    expect(err.code).toBe(ErrorCode.InvalidRequest);
    expect(err.message).toContain("Authentication required");
  });

  it("maps invalid parameter code 100 to InvalidParams", () => {
    const err = mapMetaErrorToMcp(makeError({ code: 100 }));
    expect(err.code).toBe(ErrorCode.InvalidParams);
    expect(err.message).toContain("Invalid parameter");
  });

  it("includes subcode in invalid parameter error", () => {
    const err = mapMetaErrorToMcp(
      makeError({ code: 100, error_subcode: 2804008 }),
    );
    expect(err.message).toContain("subcode: 2804008");
  });

  it("maps object not found code 803 to InvalidParams", () => {
    const err = mapMetaErrorToMcp(makeError({ code: 803 }));
    expect(err.code).toBe(ErrorCode.InvalidParams);
    expect(err.message).toContain("Object not found");
  });

  it("maps duplicate error code 2650 to InvalidRequest", () => {
    const err = mapMetaErrorToMcp(makeError({ code: 2650 }));
    expect(err.code).toBe(ErrorCode.InvalidRequest);
    expect(err.message).toContain("Duplicate");
  });

  it("maps server error code 1 to InternalError", () => {
    const err = mapMetaErrorToMcp(makeError({ code: 1 }));
    expect(err.code).toBe(ErrorCode.InternalError);
    expect(err.message).toContain("Please retry");
  });

  it("maps server error code 2 to InternalError", () => {
    const err = mapMetaErrorToMcp(makeError({ code: 2 }));
    expect(err.code).toBe(ErrorCode.InternalError);
  });

  it("maps unknown error codes to InternalError with code number", () => {
    const err = mapMetaErrorToMcp(makeError({ code: 9999 }));
    expect(err.code).toBe(ErrorCode.InternalError);
    expect(err.message).toContain("code 9999");
  });

  it("does not reflect the original Meta error message", () => {
    const err = mapMetaErrorToMcp(
      makeError({ code: 190, message: "Token expired at 2024-01-01" }),
    );
    expect(err.message).not.toContain("Token expired at 2024-01-01");
  });
});

describe("classifyMetaError", () => {
  describe("rate limits", () => {
    it.each([4, 17, 32, 613])("classifies code %i as platform_rate_limit", (code) => {
      const c = classifyMetaError(makeError({ code }));
      expect(c.category).toBe("platform_rate_limit");
      expect(c.throttled).toBe(true);
      expect(c.retryable).toBe(false);
    });

    it.each([80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014])(
      "classifies BUC code %i as buc_rate_limit",
      (code) => {
        const c = classifyMetaError(makeError({ code }));
        expect(c.category).toBe("buc_rate_limit");
        expect(c.throttled).toBe(true);
        expect(c.retryable).toBe(false);
      },
    );
  });

  describe("critical suspension signals", () => {
    it("classifies subcode 1996 as abuse_signal with 60-min retry", () => {
      const c = classifyMetaError(
        makeError({ code: 613, error_subcode: 1996 }),
      );
      expect(c.category).toBe("abuse_signal");
      expect(c.critical).toBe(true);
      expect(c.throttled).toBe(true);
      expect(c.retryAfterMs).toBe(60 * 60 * 1000);
      expect(c.retryable).toBe(false);
    });

    it("classifies code 368 as temporary_block", () => {
      const c = classifyMetaError(makeError({ code: 368 }));
      expect(c.category).toBe("temporary_block");
      expect(c.critical).toBe(true);
      expect(c.retryable).toBe(false);
    });

    it("classifies subcode 1487742 as temporary_block regardless of code", () => {
      const c = classifyMetaError(
        makeError({ code: 100, error_subcode: 1487742 }),
      );
      expect(c.category).toBe("temporary_block");
    });
  });

  describe("data-per-call limit (100/1487534)", () => {
    it("is NOT throttled and must be surfaced to caller", () => {
      const c = classifyMetaError(
        makeError({ code: 100, error_subcode: 1487534 }),
      );
      expect(c.category).toBe("data_per_call_limit");
      expect(c.throttled).toBe(false);
      expect(c.retryable).toBe(false);
      expect(c.mcpError.message).toContain("Data-per-call limit");
    });
  });

  describe("global insights rate limit (4/1504022)", () => {
    it("carries a 2-min retry-after hint", () => {
      const c = classifyMetaError(
        makeError({ code: 4, error_subcode: 1504022 }),
      );
      expect(c.category).toBe("global_insights_rate_limit");
      expect(c.throttled).toBe(true);
      expect(c.retryAfterMs).toBe(2 * 60 * 1000);
    });
  });

  describe("transient errors", () => {
    it("marks code 1 as retryable", () => {
      const c = classifyMetaError(makeError({ code: 1 }));
      expect(c.category).toBe("transient");
      expect(c.retryable).toBe(true);
    });
  });

  describe("auth + invalid_params", () => {
    it("marks code 190 as auth / non-retryable", () => {
      const c = classifyMetaError(makeError({ code: 190 }));
      expect(c.category).toBe("auth");
      expect(c.retryable).toBe(false);
    });

    it("marks generic code 100 as invalid_params", () => {
      const c = classifyMetaError(makeError({ code: 100 }));
      expect(c.category).toBe("invalid_params");
    });
  });
});

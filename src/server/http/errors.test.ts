import { describe, expect, test, vi } from "vitest";

import { errorToResponse, HttpError } from "@/src/server/http/errors";

describe("errorToResponse", () => {
  test("preserves quota details and Retry-After", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = errorToResponse(
      new HttpError(429, "tenant_quota_exceeded", "exhausted", {
        type: "rate_limit_error",
        window: "5h",
        retry_after: 42,
      }),
    );
    expect(response.headers.get("retry-after")).toBe("42");
    expect(await response.json()).toEqual({
      error: {
        code: "tenant_quota_exceeded",
        message: "exhausted",
        type: "rate_limit_error",
        window: "5h",
        retry_after: 42,
      },
    });
  });
});

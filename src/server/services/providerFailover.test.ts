import { describe, expect, test, vi } from "vitest";

import {
  DEFAULT_PROVIDER_FAILOVER_ATTEMPTS,
  isRetryableProviderStatus,
  providerRetryAfterMs,
  providerUpstreamError,
  providerThrownError,
  runProviderFailover,
} from "@/src/server/services/providerFailover";

describe("provider failover policy", () => {
  test.each([401, 403, 429, 500, 502, 503, 504])(
    "retries provider status %i",
    (statusCode) => {
      expect(isRetryableProviderStatus(statusCode)).toBe(true);
    },
  );

  test.each([400, 404, 409, 422, 501])(
    "does not retry request status %i",
    (statusCode) => {
      expect(isRetryableProviderStatus(statusCode)).toBe(false);
    },
  );

  test("uses a bounded default attempt count", () => {
    expect(DEFAULT_PROVIDER_FAILOVER_ATTEMPTS).toBe(3);
  });

  test("parses Retry-After seconds and HTTP dates", () => {
    expect(providerRetryAfterMs(new Headers({ "Retry-After": "42" }), 0)).toBe(
      42_000,
    );
    expect(
      providerRetryAfterMs(
        new Headers({ "Retry-After": "Thu, 23 Jul 2026 04:01:00 GMT" }),
        Date.parse("2026-07-23T04:00:00Z"),
      ),
    ).toBe(60_000);
  });

  test("parses rate-limit reset timestamps in seconds or milliseconds", () => {
    const now = Date.parse("2026-07-23T04:00:00Z");
    const reset = now + 30_000;
    expect(
      providerRetryAfterMs(
        new Headers({ "x-ratelimit-reset": String(reset / 1000) }),
        now,
      ),
    ).toBe(30_000);
    expect(
      providerRetryAfterMs(
        new Headers({ "x-rate-limit-reset": String(reset) }),
        now,
      ),
    ).toBe(30_000);
  });

  test("extracts nested upstream error codes and messages", () => {
    expect(
      providerUpstreamError(
        JSON.stringify({
          error: { code: "rate_limit_exceeded", message: "slow down" },
        }),
        "fallback",
      ),
    ).toEqual({ code: "rate_limit_exceeded", message: "slow down" });
  });

  test("supports string errors and plain-text upstream failures", () => {
    expect(
      providerUpstreamError('{"error":"invalid request"}', "fallback"),
    ).toEqual({ code: "upstream_error", message: "invalid request" });
    expect(providerUpstreamError("gateway unavailable", "fallback")).toEqual({
      code: "upstream_error",
      message: "gateway unavailable",
    });
  });

  test("preserves structured stream error metadata", () => {
    const error = Object.assign(new Error("rate limited"), {
      codexErrorInfo: {
        statusCode: 429,
        code: "rate_limit_exceeded",
        message: "try later",
        retryAfterMs: 12_000,
      },
    });
    expect(providerThrownError(error)).toEqual({
      statusCode: 429,
      code: "rate_limit_exceeded",
      message: "try later",
      retryAfterMs: 12_000,
    });
  });

  test("excludes failed credentials and returns the successful context", async () => {
    const cleaned: string[] = [];
    const selectedWith: string[][] = [];
    const result = await runProviderFailover({
      initialContext: { credentialId: "credential-1" },
      credentialId: (context) => context.credentialId,
      execute: async (context) => ({
        status: context.credentialId === "credential-1" ? 429 : 200,
      }),
      shouldRetry: (response) => isRetryableProviderStatus(response.status),
      prepareRetryResult: (context, response) => {
        cleaned.push(context.credentialId);
        return response;
      },
      handleAttemptError: () => undefined,
      selectNext: (excluded) => {
        selectedWith.push([...excluded]);
        return { credentialId: "credential-2" };
      },
    });

    expect(result).toEqual({
      context: { credentialId: "credential-2" },
      result: { status: 200 },
      attempts: 2,
    });
    expect(cleaned).toEqual(["credential-1"]);
    expect(selectedWith).toEqual([["credential-1"]]);
  });

  test("returns the last real response when no replacement is available", async () => {
    const result = await runProviderFailover({
      initialContext: { credentialId: "credential-1" },
      credentialId: (context) => context.credentialId,
      execute: async () => ({ status: 503, body: "capacity" }),
      shouldRetry: () => true,
      prepareRetryResult: (_context, response) => response,
      handleAttemptError: () => undefined,
      selectNext: () => {
        throw new Error("no replacement");
      },
    });

    expect(result.result).toEqual({ status: 503, body: "capacity" });
    expect(result.attempts).toBe(1);
  });

  test("rethrows the transport error when replacement selection fails", async () => {
    await expect(
      runProviderFailover({
        initialContext: { credentialId: "credential-1" },
        credentialId: (context) => context.credentialId,
        execute: async () => {
          throw new Error("socket closed");
        },
        shouldRetry: () => true,
        prepareRetryResult: (_context, response) => response,
        handleAttemptError: () => undefined,
        selectNext: () => {
          throw new Error("no replacement");
        },
      }),
    ).rejects.toThrow("socket closed");
  });

  test("recovers from a transport error with a replacement credential", async () => {
    const handled: string[] = [];
    const result = await runProviderFailover({
      initialContext: { credentialId: "credential-1" },
      credentialId: (context) => context.credentialId,
      execute: async (context) => {
        if (context.credentialId === "credential-1") {
          throw new Error("connection reset");
        }
        return { status: 200 };
      },
      shouldRetry: () => false,
      prepareRetryResult: (_context, response) => response,
      handleAttemptError: (context) => {
        handled.push(context.credentialId);
      },
      selectNext: () => ({ credentialId: "credential-2" }),
    });

    expect(result.result.status).toBe(200);
    expect(result.context.credentialId).toBe("credential-2");
    expect(handled).toEqual(["credential-1"]);
  });

  test("stops at the configured attempt budget", async () => {
    let executions = 0;
    const result = await runProviderFailover({
      initialContext: { credentialId: "credential-1" },
      credentialId: (context) => context.credentialId,
      execute: async () => {
        executions += 1;
        return { status: 503 };
      },
      shouldRetry: () => true,
      prepareRetryResult: (_context, response) => response,
      handleAttemptError: () => undefined,
      selectNext: (_excluded, attemptIndex) => ({
        credentialId: `credential-${attemptIndex + 2}`,
      }),
      maxAttempts: 2,
    });

    expect(executions).toBe(2);
    expect(result.attempts).toBe(2);
    expect(result.context.credentialId).toBe("credential-2");
  });

  test("prefers the latest transport failure over an older HTTP response", async () => {
    await expect(
      runProviderFailover({
        initialContext: { credentialId: "credential-1" },
        credentialId: (context) => context.credentialId,
        execute: async (context) => {
          if (context.credentialId === "credential-1") {
            return { status: 503 };
          }
          throw new Error("second credential disconnected");
        },
        shouldRetry: (response) => response.status === 503,
        prepareRetryResult: (_context, response) => response,
        handleAttemptError: () => undefined,
        selectNext: (_excluded, attemptIndex) => {
          if (attemptIndex === 0) return { credentialId: "credential-2" };
          throw new Error("no third credential");
        },
      }),
    ).rejects.toThrow("second credential disconnected");
  });

  test("does not select or reserve an unused context after the final transport failure", async () => {
    const selectNext = vi.fn(() => ({ credentialId: "unused" }));
    await expect(
      runProviderFailover({
        initialContext: { credentialId: "credential-1" },
        credentialId: (context) => context.credentialId,
        execute: async () => {
          throw new Error("offline");
        },
        shouldRetry: () => false,
        prepareRetryResult: (_context, response) => response,
        handleAttemptError: () => undefined,
        selectNext,
        maxAttempts: 1,
      }),
    ).rejects.toThrow("offline");
    expect(selectNext).not.toHaveBeenCalled();
  });
});

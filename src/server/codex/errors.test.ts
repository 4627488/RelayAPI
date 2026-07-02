import { describe, expect, test } from "vitest";

import {
  classifyCodexStreamEvent,
  classifyCodexUpstreamError,
} from "@/src/server/codex/errors";

describe("classifyCodexUpstreamError", () => {
  test("uses usage_limit_reached resets_at as credential cooldown", () => {
    const now = new Date("2026-07-02T00:00:00.000Z");
    const resetAtSeconds = Math.floor(
      new Date("2026-07-02T00:05:00.000Z").getTime() / 1000,
    );

    const info = classifyCodexUpstreamError({
      statusCode: 429,
      body: {
        error: {
          type: "usage_limit_reached",
          message: "usage limit reached",
          resets_at: resetAtSeconds,
        },
      },
      now,
    });

    expect(info).toMatchObject({
      code: "usage_limit_reached",
      credentialScoped: true,
      requestScoped: false,
      clearReplay: false,
      retryAfterMs: 5 * 60 * 1000,
    });
  });

  test("uses usage_limit_reached resets_in_seconds when resets_at is absent", () => {
    const info = classifyCodexUpstreamError({
      statusCode: 429,
      body: {
        error: {
          type: "usage_limit_reached",
          message: "usage limit reached",
          resets_in_seconds: 42,
        },
      },
      now: new Date("2026-07-02T00:00:00.000Z"),
    });

    expect(info.code).toBe("usage_limit_reached");
    expect(info.retryAfterMs).toBe(42_000);
    expect(info.credentialScoped).toBe(true);
  });

  test("classifies context length as request scoped without credential cooldown", () => {
    const info = classifyCodexUpstreamError({
      statusCode: 400,
      body: {
        error: {
          code: "context_length_exceeded",
          message: "too many tokens for the context window",
        },
      },
    });

    expect(info).toMatchObject({
      code: "context_too_large",
      credentialScoped: false,
      requestScoped: true,
      clearReplay: false,
      retryAfterMs: null,
    });
  });

  test("classifies model capacity as retryable capacity pressure", () => {
    const info = classifyCodexUpstreamError({
      statusCode: 400,
      body: {
        error: {
          message: "Selected model is at capacity. Please try a different model.",
        },
      },
    });

    expect(info).toMatchObject({
      code: "model_capacity",
      credentialScoped: true,
      requestScoped: false,
      clearReplay: false,
    });
    expect(info.retryAfterMs).toBeGreaterThan(0);
  });

  test("classifies invalid encrypted content and requests replay clearing", () => {
    const info = classifyCodexUpstreamError({
      statusCode: 400,
      body: {
        error: {
          message: "invalid_encrypted_content in reasoning block",
        },
      },
    });

    expect(info).toMatchObject({
      code: "thinking_signature_invalid",
      credentialScoped: false,
      requestScoped: true,
      clearReplay: true,
      retryAfterMs: null,
    });
  });

  test("classifies websocket connection limit as immediate retryable", () => {
    const info = classifyCodexUpstreamError({
      statusCode: 429,
      body: {
        type: "error",
        error: {
          code: "websocket_connection_limit_reached",
          message: "too many websocket connections",
        },
      },
    });

    expect(info).toMatchObject({
      code: "websocket_connection_limit_reached",
      credentialScoped: false,
      requestScoped: false,
      clearReplay: false,
      retryAfterMs: 0,
    });
  });
});

describe("classifyCodexStreamEvent", () => {
  test("classifies response.failed event error bodies", () => {
    const info = classifyCodexStreamEvent(
      {
        type: "response.failed",
        response: {
          error: {
            code: "context_length_exceeded",
            message: "context length exceeded",
          },
        },
      },
      { statusCode: 400 },
    );

    expect(info?.code).toBe("context_too_large");
  });

  test("classifies top-level error events", () => {
    const info = classifyCodexStreamEvent(
      {
        type: "error",
        error: {
          message: "invalid signature in thinking block",
        },
      },
      { statusCode: 400 },
    );

    expect(info?.clearReplay).toBe(true);
    expect(info?.code).toBe("thinking_signature_invalid");
  });
});

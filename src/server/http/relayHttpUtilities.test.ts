import { describe, expect, test } from "vitest";

import {
  copyUpstreamResponseHeaders,
  withDefaultContentType,
  withStreamingHeaders,
} from "@/src/server/http/relayHttpUtilities";

describe("relay response headers", () => {
  test("copies immutable upstream headers before adding a default content type", () => {
    const upstream = Response.redirect("https://example.com").headers;
    const headers = withDefaultContentType(upstream, "application/json");

    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("location")).toBe("https://example.com/");
  });

  test("copies immutable upstream headers before adding streaming headers", () => {
    const upstream = Response.error().headers;
    const headers = withStreamingHeaders(upstream);

    expect(headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(headers.get("connection")).toBe("keep-alive");
    expect(headers.get("x-accel-buffering")).toBe("no");
  });

  test("removes sensitive and transport-specific upstream headers", () => {
    const headers = copyUpstreamResponseHeaders(
      new Headers({
        Authorization: "Bearer secret",
        "Set-Cookie": "session=secret",
        Connection: "keep-alive",
        "Content-Encoding": "gzip",
        "Content-Length": "123",
        "Retry-After": "42",
        "X-Request-Id": "request-1",
      }),
    );

    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("set-cookie")).toBeNull();
    expect(headers.get("connection")).toBeNull();
    expect(headers.get("content-encoding")).toBeNull();
    expect(headers.get("content-length")).toBeNull();
    expect(headers.get("retry-after")).toBe("42");
    expect(headers.get("x-request-id")).toBe("request-1");
  });
});

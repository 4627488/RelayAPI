import { describe, expect, test } from "vitest";

import {
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
});

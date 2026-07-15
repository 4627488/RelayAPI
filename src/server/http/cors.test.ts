import { describe, expect, test } from "vitest";

import { corsPreflightResponse } from "@/src/server/http/cors";

describe("relay CORS", () => {
  test("allows browser clients to send the api-key header", () => {
    const response = corsPreflightResponse();
    const allowed = response.headers
      .get("access-control-allow-headers")
      ?.toLowerCase()
      .split(",")
      .map((value) => value.trim());

    expect(response.status).toBe(204);
    expect(allowed).toContain("api-key");
  });
});

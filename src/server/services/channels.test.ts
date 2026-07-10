import { describe, expect, test } from "vitest";

import { resolveCredentialCooldownUntil } from "@/src/server/services/channels";

describe("resolveCredentialCooldownUntil", () => {
  test("uses explicit retryAfterMs before fixed status cooldown", () => {
    const now = new Date("2026-07-02T00:00:00.000Z");

    const cooldownUntil = resolveCredentialCooldownUntil({
      statusCode: 429,
      retryAfterMs: 42_000,
      now,
    });

    expect(cooldownUntil).toBe("2026-07-02T00:00:42.000Z");
  });

  test("does not create a cooldown for request scoped failures without retryAfterMs", () => {
    const cooldownUntil = resolveCredentialCooldownUntil({
      statusCode: 400,
      now: new Date("2026-07-02T00:00:00.000Z"),
    });

    expect(cooldownUntil).toBeNull();
  });
});

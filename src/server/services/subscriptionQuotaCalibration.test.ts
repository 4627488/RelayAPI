import { describe, expect, test } from "vitest";

import { calibrationWindowStartedAt } from "@/src/server/services/subscriptionQuotaCalibration";

describe("subscription quota calibration windows", () => {
  test("uses the upstream reset cycle instead of a rolling duration from now", () => {
    const now = new Date("2026-07-15T03:30:00.000Z");

    expect(calibrationWindowStartedAt("7d", "2026-07-22T00:00:00.000Z", now))
      .toBe("2026-07-15T00:00:00.000Z");
    expect(calibrationWindowStartedAt("5h", "2026-07-15T05:00:00.000Z", now))
      .toBe("2026-07-15T00:00:00.000Z");
  });

  test("rejects stale reset metadata instead of recounting an old cycle", () => {
    expect(() => calibrationWindowStartedAt(
      "7d",
      "2026-07-15T00:00:00.000Z",
      new Date("2026-07-15T03:30:00.000Z"),
    )).toThrow(/stale/);
  });
});

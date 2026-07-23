import { describe, expect, test } from "vitest";

import {
  calibrationWindowStartedAt,
  nextCalibrationResetAt,
} from "@/src/server/services/subscriptionQuotaCalibration";

describe("subscription quota calibration windows", () => {
  test("uses the upstream reset cycle instead of a rolling duration from now", () => {
    const now = new Date("2026-07-15T03:30:00.000Z");

    expect(calibrationWindowStartedAt("7d", "2026-07-22T00:00:00.000Z", now))
      .toBe("2026-07-15T00:00:00.000Z");
    expect(calibrationWindowStartedAt("5h", "2026-07-15T05:00:00.000Z", now))
      .toBe("2026-07-15T00:00:00.000Z");
  });


  test("advances stale local windows to the current cycle boundary", () => {
    const now = new Date("2026-07-23T08:30:00.000Z");

    expect(nextCalibrationResetAt(
      "5h",
      "2026-07-22T22:00:00.000Z",
      now,
    )).toBe("2026-07-23T13:00:00.000Z");
    expect(nextCalibrationResetAt(
      "7d",
      "2026-07-15T00:00:00.000Z",
      now,
    )).toBe("2026-07-29T00:00:00.000Z");
  });

  test("rejects stale reset metadata instead of recounting an old cycle", () => {
    expect(() => calibrationWindowStartedAt(
      "7d",
      "2026-07-15T00:00:00.000Z",
      new Date("2026-07-15T03:30:00.000Z"),
    )).toThrow(/stale/);
  });
});

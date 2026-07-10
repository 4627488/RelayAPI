import { describe, expect, it } from "vitest";

import {
  addDateKeyDays,
  formatInstant,
  instantToDateKey,
  instantToLocalDateTime,
  isValidTimeZone,
  localDateTimeToInstant,
  parseInstant,
} from "@/src/shared/time";

describe("shared timezone helpers", () => {
  it("parses canonical and legacy SQLite UTC timestamps", () => {
    expect(parseInstant("2026-07-10T16:00:00.000Z")?.toISOString()).toBe(
      "2026-07-10T16:00:00.000Z",
    );
    expect(parseInstant("2026-07-10 16:00:00")?.toISOString()).toBe(
      "2026-07-10T16:00:00.000Z",
    );
    expect(parseInstant("2026-07-11T00:00:00+08:00")?.toISOString()).toBe(
      "2026-07-10T16:00:00.000Z",
    );
  });

  it("uses Shanghai midnight for business date keys", () => {
    expect(
      instantToDateKey("2026-07-10T15:59:59.999Z", "Asia/Shanghai"),
    ).toBe("2026-07-10");
    expect(
      instantToDateKey("2026-07-10T16:00:00.000Z", "Asia/Shanghai"),
    ).toBe("2026-07-11");
  });

  it("formats and round trips local date-times in an explicit zone", () => {
    expect(
      formatInstant("2026-07-10T16:00:00.000Z", "Asia/Shanghai"),
    ).toBe("2026-07-11 00:00:00");
    expect(
      instantToLocalDateTime(
        "2026-07-10T16:00:00.000Z",
        "Asia/Shanghai",
      ),
    ).toBe("2026-07-11T00:00");
    expect(
      localDateTimeToInstant("2026-07-11T00:00", "Asia/Shanghai"),
    ).toEqual({ ok: true, value: "2026-07-10T16:00:00.000Z" });
  });

  it("rejects ambiguous and nonexistent daylight-saving wall times", () => {
    expect(
      localDateTimeToInstant("2026-03-08T02:30", "America/New_York"),
    ).toEqual({ ok: false, reason: "nonexistent" });
    expect(
      localDateTimeToInstant("2026-11-01T01:30", "America/New_York"),
    ).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("validates zones and adds calendar days without host timezone input", () => {
    expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(addDateKeyDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(parseInstant("not-a-date")).toBeNull();
  });
});

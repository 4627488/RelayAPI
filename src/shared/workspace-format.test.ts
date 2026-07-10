import { describe, expect, it } from "vitest";

import {
  formatDateTime,
  setDisplayTimeZone,
} from "@/components/workspace/format";

describe("workspace date formatting", () => {
  it("formats ISO and SQLite UTC values in the configured display zone", () => {
    setDisplayTimeZone("Asia/Shanghai");
    expect(formatDateTime("2026-07-10T16:00:00.000Z")).toBe(
      "2026-07-11 00:00:00",
    );
    expect(formatDateTime("2026-07-10 16:00:00")).toBe(
      "2026-07-11 00:00:00",
    );

    setDisplayTimeZone("America/New_York");
    expect(formatDateTime("2026-07-10T16:00:00.000Z")).toBe(
      "2026-07-10 12:00:00",
    );
  });
});

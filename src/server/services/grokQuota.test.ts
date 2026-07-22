import { describe, expect, test } from "vitest";
import { parseGrokBillingPayload } from "@/src/server/services/grokQuota";

describe("Grok billing quota parsing", () => {
  test("parses the weekly CLI billing config", () => {
    expect(parseGrokBillingPayload({ config: { currentPeriod: { type: "WEEKLY", start: "2026-07-09T03:25:00Z", end: "2026-07-16T03:25:00Z" }, creditUsagePercent: 12 } })).toMatchObject({ creditUsagePercent: 12 });
  });

  test("accepts monthly cent values in object form", () => {
    expect(parseGrokBillingPayload({ config: { monthlyLimit: { val: 15000 }, used: { val: 7500 } } })).toEqual({ monthlyLimit: { val: 15000 }, used: { val: 7500 } });
  });

  test("rejects malformed payloads", () => {
    expect(parseGrokBillingPayload({ config: [] })).toBeNull();
  });
});

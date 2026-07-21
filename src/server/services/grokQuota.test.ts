import { describe, expect, test } from "vitest";
import { parseGrokBillingPayload, parseGrokRateLimitHeaders } from "@/src/server/services/grokQuota";

describe("Grok billing quota parsing", () => {
  test("parses weekly credit usage", () => { expect(parseGrokBillingPayload({ config: { currentPeriod: { end: "2026-07-28T00:00:00Z" }, creditUsagePercent: 37.5 } }, "weekly")).toMatchObject({ usedPercent: 37.5, remainingPercent: 62.5, resetsAt: "2026-07-28T00:00:00Z" }); });
  test("parses monthly used and limit objects", () => { expect(parseGrokBillingPayload({ config: { monthlyLimit: { val: 15000 }, used: { val: 3000 }, billingPeriodEnd: "2026-08-01T00:00:00Z" } }, "monthly")).toMatchObject({ usedPercent: 20, remainingPercent: 80, resetsAt: "2026-08-01T00:00:00Z" }); });
  test("parses active probe token headers", () => { expect(parseGrokRateLimitHeaders(new Headers({ "x-ratelimit-limit-tokens": "1000000", "x-ratelimit-remaining-tokens": "750000", "x-ratelimit-reset-tokens": "1784678400" }))).toMatchObject({ usedPercent: 25, remainingPercent: 75, label: "Rolling 24h" }); });
});

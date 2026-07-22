import { describe, expect, test } from "vitest";
import { grokPlanType } from "@/src/server/grok/auth";

describe("Grok subscription detection", () => {
  test("normalizes an OAuth response plan", () => { expect(grokPlanType({ subscription_tier: "SuperGrok Heavy" })).toBe("supergrok-heavy"); });
  test("reads a nested JWT plan claim", () => {
    const token = `x.${Buffer.from(JSON.stringify({ account: { plan_type: "SuperGrok" } })).toString("base64url")}.x`;
    expect(grokPlanType({ id_token: token })).toBe("supergrok");
  });
  test("identifies device OAuth as a SuperGrok subscription by default", () => { expect(grokPlanType({})).toBe("supergrok"); });
});

import { describe, expect, test } from "vitest";

import { codexPlanKind, codexPlanLabel, codexPlanShares } from "@/src/shared/codexPlans";

describe("Codex plans", () => {
  test.each(["prolite", "pro-lite", "pro_lite", "Pro 5x", "pro5x"])(
    "maps %s to Pro 5x",
    (plan) => {
      expect(codexPlanKind(plan)).toBe("pro_5x");
      expect(codexPlanShares(plan)).toBe(5);
      expect(codexPlanLabel(plan)).toBe("Pro 5x");
    },
  );

  test("keeps Plus and Pro 20x distinct", () => {
    expect(codexPlanShares("plus")).toBe(1);
    expect(codexPlanShares("pro")).toBe(20);
  });
});

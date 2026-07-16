import { describe, expect, test } from "vitest";
import { isGrokModel } from "@/src/server/http/grokRelay";

describe("Grok provider dispatch", () => {
  test.each(["grok-4.5", "GROK-4.3", " grok-code-fast-1 "])("routes %s to Grok", (model) => {
    expect(isGrokModel(model)).toBe(true);
  });

  test.each(["gpt-5.4", "", null, undefined])("does not route %s to Grok", (model) => {
    expect(isGrokModel(model)).toBe(false);
  });
});

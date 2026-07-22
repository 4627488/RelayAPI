import { describe, expect, test } from "vitest";
import { parseGrokModelIds } from "@/src/server/services/grokModels";

describe("Grok model discovery", () => {
  test("parses OpenAI-compatible model lists", () => { expect(parseGrokModelIds({ data: [{ id: "grok-a" }, { id: "grok-b" }, { id: "grok-a" }] })).toEqual(["grok-a", "grok-b"]); });
  test("accepts the alternate models/name shape", () => { expect(parseGrokModelIds({ models: [{ name: "grok-build" }, "grok-code-fast"] })).toEqual(["grok-build", "grok-code-fast"]); });
});

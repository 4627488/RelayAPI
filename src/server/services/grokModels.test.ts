import { describe, expect, test } from "vitest";
import { parseGrokModels } from "@/src/server/services/grokModels";

describe("Grok model discovery", () => {
  test("preserves upstream metadata and deduplicates models", () => { expect(parseGrokModels({ data: [{ id: "grok-a", context_length: 200000 }, { id: "grok-b" }, { id: "grok-a", display_name: "Grok A" }] })).toEqual([expect.objectContaining({ id: "grok-a", display_name: "Grok A" }), expect.objectContaining({ id: "grok-b" })]); });
  test("accepts the alternate models/name shape", () => { expect(parseGrokModels({ models: [{ name: "grok-build" }, "grok-code-fast"] }).map((model) => model.id)).toEqual(["grok-build", "grok-code-fast"]); });
});

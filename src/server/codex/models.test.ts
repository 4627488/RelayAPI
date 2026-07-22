import { describe, expect, test } from "vitest";
import { codexManifestEntry } from "@/src/server/codex/models";

describe("Codex models manifest", () => {
  test("provides complete metadata for discovered Grok models", () => {
    const grok = codexManifestEntry({ id: "grok-4.5", object: "model", display_name: "Grok 4.5", context_length: 500000, thinking: { levels: ["low", "medium", "high"] } }, 0);
    expect(grok).toMatchObject({ display_name: "Grok 4.5", context_window: 500000, max_context_window: 500000, visibility: "list", supported_in_api: true });
    expect(grok?.supported_reasoning_levels).toEqual(expect.arrayContaining([expect.objectContaining({ effort: "medium" })]));
  });
});

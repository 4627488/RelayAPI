import { describe, expect, test } from "vitest";
import { buildGrokCodexClientModels, codexManifestEntry, validateCodexClientModelsCatalog } from "@/src/server/codex/models";

describe("Codex models manifest", () => {
  test("provides complete metadata for discovered Grok models", () => {
    const templates = validateCodexClientModelsCatalog({ models: [template()] });
    const [grok] = buildGrokCodexClientModels([{ id: "grok-new", object: "model", display_name: "Grok New", context_length: 500000, thinking: { levels: ["low", "medium", "high"] } }], templates);
    expect(grok).toMatchObject({ slug: "grok-new", display_name: "Grok New", context_window: 500000, max_context_window: 500000, visibility: "list", supported_in_api: true, prefer_websockets: false, supports_search_tool: false, shell_type: "shell_command", truncation_policy: { mode: "bytes", limit: 10_000 } });
    expect(grok?.supported_reasoning_levels).toEqual(expect.arrayContaining([expect.objectContaining({ effort: "medium" })]));
    expect(grok?.base_instructions).toContain("Grok New (grok-new)");
    expect(grok?.base_instructions).toContain("provided by xAI");
    expect(grok?.base_instructions).toContain("do not claim to be GPT");
    expect(grok).toHaveProperty("upgrade", null);
  });

  test("does not assign an invented vendor identity to generic routed models", () => {
    const templates = validateCodexClientModelsCatalog({ models: [template()] });
    const [generic] = buildGrokCodexClientModels(
      [{ id: "custom-model", object: "model", display_name: "Custom Model" }],
      templates,
      { provider: "relay" },
    );
    expect(generic?.base_instructions).toContain("Custom Model (custom-model)");
    expect(generic?.base_instructions).toContain("do not claim to be a different model");
    expect(generic?.base_instructions).not.toContain("provided by xAI");
  });

  test("keeps the existing RelayAPI metadata path for Codex models", () => {
    expect(codexManifestEntry({ id: "gpt-test", object: "model" }, 0)).toMatchObject({
      slug: "gpt-test",
      priority: 1,
      shell_type: "shell_command",
      truncation_policy: { mode: "bytes", limit: 10_000 },
      experimental_supported_tools: [],
      base_instructions: expect.stringContaining("gpt-test (gpt-test)"),
    });
  });
});

function template() {
  return { slug: "gpt-5.5", display_name: "GPT-5.5", description: "template", base_instructions: "codex", minimal_client_version: "0.0.0", visibility: "list", default_reasoning_level: "medium", context_window: 400000, max_context_window: 400000, priority: 1, supported_in_api: true, supports_search_tool: true, supported_reasoning_levels: [{ effort: "low", description: "Low" }, { effort: "medium", description: "Medium" }], upgrade: { model: "next" } };
}

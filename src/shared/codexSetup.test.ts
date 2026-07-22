import { describe, expect, test } from "vitest";

import {
  buildApiConfig,
  buildOAuthConfig,
  parseCodexModelManifest,
  serializeCodexModelManifest,
} from "@/src/shared/codexSetup";

describe("Codex setup files", () => {
  test("loads the local model catalog in API Key mode", () => {
    expect(buildApiConfig("grok-4.5")).toContain('model_catalog_json = "./models.json"');
  });

  test("serializes Grok metadata for Codex", () => {
    const manifest = parseCodexModelManifest({
      models: [{ slug: "grok-4.5", context_window: 256000, default_reasoning_level: "high" }],
    });
    expect(JSON.parse(serializeCodexModelManifest(manifest))).toEqual({
      models: [expect.objectContaining({ slug: "grok-4.5", context_window: 256000 })],
    });
  });

  test("keeps OAuth on the remote catalog path", () => {
    const config = buildOAuthConfig("grok-4.5", "sk-test");
    expect(config).toContain("requires_openai_auth = true");
    expect(config).not.toContain("model_catalog_json");
  });
});

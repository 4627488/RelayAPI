import { describe, expect, test } from "vitest";

import {
  buildCodexConfig,
  buildOpenCodeConfig,
  buildOpenAIEnvironment,
  normalizeRelayBaseUrl,
  parseCodexModelManifest,
  serializeCodexModelManifest,
} from "@/src/shared/codexSetup";

describe("client setup files", () => {
  test("uses the current Codex custom-provider authentication contract", () => {
    const config = buildCodexConfig(
      "grok-4.5",
      "relay_sk_test'value",
      "https://relay.example.com",
    );
    expect(config).toContain('model = "grok-4.5"');
    expect(config).toContain('model_reasoning_effort = "medium"');
    expect(config).toContain('base_url = "https://relay.example.com/v1"');
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain('[model_providers.relayapi.auth]');
    expect(config).toContain('command = "powershell"');
    expect(config).toContain("[Console]::Out.Write('relay_sk_test''value')");
    expect(config).toContain('refresh_interval_ms = 0');
    expect(config).toContain('[windows]');
    expect(config).toContain('sandbox = "elevated"');
    expect(config).not.toContain("RELAY_API_KEY");
    expect(config).not.toContain("env_key");
    expect(config).not.toContain("requires_openai_auth");
    expect(config).not.toContain("experimental_bearer_token");
    expect(config).not.toContain("model_catalog_json");
  });

  test("builds an OpenCode Responses provider with the authorized catalog", () => {
    const manifest = parseCodexModelManifest({
      models: [
        { slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol" },
        { slug: "grok-4.5", display_name: "Grok 4.5" },
      ],
    });
    const config = JSON.parse(
      buildOpenCodeConfig("grok-4.5", manifest, "sk-test", "https://relay.example.com/v1/"),
    );
    expect(config.model).toBe("relayapi/grok-4.5");
    expect(config.provider.relayapi.npm).toBe("@ai-sdk/openai");
    expect(config.provider.relayapi.options).toEqual({
      baseURL: "https://relay.example.com/v1",
      apiKey: "sk-test",
    });
    expect(config.provider.relayapi.models["grok-4.5"].name).toBe("Grok 4.5");
  });

  test("serializes Grok metadata for Codex", () => {
    const manifest = parseCodexModelManifest({
      models: [{ slug: "grok-4.5", context_window: 256000, default_reasoning_level: "high" }],
    });
    expect(JSON.parse(serializeCodexModelManifest(manifest))).toEqual({
      models: [expect.objectContaining({ slug: "grok-4.5", context_window: 256000 })],
    });
  });

  test("normalizes base URLs for generic OpenAI-compatible clients", () => {
    expect(normalizeRelayBaseUrl("https://relay.example.com/")).toBe("https://relay.example.com/v1");
    expect(buildOpenAIEnvironment("sk-test", "https://relay.example.com/v1")).toBe(
      "OPENAI_BASE_URL=https://relay.example.com/v1\nOPENAI_API_KEY=sk-test",
    );
  });
});

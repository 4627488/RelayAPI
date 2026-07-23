import { describe, expect, test } from "vitest";

import {
  calculateRequestCost,
  normalizeLiteLlmCatalog,
  resolveModelPrice,
  type ModelPriceEntry,
} from "@/src/server/services/modelPricing";

const catalog: ModelPriceEntry[] = [
  {
    model: "openai/gpt-5",
    source: "litellm",
    version: "catalog-v1",
    inputNanoUsdPerToken: 10n,
    outputNanoUsdPerToken: 30n,
    cachedInputNanoUsdPerToken: 2n,
    cacheWriteNanoUsdPerToken: 12n,
    reasoningNanoUsdPerToken: 40n,
  },
];

describe("model pricing", () => {
  test("administrator overrides take precedence after alias resolution", () => {
    const price = resolveModelPrice("gpt-5.6-terra", {
      aliases: { "gpt-5.6-terra": "openai/gpt-5" },
      catalog,
      overrides: [
        {
          ...catalog[0],
          source: "admin",
          version: "override-v2",
          inputNanoUsdPerToken: 15n,
        },
      ],
    });

    expect(price).toMatchObject({
      requestedModel: "gpt-5.6-terra",
      pricedModel: "openai/gpt-5",
      source: "admin",
      version: "override-v2",
      inputNanoUsdPerToken: 15n,
    });
  });

  test("cached input replaces standard input cost and all components are itemized", () => {
    const price = resolveModelPrice("openai/gpt-5", { catalog });
    expect(price).not.toBeNull();

    const cost = calculateRequestCost(price!, {
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: 40,
      cacheWriteTokens: 3,
      reasoningTokens: 2,
    });

    expect(cost).toEqual({
      inputNanoUsd: 600n,
      outputNanoUsd: 300n,
      cachedInputNanoUsd: 80n,
      cacheWriteNanoUsd: 36n,
      reasoningNanoUsd: 80n,
      totalNanoUsd: 1_096n,
    });
  });

  test("resolves provider-qualified Grok catalog prices from native model IDs", () => {
    const price = resolveModelPrice("grok-4.5", {
      catalog: [
        {
          ...catalog[0],
          model: "xai/grok-4.5",
          inputNanoUsdPerToken: 2_000n,
          outputNanoUsdPerToken: 6_000n,
        },
      ],
    });

    expect(price).toMatchObject({
      requestedModel: "grok-4.5",
      pricedModel: "xai/grok-4.5",
      inputNanoUsdPerToken: 2_000n,
      outputNanoUsdPerToken: 6_000n,
    });
  });

  test("bundles a Grok price so manual parent estimates are enforceable offline", () => {
    expect(resolveModelPrice("grok-4.5")).toMatchObject({
      source: "bundled",
      pricedModel: "xai/grok-4.5",
      inputNanoUsdPerToken: 2_000n,
      outputNanoUsdPerToken: 6_000n,
    });
  });

  test("unknown models do not silently become free", () => {
    expect(resolveModelPrice("missing-model", { catalog })).toBeNull();
  });

  test("uses the bundled last-known-good catalog when no live catalog exists", () => {
    expect(resolveModelPrice("gpt-5.6-terra")).toMatchObject({
      source: "bundled",
      inputNanoUsdPerToken: 2_500n,
      outputNanoUsdPerToken: 15_000n,
      cachedInputNanoUsdPerToken: 250n,
    });
  });

  test("normalizes LiteLLM per-token decimal prices into nano-dollars", () => {
    const entries = normalizeLiteLlmCatalog(
      {
        "openai/gpt-5": {
          input_cost_per_token: 0.00000125,
          output_cost_per_token: 0.00001,
          cache_read_input_token_cost: 1.25e-7,
        },
      },
      "sha256:abc",
    );

    expect(entries).toEqual([
      expect.objectContaining({
        model: "openai/gpt-5",
        version: "sha256:abc",
        inputNanoUsdPerToken: 1_250n,
        outputNanoUsdPerToken: 10_000n,
        cachedInputNanoUsdPerToken: 125n,
      }),
    ]);
  });
});

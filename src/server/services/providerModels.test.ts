import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  codex: vi.fn(),
  grok: vi.fn(),
}));

vi.mock("@/src/server/codex/models", () => ({
  listCodexUpstreamModelIds: mocks.codex,
  listGrokCatalogModelIds: mocks.grok,
}));

import { listProviderModelIds } from "@/src/server/services/providerModels";

describe("provider model catalog", () => {
  beforeEach(() => vi.clearAllMocks());

  test("keeps the combined catalog available when one provider fails", async () => {
    mocks.codex.mockResolvedValue(["gpt-5.6-sol", "shared"]);
    mocks.grok.mockRejectedValue(new Error("Grok unavailable"));

    await expect(listProviderModelIds()).resolves.toEqual([
      "gpt-5.6-sol",
      "shared",
    ]);
  });

  test("deduplicates models returned by multiple providers", async () => {
    mocks.codex.mockResolvedValue(["shared", "codex-only"]);
    mocks.grok.mockResolvedValue(["shared", "grok-only"]);

    await expect(listProviderModelIds()).resolves.toEqual([
      "shared",
      "codex-only",
      "grok-only",
    ]);
  });
});

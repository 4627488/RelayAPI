import { beforeEach, describe, expect, test, vi } from "vitest";

import { HttpError } from "@/src/server/http/errors";

const mocks = vi.hoisted(() => ({
  selectCodex: vi.fn(),
  selectGrok: vi.fn(),
  listChannels: vi.fn(),
}));

vi.mock("@/src/server/repositories/channels", () => ({
  listChannels: mocks.listChannels,
}));
vi.mock("@/src/server/services/channels", () => ({
  selectChannel: mocks.selectCodex,
}));
vi.mock("@/src/server/services/grokRouting", () => ({
  selectGrokChannel: mocks.selectGrok,
}));

import { listRoutableModelsForApiKey, selectProviderForModel } from "@/src/server/services/relayRouting";
import type { RelayApiKeyContext } from "@/src/shared/types/entities";

const apiKey = {
  id: "key-1",
  tenantId: null,
  tenantUserId: null,
  tenant: null,
  name: "test",
  prefix: "relay",
  scopes: ["relay"],
  modelAllowlist: [],
  channelAllowlist: [],
  tokenLimitDaily: null,
  rateLimitPerMinute: null,
} satisfies RelayApiKeyContext;

function selected(id: string, priority: number, healthScore = 100) {
  return {
    channel: { id, priority, healthScore },
    credential: { usageHealth: { score: healthScore } },
  };
}

describe("provider-neutral relay routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listChannels.mockReturnValue([
      { id: "codex-channel", modelAllowlist: ["codex-model"] },
      { id: "grok-channel", modelAllowlist: ["grok-model"] },
    ]);
    mocks.selectCodex.mockImplementation(() => {
      throw new HttpError(503, "no_available_channel", "missing");
    });
    mocks.selectGrok.mockImplementation(() => {
      throw new HttpError(503, "no_available_grok_channel", "missing");
    });
  });

  test("routes a non-Grok-named model through a Grok channel declaration", () => {
    mocks.selectGrok.mockReturnValue(selected("grok-channel", 100));
    expect(selectProviderForModel({ model: "custom-reasoner", apiKey })).toBe("grok");
  });

  test("uses channel priority when both providers declare the model", () => {
    mocks.selectCodex.mockReturnValue(selected("codex-channel", 200));
    mocks.selectGrok.mockReturnValue(selected("grok-channel", 100));
    expect(selectProviderForModel({ model: "shared-model", apiKey })).toBe("codex");
  });

  test("uses channel order rather than model naming for equal priorities", () => {
    mocks.listChannels.mockReturnValue([
      { id: "grok-channel", modelAllowlist: ["shared-model"] },
      { id: "codex-channel", modelAllowlist: ["shared-model"] },
    ]);
    mocks.selectCodex.mockReturnValue(selected("codex-channel", 100));
    mocks.selectGrok.mockReturnValue(selected("grok-channel", 100));
    expect(selectProviderForModel({ model: "gpt-named-but-shared", apiKey })).toBe("grok");
  });

  test("fails when no usable channel declares the model", () => {
    expect(() => selectProviderForModel({ model: "undeclared", apiKey }))
      .toThrowError(/No usable channel declares model/);
  });

  test("prefers a healthy provider over a degraded higher-priority provider", () => {
    mocks.selectCodex.mockReturnValue(selected("codex-channel", 100, 95));
    mocks.selectGrok.mockReturnValue(selected("grok-channel", 500, 40));

    expect(selectProviderForModel({ model: "shared-model", apiKey })).toBe("codex");
  });

  test("lists only models that have a usable provider route", () => {
    mocks.listChannels.mockReturnValue([
      { id: "codex-channel", modelAllowlist: ["codex-model", "offline-model"] },
      { id: "grok-channel", modelAllowlist: ["grok-model"] },
    ]);
    mocks.selectCodex.mockImplementation(({ model }) => {
      if (model === "codex-model") return selected("codex-channel", 100);
      throw new HttpError(503, "no_available_channel", "missing");
    });
    mocks.selectGrok.mockImplementation(({ model }) => {
      if (model === "grok-model") return selected("grok-channel", 100);
      throw new HttpError(503, "no_available_grok_channel", "missing");
    });

    expect(listRoutableModelsForApiKey(apiKey)).toEqual(["codex-model", "grok-model"]);
  });
});

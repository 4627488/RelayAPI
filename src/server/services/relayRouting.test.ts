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

import { selectProviderForModel } from "@/src/server/services/relayRouting";
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

describe("provider-neutral relay routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listChannels.mockReturnValue([
      { id: "codex-channel" },
      { id: "grok-channel" },
    ]);
    mocks.selectCodex.mockImplementation(() => {
      throw new HttpError(503, "no_available_channel", "missing");
    });
    mocks.selectGrok.mockImplementation(() => {
      throw new HttpError(503, "no_available_grok_channel", "missing");
    });
  });

  test("routes a non-Grok-named model through a Grok channel declaration", () => {
    mocks.selectGrok.mockReturnValue({ channel: { id: "grok-channel", priority: 100 } });
    expect(selectProviderForModel({ model: "custom-reasoner", apiKey })).toBe("grok");
  });

  test("uses channel priority when both providers declare the model", () => {
    mocks.selectCodex.mockReturnValue({ channel: { id: "codex-channel", priority: 200 } });
    mocks.selectGrok.mockReturnValue({ channel: { id: "grok-channel", priority: 100 } });
    expect(selectProviderForModel({ model: "shared-model", apiKey })).toBe("codex");
  });

  test("uses channel order rather than model naming for equal priorities", () => {
    mocks.listChannels.mockReturnValue([
      { id: "grok-channel" },
      { id: "codex-channel" },
    ]);
    mocks.selectCodex.mockReturnValue({ channel: { id: "codex-channel", priority: 100 } });
    mocks.selectGrok.mockReturnValue({ channel: { id: "grok-channel", priority: 100 } });
    expect(selectProviderForModel({ model: "gpt-named-but-shared", apiKey })).toBe("grok");
  });

  test("fails when no usable channel declares the model", () => {
    expect(() => selectProviderForModel({ model: "undeclared", apiKey }))
      .toThrowError(/No usable channel declares model/);
  });
});

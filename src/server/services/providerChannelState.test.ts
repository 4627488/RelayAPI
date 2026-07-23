import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendEvent: vi.fn(),
  credentialFailure: vi.fn(() => "2026-07-23T01:00:00.000Z"),
  credentialSuccess: vi.fn(),
  updateChannel: vi.fn(),
}));

vi.mock("@/src/server/repositories/channels", () => ({
  deleteChannel: vi.fn(),
  getChannelById: vi.fn(),
  insertChannel: vi.fn(),
  listChannels: vi.fn(() => []),
  markChannelUsed: vi.fn(),
  updateChannel: mocks.updateChannel,
}));
vi.mock("@/src/server/repositories/codexCredentials", () => ({
  getCodexCredentialWithTokens: vi.fn(),
  listCodexCredentials: vi.fn(() => []),
}));
vi.mock("@/src/server/repositories/providerCredentials", () => ({
  getProviderCredentialWithTokens: vi.fn(),
}));
vi.mock("@/src/server/repositories/logs", () => ({
  channelUsageHealth: vi.fn(() => ({})),
  credentialUsageHealth: vi.fn(() => ({})),
}));
vi.mock("@/src/server/repositories/operationalEvents", () => ({
  appendChannelHealthEvent: mocks.appendEvent,
}));
vi.mock("@/src/server/services/providerCredentialState", () => ({
  markProviderCredentialUsed: vi.fn(),
  recordProviderCredentialFailure: mocks.credentialFailure,
  recordProviderCredentialSuccess: mocks.credentialSuccess,
  resolveCredentialCooldownUntil: vi.fn(),
}));
vi.mock("@/src/server/services/tenantQuota", () => ({
  eligibleCredentialIdsForTenant: vi.fn(() => []),
}));

import {
  recordChannelFailure,
  recordChannelSuccess,
} from "@/src/server/services/channels";
import type { ChannelRecord } from "@/src/shared/types/entities";

const grokChannel = {
  id: "ch-grok",
  name: "Grok",
  provider: "grok",
  credentialId: "grok-1",
  credentialIds: ["grok-1"],
  healthScore: 75,
} as ChannelRecord;

describe("provider channel lifecycle", () => {
  beforeEach(() => vi.clearAllMocks());

  test("records Grok success against both channel and credential", () => {
    mocks.updateChannel.mockReturnValue({ ...grokChannel, healthScore: 77 });

    recordChannelSuccess(grokChannel);

    expect(mocks.credentialSuccess).toHaveBeenCalledWith("grok", "grok-1");
    expect(mocks.updateChannel).toHaveBeenCalledWith(
      "ch-grok",
      expect.objectContaining({ healthScore: 77, lastError: null }),
    );
    expect(mocks.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "success", channelId: "ch-grok" }),
    );
  });

  test("records Grok rate limits as credential-scoped cooldowns", () => {
    recordChannelFailure(grokChannel, {
      statusCode: 429,
      message: "rate limited",
    });

    expect(mocks.credentialFailure).toHaveBeenCalledWith(
      "grok",
      "grok-1",
      expect.objectContaining({ statusCode: 429 }),
    );
    expect(mocks.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "credential_failure",
        cooldownUntil: "2026-07-23T01:00:00.000Z",
      }),
    );
  });
});

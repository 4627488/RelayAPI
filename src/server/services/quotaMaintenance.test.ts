import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getQuota: vi.fn(),
  listCredentials: vi.fn(),
  refreshPricing: vi.fn(),
  reclaim: vi.fn(() => 2),
}));

vi.mock("@/src/server/repositories/providerCredentials", () => ({
  listProviderCredentials: mocks.listCredentials,
}));
vi.mock("@/src/server/repositories/quotaAccounting", () => ({
  reclaimExpiredQuotaReservations: mocks.reclaim,
}));
vi.mock("@/src/server/services/providerQuota", () => ({
  getProviderQuota: mocks.getQuota,
  providerCredentialSupportsQuota: (credential: { provider: string; authType?: string }) =>
    credential.provider === "codex" || credential.authType === "oauth",
}));
vi.mock("@/src/server/services/quotaAdministration", () => ({
  refreshLiteLlmPricing: mocks.refreshPricing,
}));
vi.mock("@/src/server/http/errors", () => ({
  logServerError: vi.fn(),
}));

import { runQuotaMaintenance } from "@/src/server/services/quotaMaintenance";

describe("provider quota maintenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.refreshPricing.mockResolvedValue(undefined);
    mocks.getQuota.mockResolvedValue(undefined);
  });

  test("refreshes Codex and Grok OAuth while skipping Grok API keys", async () => {
    mocks.listCredentials.mockReturnValue([
      { id: "codex-1", provider: "codex", enabled: true },
      { id: "grok-oauth", provider: "grok", authType: "oauth", enabled: true },
      { id: "grok-key", provider: "grok", authType: "api_key", enabled: true },
      { id: "disabled", provider: "codex", enabled: false },
    ]);

    const result = await runQuotaMaintenance({
      running: false,
      lastPriceRefreshAt: Date.now(),
      lastQuotaRefreshAt: 0,
    });

    expect(result).toMatchObject({ skipped: false, reclaimed: 2 });
    expect(mocks.getQuota).toHaveBeenCalledTimes(2);
    expect(mocks.getQuota).toHaveBeenCalledWith("codex", "codex-1", {
      forceRefresh: true,
    });
    expect(mocks.getQuota).toHaveBeenCalledWith("grok", "grok-oauth", {
      forceRefresh: true,
    });
  });
});

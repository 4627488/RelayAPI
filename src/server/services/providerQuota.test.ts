import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  codex: vi.fn(),
  grok: vi.fn(),
}));

vi.mock("@/src/server/services/codexQuota", () => ({
  getCodexQuota: mocks.codex,
}));
vi.mock("@/src/server/services/grokQuota", () => ({
  getGrokQuota: mocks.grok,
}));
vi.mock("@/src/server/http/errors", () => ({
  logServerError: vi.fn(),
}));

import {
  getProviderQuota,
  providerCredentialSupportsQuota,
} from "@/src/server/services/providerQuota";

describe("provider quota service", () => {
  beforeEach(() => vi.clearAllMocks());

  test("deduplicates concurrent reads with the same provider options", async () => {
    let resolve!: (value: unknown) => void;
    mocks.grok.mockReturnValue(new Promise((done) => { resolve = done; }));

    const first = getProviderQuota("grok", "grok-1");
    const second = getProviderQuota("grok", "grok-1");

    expect(mocks.grok).toHaveBeenCalledTimes(1);
    resolve({ status: "available" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "available" },
      { status: "available" },
    ]);
  });

  test("does not merge reads with different refresh options", async () => {
    mocks.codex.mockResolvedValue({ provider: "codex" });

    await Promise.all([
      getProviderQuota("codex", "codex-1"),
      getProviderQuota("codex", "codex-1", { forceRefresh: true }),
    ]);

    expect(mocks.codex).toHaveBeenCalledTimes(2);
  });

  test("exposes subscription quota only for Codex and Grok OAuth", () => {
    expect(providerCredentialSupportsQuota({ provider: "codex" } as never)).toBe(true);
    expect(providerCredentialSupportsQuota({ provider: "grok", authType: "oauth" } as never)).toBe(true);
    expect(providerCredentialSupportsQuota({ provider: "grok", authType: "api_key" } as never)).toBe(false);
  });
});

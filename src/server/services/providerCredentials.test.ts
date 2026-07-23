import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  detach: vi.fn(),
  getCredential: vi.fn(),
  removeCodex: vi.fn(),
  removeGrok: vi.fn(),
}));

vi.mock("@/src/server/repositories/channels", () => ({
  detachCredentialFromChannels: mocks.detach,
}));
vi.mock("@/src/server/repositories/providerCredentials", () => ({
  getProviderCredential: mocks.getCredential,
}));
vi.mock("@/src/server/services/codexCredentials", () => ({
  listPublicCodexCredentials: vi.fn(() => []),
  patchCodexCredentialRouting: vi.fn(),
  removeCodexCredential: mocks.removeCodex,
}));
vi.mock("@/src/server/services/grokCredentials", () => ({
  listPublicGrokCredentials: vi.fn(() => []),
  patchGrokCredential: vi.fn(),
  removeGrokCredential: mocks.removeGrok,
}));

import { removeProviderCredential } from "@/src/server/services/providerCredentials";

describe("provider credential service", () => {
  beforeEach(() => vi.clearAllMocks());

  test("detaches Grok credentials from channels before deletion", async () => {
    mocks.getCredential.mockReturnValue({ id: "grok-1", provider: "grok" });
    await removeProviderCredential("grok", "grok-1");

    expect(mocks.detach).toHaveBeenCalledWith("grok-1");
    expect(mocks.removeGrok).toHaveBeenCalledWith("grok-1");
    expect(mocks.detach.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeGrok.mock.invocationCallOrder[0],
    );
  });

  test("does not detach a credential when the requested provider is wrong", async () => {
    mocks.getCredential.mockReturnValue({ id: "codex-1", provider: "codex" });
    mocks.removeGrok.mockRejectedValue(new Error("not found"));

    await expect(removeProviderCredential("grok", "codex-1")).rejects.toThrow(
      "not found",
    );
    expect(mocks.detach).not.toHaveBeenCalled();
  });
});

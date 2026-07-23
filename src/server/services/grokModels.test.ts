import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  credentials: vi.fn(),
  ensure: vi.fn(),
}));

vi.mock("@/src/server/net/proxy", () => ({ proxiedFetch: mocks.fetch }));
vi.mock("@/src/server/repositories/grokCredentials", () => ({
  listGrokCredentialsWithTokens: mocks.credentials,
}));
vi.mock("@/src/server/services/grokCredentials", () => ({
  ensureFreshGrokCredential: mocks.ensure,
  forceRefreshGrokCredential: vi.fn(),
}));
vi.mock("@/src/server/services/providerProxy", () => ({
  resolveProviderCredentialProxy: () => null,
}));

import {
  listGrokUpstreamModels,
  parseGrokModels,
} from "@/src/server/services/grokModels";

describe("Grok model discovery", () => {
  beforeEach(() => vi.clearAllMocks());
  test("preserves upstream metadata and deduplicates models", () => { expect(parseGrokModels({ data: [{ id: "grok-a", context_length: 200000 }, { id: "grok-b" }, { id: "grok-a", display_name: "Grok A" }] })).toEqual([expect.objectContaining({ id: "grok-a", display_name: "Grok A" }), expect.objectContaining({ id: "grok-b" })]); });
  test("accepts the alternate models/name shape", () => { expect(parseGrokModels({ models: [{ name: "grok-build" }, "grok-code-fast"] }).map((model) => model.id)).toEqual(["grok-build", "grok-code-fast"]); });

  test("shares one upstream refresh across concurrent catalog requests", async () => {
    const credential = {
      id: "grok-model-credential",
      provider: "grok",
      enabled: true,
      authType: "api_key",
      grokBaseUrl: "https://api.x.ai/v1",
      tokens: { api_key: "secret", access_token: "" },
      proxy: null,
      proxyPoolId: null,
      useGlobalProxy: false,
    };
    mocks.credentials.mockReturnValue([credential]);
    mocks.ensure.mockResolvedValue(credential);
    let resolveFetch!: (response: Response) => void;
    mocks.fetch.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const first = listGrokUpstreamModels();
    const second = listGrokUpstreamModels();
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    resolveFetch(Response.json({ data: [{ id: "grok-shared" }] }));

    await expect(Promise.all([first, second])).resolves.toEqual([
      [expect.objectContaining({ id: "grok-shared" })],
      [expect.objectContaining({ id: "grok-shared" })],
    ]);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});

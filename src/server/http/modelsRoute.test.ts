import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleCodexModels: vi.fn(),
  handleModels: vi.fn(),
}));

vi.mock("@/src/server/http/cors", () => ({
  corsPreflightResponse: vi.fn(),
  withCors: (handler: () => unknown) => handler(),
}));

vi.mock("@/src/server/http/relay", () => mocks);

import { GET } from "@/app/v1/models/route";

describe("GET /v1/models", () => {
  beforeEach(() => {
    mocks.handleCodexModels.mockReset().mockResolvedValue(new Response("codex"));
    mocks.handleModels.mockReset().mockResolvedValue(new Response("openai"));
  });

  test("serves the authenticated Codex catalog on explicit format requests", async () => {
    await GET(new Request("https://relay.example/v1/models?format=codex"));
    expect(mocks.handleCodexModels).toHaveBeenCalledOnce();
    expect(mocks.handleModels).not.toHaveBeenCalled();
  });

  test("preserves Codex client_version discovery and generic OpenAI listings", async () => {
    await GET(new Request("https://relay.example/v1/models?client_version=0.144.0"));
    expect(mocks.handleCodexModels).toHaveBeenCalledOnce();

    await GET(new Request("https://relay.example/v1/models"));
    expect(mocks.handleModels).toHaveBeenCalledOnce();
  });
});

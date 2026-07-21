import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  grokFetch: vi.fn(), appendSuccessLog: vi.fn(), appendErrorLog: vi.fn(),
  settleRelayQuota: vi.fn(() => ({ subscriptionId: "sub-1" })), releaseRelayQuota: vi.fn(),
  recordSuccess: vi.fn(), recordFailure: vi.fn(),
}));

vi.mock("@/src/server/grok/client", () => ({ grokFetch: mocks.grokFetch }));
vi.mock("@/src/server/services/apiKeys", () => ({ authenticateRelayRequest: () => ({ id: "key-1", tenantId: null, tenant: null, prefix: "rk", name: "test", modelAllowlist: [], channelAllowlist: [] }) }));
vi.mock("@/src/server/services/grokRouting", () => ({
  selectGrokChannel: () => ({ channel: { id: "ch-1", name: "Grok", provider: "grok", credentialId: "grok-1", credentialIds: ["grok-1"] }, credential: { id: "grok-1" } }),
  recordGrokCredentialSuccess: mocks.recordSuccess,
  recordGrokCredentialFailure: mocks.recordFailure,
}));
vi.mock("@/src/server/http/relayAccounting", () => ({
  admitRelayQuota: () => ({ requestId: "req-1", tenantId: "", subscriptionId: "sub-1", state: null, price: null }),
  settleRelayQuota: mocks.settleRelayQuota,
  releaseRelayQuota: mocks.releaseRelayQuota,
  quotaResponseHeaders: () => ({}),
}));
vi.mock("@/src/server/http/relayRequestLogging", () => ({ appendSuccessLog: mocks.appendSuccessLog, appendErrorLog: mocks.appendErrorLog }));
vi.mock("@/src/server/services/settings", () => ({ getFullRequestLoggingSetting: () => true }));
vi.mock("@/src/server/services/tenantQuota", () => ({ tenantQuotaHeaders: () => ({}) }));

import { handleGrokChatCompletions, handleGrokResponses } from "@/src/server/http/grokRelay";

const credential = { id: "grok-1", email: "grok@example.com" };
const upstreamPayload = { model: "grok-4.5", input: "hi" };
function request(path: string, body: Record<string, unknown>) { return new Request(`http://localhost${path}`, { method: "POST", headers: { Authorization: "Bearer rk-test", "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
function sse(events: unknown[]) { return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""); }

describe("Grok relay logging", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.settleRelayQuota.mockReturnValue({ subscriptionId: "sub-1" }); });

  test("logs and settles a non-stream Responses request", async () => {
    mocks.grokFetch.mockResolvedValue({ response: Response.json({ id: "resp-1", model: "grok-4.5", usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 }, output: [] }), credential, upstreamPayload });
    const response = await handleGrokResponses(request("/v1/responses", { model: "grok-4.5", input: "hi", stream: false }));
    expect(response.status).toBe(200);
    expect(mocks.settleRelayQuota).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ promptTokens: 7, completionTokens: 3, totalTokens: 10 }), "grok-1", null);
    expect(mocks.appendSuccessLog).toHaveBeenCalledWith(expect.objectContaining({ requestType: "responses", stream: false, credentialEmail: "grok@example.com", forwardedBody: upstreamPayload, subscriptionId: "sub-1" }));
  });

  test("logs a completed streaming Responses request after the body is consumed", async () => {
    const body = sse([{ type: "response.output_text.delta", delta: "ok" }, { type: "response.completed", response: { id: "resp-2", usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } }]);
    mocks.grokFetch.mockResolvedValue({ response: new Response(body, { headers: { "Content-Type": "text/event-stream" } }), credential, upstreamPayload });
    const response = await handleGrokResponses(request("/v1/responses", { model: "grok-4.5", input: "hi", stream: true }));
    await response.text();
    expect(mocks.appendSuccessLog).toHaveBeenCalledWith(expect.objectContaining({ requestType: "responses", stream: true, statusCode: 200, usage: expect.objectContaining({ totalTokens: 6 }), upstreamBody: expect.stringContaining("response.completed") }));
    expect(mocks.recordSuccess).toHaveBeenCalledWith("grok-1");
  });

  test("logs upstream errors with request and forwarded bodies", async () => {
    mocks.grokFetch.mockResolvedValue({ response: Response.json({ error: { message: "bad tool" } }, { status: 400 }), credential, upstreamPayload });
    const response = await handleGrokResponses(request("/v1/responses", { model: "grok-4.5", input: "hi" }));
    expect(response.status).toBe(400);
    expect(mocks.releaseRelayQuota).toHaveBeenCalled();
    expect(mocks.appendSuccessLog).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, errorCode: "upstream_error", errorMessage: "bad tool", forwardedBody: upstreamPayload }));
  });

  test("logs non-stream Chat Completions usage", async () => {
    const body = sse([{ type: "response.completed", response: { id: "resp-chat", model: "grok-4.5", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } }]);
    mocks.grokFetch.mockResolvedValue({ response: new Response(body, { headers: { "Content-Type": "text/event-stream" } }), credential, upstreamPayload });
    const response = await handleGrokChatCompletions(request("/v1/chat/completions", { model: "grok-4.5", messages: [{ role: "user", content: "hi" }], stream: false }));
    expect(response.status).toBe(200);
    expect(mocks.appendSuccessLog).toHaveBeenCalledWith(expect.objectContaining({ requestType: "chat.completions", stream: false, usage: expect.objectContaining({ totalTokens: 3 }) }));
  });
});

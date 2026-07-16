import "server-only";
import { proxiedFetch } from "@/src/server/net/proxy";
import { ensureFreshGrokCredential, forceRefreshGrokCredential } from "@/src/server/services/grokCredentials";
import { resolveCredentialProxy } from "@/src/server/services/codexCredentials";
import type { ChannelRecord, TenantRuntimeContext } from "@/src/shared/types/entities";

const CLIENT_VERSION = "0.2.93";
export async function grokFetch(payload: Record<string, unknown>, input: { channel: ChannelRecord; tenant?: TenantRuntimeContext | null; stream: boolean }) {
  let credential = await ensureFreshGrokCredential(input.channel.credentialId);
  const oauth = credential.authType === "oauth"; const token = oauth ? credential.tokens.access_token : credential.tokens.api_key;
  const base = (input.channel.baseUrl || (oauth ? "https://cli-chat-proxy.grok.com/v1" : "https://api.x.ai/v1")).replace(/\/+$/, "");
  const proxy = resolveCredentialProxy({ proxy: credential.proxy, proxyPoolId: credential.proxyPoolId, useGlobalProxy: input.tenant ? true : credential.useGlobalProxy, tenantProxy: input.tenant?.proxy || null });
  let headers = buildHeaders(token, oauth, input.stream);
  const execute = () => proxiedFetch(`${base}/responses`, { method: "POST", headers, body: JSON.stringify({ ...payload, stream: input.stream }), signal: AbortSignal.timeout(input.stream ? 1_800_000 : 300_000) }, proxy);
  let response = await execute();
  if (response.status === 401 && oauth && credential.tokens.refresh_token) { await response.body?.cancel().catch(() => undefined); credential = await forceRefreshGrokCredential(credential.id); headers = buildHeaders(credential.tokens.access_token, true, input.stream); response = await execute(); }
  return { response, credential, upstreamPayload: payload };
}
function buildHeaders(token: string, oauth: boolean, stream: boolean) { return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: stream ? "text/event-stream" : "application/json", ...(oauth ? { "X-XAI-Token-Auth": "xai-grok-cli", "X-Grok-Client-Version": CLIENT_VERSION } : {}) }; }

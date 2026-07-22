import "server-only";

import { proxiedFetch } from "@/src/server/net/proxy";
import { listGrokCredentialsWithTokens } from "@/src/server/repositories/grokCredentials";
import { resolveCredentialProxy } from "@/src/server/services/codexCredentials";
import { ensureFreshGrokCredential, forceRefreshGrokCredential } from "@/src/server/services/grokCredentials";

const CACHE_MS = 5 * 60_000;
let cache: { ids: string[]; expiresAt: number } = { ids: [], expiresAt: 0 };

export async function listGrokUpstreamModelIds() {
  if (Date.now() < cache.expiresAt) return [...cache.ids];
  const credentials = listGrokCredentialsWithTokens().filter((credential) => credential.enabled);
  const results = await Promise.allSettled(credentials.map(async (stored) => {
    let credential = await ensureFreshGrokCredential(stored.id);
    const oauth = credential.authType === "oauth";
    const base = (credential.grokBaseUrl || (oauth ? "https://cli-chat-proxy.grok.com/v1" : "https://api.x.ai/v1")).replace(/\/+$/, "");
    const proxy = resolveCredentialProxy({ proxy: credential.proxy, proxyPoolId: credential.proxyPoolId, useGlobalProxy: credential.useGlobalProxy, tenantProxy: null });
    const request = () => proxiedFetch(`${base}/models`, { headers: { Authorization: `Bearer ${oauth ? credential.tokens.access_token : credential.tokens.api_key}`, Accept: "application/json", ...(oauth ? { "X-XAI-Token-Auth": "xai-grok-cli", "X-Grok-Client-Version": "0.2.93" } : {}) }, signal: AbortSignal.timeout(20_000) }, proxy);
    let response = await request();
    if (response.status === 401 && oauth && credential.tokens.refresh_token) { await response.body?.cancel().catch(() => undefined); credential = await forceRefreshGrokCredential(credential.id); response = await request(); }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); return []; }
    return parseGrokModelIds(await response.json());
  }));
  const ids = [...new Set(results.flatMap((result) => result.status === "fulfilled" ? result.value : []))].sort();
  if (ids.length > 0 || credentials.length === 0) cache = { ids, expiresAt: Date.now() + CACHE_MS };
  return ids.length > 0 ? ids : [...cache.ids];
}

export function parseGrokModelIds(payload: unknown) {
  const root = record(payload);
  const data = Array.isArray(root?.data) ? root.data : Array.isArray(root?.models) ? root.models : [];
  return [...new Set(data.map((entry) => typeof entry === "string" ? entry.trim() : text(record(entry)?.id) || text(record(entry)?.name)).filter((id): id is string => Boolean(id)))];
}

function record(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }

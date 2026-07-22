import "server-only";

import { proxiedFetch } from "@/src/server/net/proxy";
import { listGrokCredentialsWithTokens } from "@/src/server/repositories/grokCredentials";
import { resolveCredentialProxy } from "@/src/server/services/codexCredentials";
import { ensureFreshGrokCredential, forceRefreshGrokCredential } from "@/src/server/services/grokCredentials";

const CACHE_MS = 60_000;
export type GrokUpstreamModel = Record<string, unknown> & { id: string; object: string; owned_by: string };
let cache: { models: GrokUpstreamModel[]; expiresAt: number } = { models: [], expiresAt: 0 };

export async function listGrokUpstreamModels() {
  if (Date.now() < cache.expiresAt) return structuredClone(cache.models);
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
    return parseGrokModels(await response.json());
  }));
  const byId = new Map<string, GrokUpstreamModel>();
  for (const model of results.flatMap((result) => result.status === "fulfilled" ? result.value : [])) byId.set(model.id, { ...(byId.get(model.id) || {}), ...model });
  const models = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  if (models.length > 0 || credentials.length === 0) cache = { models, expiresAt: Date.now() + CACHE_MS };
  return structuredClone(models.length > 0 ? models : cache.models);
}

export async function listGrokUpstreamModelIds() { return (await listGrokUpstreamModels()).map((model) => model.id); }

export function parseGrokModels(payload: unknown): GrokUpstreamModel[] {
  const root = record(payload);
  const data = Array.isArray(root?.data) ? root.data : Array.isArray(root?.models) ? root.models : [];
  const byId = new Map<string, GrokUpstreamModel>();
  for (const raw of data) {
    const source = typeof raw === "string" ? { id: raw } : record(raw);
    const id = text(source?.id) || text(source?.name);
    if (!id) continue;
    byId.set(id, { ...(byId.get(id) || {}), ...structuredClone(source || {}), id, object: text(source?.object) || "model", owned_by: text(source?.owned_by) || "xai" });
  }
  return [...byId.values()];
}

function record(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }

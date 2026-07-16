import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { getMainOrm } from "@/src/server/db/sqlite";
import { codexCredentials } from "@/src/server/db/schema";
import { decryptJson, encryptJson, jsonStringify, safeJsonParse } from "@/src/server/services/crypto";
import type { CredentialProxyConfig, GrokCredentialRecord, GrokCredentialWithTokens, GrokTokenBundle, ProviderAuthType, PublicCredentialProxyConfig } from "@/src/shared/types/entities";

type Row = typeof codexCredentials.$inferSelect;

export function listGrokCredentials(): GrokCredentialRecord[] {
  return getMainOrm().select().from(codexCredentials)
    .where(eq(codexCredentials.provider, "grok"))
    .orderBy(desc(codexCredentials.createdAt)).all().map(toPublic);
}

export function listGrokCredentialsWithTokens(): GrokCredentialWithTokens[] {
  return getMainOrm().select().from(codexCredentials)
    .where(eq(codexCredentials.provider, "grok"))
    .orderBy(desc(codexCredentials.createdAt)).all().map(toSecret);
}

export function getGrokCredentialWithTokens(id: string) {
  const row = getMainOrm().select().from(codexCredentials)
    .where(and(eq(codexCredentials.id, id), eq(codexCredentials.provider, "grok"))).get();
  return row ? toSecret(row) : null;
}

export function saveGrokCredential(input: {
  id: string; authType: ProviderAuthType; email?: string; subject?: string;
  planType?: string; tokens: GrokTokenBundle; proxy?: CredentialProxyConfig | null;
  enabled?: boolean; priority?: number; weight?: number; metadata?: Record<string, unknown>;
}) {
  const existing = getGrokCredentialWithTokens(input.id);
  const now = new Date().toISOString();
  const metadata = { ...(existing?.metadata || {}), ...(input.metadata || {}), auth_type: input.authType };
  const values = {
    id: input.id, provider: "grok", email: input.email || existing?.email || "",
    accountId: input.subject || existing?.subject || "", planType: input.planType || existing?.planType || "grok-subscription",
    tokenEnvelope: encryptJson(input.tokens), proxyEnvelope: input.proxy ? encryptJson(input.proxy) : null,
    enabled: (input.enabled ?? existing?.enabled ?? true) ? 1 : 0,
    priority: input.priority ?? existing?.priority ?? 100, weight: Math.max(1, input.weight ?? existing?.weight ?? 1),
    expiresAt: input.tokens.expired || null, lastRefreshAt: now, lastUsedAt: existing?.lastUsedAt || null,
    metadataJson: jsonStringify(metadata), createdAt: existing?.createdAt || now, updatedAt: now,
  };
  getMainOrm().insert(codexCredentials).values(values).onConflictDoUpdate({ target: codexCredentials.id, set: values }).run();
  return getGrokCredentialWithTokens(input.id)!;
}

export function updateGrokCredential(id: string, patch: Partial<Pick<GrokCredentialRecord, "enabled" | "priority" | "weight" | "lastUsedAt" | "cooldownUntil" | "lastError">>) {
  const existing = getGrokCredentialWithTokens(id); if (!existing) return null;
  const next = { ...existing, ...patch };
  const metadata = { ...next.metadata, auth_type: next.authType, cooldown_until: next.cooldownUntil, last_error: next.lastError };
  getMainOrm().update(codexCredentials).set({ enabled: next.enabled ? 1 : 0, priority: next.priority, weight: Math.max(1, next.weight), lastUsedAt: next.lastUsedAt, metadataJson: jsonStringify(metadata), updatedAt: new Date().toISOString() })
    .where(and(eq(codexCredentials.id, id), eq(codexCredentials.provider, "grok"))).run();
  return getGrokCredentialWithTokens(id);
}

export function deleteGrokCredential(id: string) {
  return getMainOrm().delete(codexCredentials).where(and(eq(codexCredentials.id, id), eq(codexCredentials.provider, "grok"))).run().changes > 0;
}

function toPublic(row: Row): GrokCredentialRecord {
  const metadata = safeJsonParse<Record<string, unknown>>(row.metadataJson, {});
  return { id: row.id, provider: "grok", authType: metadata.auth_type === "api_key" ? "api_key" : "oauth", email: row.email, subject: row.accountId, planType: row.planType,
    enabled: row.enabled === 1, priority: row.priority, weight: row.weight, useGlobalProxy: metadata.use_global_proxy === true,
    proxyPoolId: text(metadata.proxy_pool_id), proxy: publicProxy(row.proxyEnvelope), expiresAt: row.expiresAt, lastRefreshAt: row.lastRefreshAt,
    lastUsedAt: row.lastUsedAt, cooldownUntil: text(metadata.cooldown_until), lastError: text(metadata.last_error), createdAt: row.createdAt, updatedAt: row.updatedAt, metadata };
}
function toSecret(row: Row): GrokCredentialWithTokens { return { ...toPublic(row), proxy: secretProxy(row.proxyEnvelope), tokens: decryptJson<GrokTokenBundle>(row.tokenEnvelope) }; }
function secretProxy(value: string | null) { try { return value ? decryptJson<CredentialProxyConfig>(value) : null; } catch { return null; } }
function publicProxy(value: string | null): PublicCredentialProxyConfig | null { const p = secretProxy(value); return p ? { enabled: p.enabled, type: p.type, host: p.host, port: p.port, username: p.username, passwordSet: Boolean(p.password) } : null; }
function text(value: unknown) { return typeof value === "string" && value.trim() ? value : null; }

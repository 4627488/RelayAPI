import "server-only";

import { asc, desc, eq } from "drizzle-orm";

import { getMainOrm } from "@/src/server/db/sqlite";
import { codexCredentials } from "@/src/server/db/schema";
import type {
  CodexCredentialRecord,
  CodexCredentialWithTokens,
  CodexTokenBundle,
  CodexUpstreamTransport,
  CredentialProxyConfig,
  PublicCredentialProxyConfig,
} from "@/src/shared/types/entities";
import {
  decryptJson,
  encryptJson,
  jsonStringify,
  safeJsonParse,
} from "@/src/server/services/crypto";

type CodexCredentialRow = typeof codexCredentials.$inferSelect;

export interface SaveCodexCredentialInput {
  id: string;
  email: string;
  accountId: string;
  planType: string;
  tokens: CodexTokenBundle;
  proxy?: CredentialProxyConfig | null;
  enabled?: boolean;
  priority?: number;
  weight?: number;
  metadata?: Record<string, unknown>;
}

export function listCodexCredentials(): CodexCredentialRecord[] {
  const rows = getMainOrm()
    .select()
    .from(codexCredentials)
    .orderBy(desc(codexCredentials.createdAt))
    .all();
  return rows.map((row: CodexCredentialRow) => toCodexCredentialRecord(row));
}

export function listCodexCredentialsWithTokens(): CodexCredentialWithTokens[] {
  const rows = getMainOrm()
    .select()
    .from(codexCredentials)
    .orderBy(desc(codexCredentials.createdAt))
    .all();
  return rows.map((row: CodexCredentialRow) =>
    toCodexCredentialWithTokens(row),
  );
}

export function getCodexCredentialById(
  id: string,
): CodexCredentialRecord | null {
  const row = getMainOrm()
    .select()
    .from(codexCredentials)
    .where(eq(codexCredentials.id, id))
    .get();
  return row ? toCodexCredentialRecord(row) : null;
}

export function getCodexCredentialWithTokens(id: string) {
  const row = getMainOrm()
    .select()
    .from(codexCredentials)
    .where(eq(codexCredentials.id, id))
    .get();
  return row ? toCodexCredentialWithTokens(row) : null;
}

export function getFirstCodexCredential() {
  const row = getMainOrm()
    .select()
    .from(codexCredentials)
    .orderBy(asc(codexCredentials.createdAt))
    .limit(1)
    .get();
  return row ? toCodexCredentialRecord(row) : null;
}

export function upsertCodexCredential(input: SaveCodexCredentialInput) {
  const existing = getCodexCredentialWithTokens(input.id);
  const now = new Date().toISOString();
  const createdAt = existing?.createdAt || now;
  const values = {
    id: input.id,
    provider: "codex",
    email: input.email,
    accountId: input.accountId,
    planType: input.planType,
    tokenEnvelope: encryptJson(input.tokens),
    proxyEnvelope: encryptedProxyEnvelope(input.proxy, existing?.proxy),
    enabled: (input.enabled ?? existing?.enabled ?? true) ? 1 : 0,
    priority: input.priority ?? existing?.priority ?? 100,
    weight: Math.max(1, input.weight ?? existing?.weight ?? 1),
    expiresAt: input.tokens.expired || null,
    lastRefreshAt: input.tokens.last_refresh || null,
    lastUsedAt: existing?.lastUsedAt || null,
    metadataJson: jsonStringify({
        ...(existing?.metadata || {}),
        ...(input.metadata || {}),
    }),
    createdAt,
    updatedAt: now,
  };
  getMainOrm()
    .insert(codexCredentials)
    .values(values)
    .onConflictDoUpdate({
      target: codexCredentials.id,
      set: {
        email: values.email,
        accountId: values.accountId,
        planType: values.planType,
        tokenEnvelope: values.tokenEnvelope,
        proxyEnvelope: values.proxyEnvelope,
        enabled: values.enabled,
        priority: values.priority,
        weight: values.weight,
        expiresAt: values.expiresAt,
        lastRefreshAt: values.lastRefreshAt,
        metadataJson: values.metadataJson,
        updatedAt: values.updatedAt,
      },
    })
    .run();
  return getCodexCredentialWithTokens(input.id);
}

export function updateCodexCredential(
  id: string,
  patch: Partial<
    Pick<
      CodexCredentialRecord,
      | "enabled"
      | "planType"
      | "priority"
      | "weight"
      | "fastEnabled"
      | "upstreamTransport"
      | "userAgent"
      | "useGlobalProxy"
      | "proxyPoolId"
      | "proxy"
      | "lastUsedAt"
      | "cooldownUntil"
      | "lastError"
      | "metadata"
    >
  >,
) {
  const existing = getCodexCredentialWithTokens(id);
  if (!existing) {
    return null;
  }
  const next = { ...existing, ...patch };
  const metadata = {
    ...next.metadata,
    fast_service_tier: next.fastEnabled,
    upstream_transport: next.upstreamTransport,
    user_agent: next.userAgent,
    userAgent: next.userAgent,
    use_global_proxy: next.useGlobalProxy,
    proxy_pool_id: next.proxyPoolId,
    cooldown_until: next.cooldownUntil,
    last_error: next.lastError,
  };
  getMainOrm()
    .update(codexCredentials)
    .set({
      enabled: next.enabled ? 1 : 0,
      planType: next.planType,
      priority: next.priority,
      weight: Math.max(1, next.weight),
      proxyEnvelope: next.proxy ? encryptJson(next.proxy) : null,
      lastUsedAt: next.lastUsedAt,
      metadataJson: jsonStringify(metadata),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(codexCredentials.id, id))
    .run();
  return getCodexCredentialWithTokens(id);
}

export function markCodexCredentialUsed(id: string) {
  const now = new Date().toISOString();
  getMainOrm()
    .update(codexCredentials)
    .set({ lastUsedAt: now, updatedAt: now })
    .where(eq(codexCredentials.id, id))
    .run();
}

export function deleteCodexCredential(id: string) {
  const existing = getCodexCredentialById(id);
  if (!existing) {
    return false;
  }
  getMainOrm()
    .delete(codexCredentials)
    .where(eq(codexCredentials.id, id))
    .run();
  return true;
}

function toCodexCredentialRecord(
  row: CodexCredentialRow,
): CodexCredentialRecord {
  const metadata = safeJsonParse<Record<string, unknown>>(
    row.metadataJson,
    {},
  );
  return {
    id: row.id,
    provider: "codex",
    email: row.email,
    accountId: row.accountId,
    planType: row.planType,
    enabled: row.enabled === 1,
    priority: row.priority,
    weight: row.weight,
    fastEnabled: metadata.fast_service_tier === true,
    upstreamTransport: codexUpstreamTransportFromMetadata(metadata),
    userAgent: stringOrNull(
      Object.hasOwn(metadata, "user_agent")
        ? metadata.user_agent
        : metadata.userAgent,
    ),
    useGlobalProxy: metadata.use_global_proxy === true,
    proxyPoolId: stringOrNull(metadata.proxy_pool_id),
    proxy: publicProxyFromEnvelope(row.proxyEnvelope),
    expiresAt: row.expiresAt,
    lastRefreshAt: row.lastRefreshAt,
    lastUsedAt: row.lastUsedAt,
    cooldownUntil: stringOrNull(metadata.cooldown_until),
    lastError: stringOrNull(metadata.last_error),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata,
  };
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function codexUpstreamTransportFromMetadata(
  metadata: Record<string, unknown>,
): CodexUpstreamTransport {
  const value = metadata.upstream_transport;
  if (value === "http" || value === "websocket") {
    return value;
  }
  return "websocket";
}

function toCodexCredentialWithTokens(
  row: CodexCredentialRow,
): CodexCredentialWithTokens {
  return {
    ...toCodexCredentialRecord(row),
    proxy: credentialProxyFromEnvelope(row.proxyEnvelope),
    tokens: decryptJson<CodexTokenBundle>(row.tokenEnvelope),
  };
}

function encryptedProxyEnvelope(
  proxy: CredentialProxyConfig | null | undefined,
  existingProxy: CredentialProxyConfig | null | undefined,
) {
  const nextProxy = proxy === undefined ? existingProxy : proxy;
  return nextProxy ? encryptJson(nextProxy) : null;
}

function credentialProxyFromEnvelope(envelope: string | null) {
  if (!envelope) {
    return null;
  }
  try {
    return decryptJson<CredentialProxyConfig>(envelope);
  } catch {
    return null;
  }
}

function publicProxyFromEnvelope(
  envelope: string | null,
): PublicCredentialProxyConfig | null {
  const proxy = credentialProxyFromEnvelope(envelope);
  if (!proxy) {
    return null;
  }
  return {
    enabled: proxy.enabled,
    type: proxy.type,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    passwordSet: Boolean(proxy.password),
  };
}

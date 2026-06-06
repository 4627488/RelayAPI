import "server-only";

import { count, eq, isNull, sql } from "drizzle-orm";

import { getMainOrm } from "@/src/server/db/sqlite";
import { apiKeys } from "@/src/server/db/schema";
import type { ApiKeyRecord, PublicApiKey } from "@/src/shared/types/entities";
import { jsonStringify, safeJsonParse } from "@/src/server/services/crypto";

type ApiKeyRow = typeof apiKeys.$inferSelect;

export interface UpsertApiKeyInput {
  id: string;
  tenantId?: string | null;
  name: string;
  keyHash: string;
  prefix: string;
  scopes: string[];
  modelAllowlist: string[];
  channelAllowlist: string[];
  enabled: boolean;
  tokenLimitDaily: number | null;
  rateLimitPerMinute: number | null;
  expiresAt: string | null;
}

export function listApiKeys(input: { tenantId?: string | null } = {}): ApiKeyRecord[] {
  const where =
    input.tenantId === undefined
      ? undefined
      : input.tenantId === null
        ? isNull(apiKeys.tenantId)
        : eq(apiKeys.tenantId, input.tenantId);
  const query = getMainOrm()
    .select()
    .from(apiKeys)
    .orderBy(sql`${apiKeys.createdAt} DESC`);
  const rows = where ? query.where(where).all() : query.all();
  return rows.map((row: ApiKeyRow) => toApiKeyRecord(row));
}

export function listPublicApiKeys(
  input: { tenantId?: string | null } = {},
): PublicApiKey[] {
  return listApiKeys(input).map(toPublicApiKey);
}

export function getApiKeyById(id: string): ApiKeyRecord | null {
  const row = getMainOrm()
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.id, id))
    .get();
  return row ? toApiKeyRecord(row) : null;
}

export function getApiKeyByHash(keyHash: string) {
  const row = getMainOrm()
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .get();
  return row ? toApiKeyRecord(row) : null;
}

export function insertApiKey(input: UpsertApiKeyInput) {
  const now = new Date().toISOString();
  getMainOrm()
    .insert(apiKeys)
    .values({
      id: input.id,
      tenantId: input.tenantId ?? null,
      name: input.name,
      keyHash: input.keyHash,
      prefix: input.prefix,
      scopesJson: jsonStringify(input.scopes),
      modelAllowlistJson: jsonStringify(input.modelAllowlist),
      channelAllowlistJson: jsonStringify(input.channelAllowlist),
      enabled: input.enabled ? 1 : 0,
      tokenLimitDaily: input.tokenLimitDaily,
      rateLimitPerMinute: input.rateLimitPerMinute,
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return getApiKeyById(input.id);
}

export function updateApiKey(
  id: string,
  patch: Partial<
    Pick<
      ApiKeyRecord,
      | "name"
      | "scopes"
      | "modelAllowlist"
      | "channelAllowlist"
      | "enabled"
      | "tokenLimitDaily"
      | "rateLimitPerMinute"
      | "expiresAt"
    >
  >,
) {
  const existing = getApiKeyById(id);
  if (!existing) {
    return null;
  }
  const next = { ...existing, ...patch };
  getMainOrm()
    .update(apiKeys)
    .set({
      name: next.name,
      scopesJson: jsonStringify(next.scopes),
      modelAllowlistJson: jsonStringify(next.modelAllowlist),
      channelAllowlistJson: jsonStringify(next.channelAllowlist),
      enabled: next.enabled ? 1 : 0,
      tokenLimitDaily: next.tokenLimitDaily,
      rateLimitPerMinute: next.rateLimitPerMinute,
      expiresAt: next.expiresAt,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(apiKeys.id, id))
    .run();
  return getApiKeyById(id);
}

export function transferApiKeyTenant(id: string, tenantId: string) {
  const existing = getApiKeyById(id);
  if (!existing) {
    return null;
  }
  getMainOrm()
    .update(apiKeys)
    .set({
      tenantId,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(apiKeys.id, id))
    .run();
  return getApiKeyById(id);
}

export function countApiKeysByTenant(tenantId: string) {
  const row = getMainOrm()
    .select({
      total: count(),
      enabled: sql<number>`SUM(CASE WHEN ${apiKeys.enabled} = 1 THEN 1 ELSE 0 END)`,
    })
    .from(apiKeys)
    .where(eq(apiKeys.tenantId, tenantId))
    .get();
  return {
    total: Number(row?.total || 0),
    enabled: Number(row?.enabled || 0),
  };
}

export function markApiKeyUsed(id: string) {
  const now = new Date().toISOString();
  getMainOrm()
    .update(apiKeys)
    .set({ lastUsedAt: now, updatedAt: now })
    .where(eq(apiKeys.id, id))
    .run();
}

export function deleteApiKey(id: string) {
  const existing = getApiKeyById(id);
  if (!existing) {
    return false;
  }
  getMainOrm()
    .delete(apiKeys)
    .where(eq(apiKeys.id, id))
    .run();
  return true;
}

export function toPublicApiKey(record: ApiKeyRecord): PublicApiKey {
  return {
    id: record.id,
    tenantId: record.tenantId,
    name: record.name,
    prefix: record.prefix,
    scopes: record.scopes,
    modelAllowlist: record.modelAllowlist,
    channelAllowlist: record.channelAllowlist,
    enabled: record.enabled,
    tokenLimitDaily: record.tokenLimitDaily,
    rateLimitPerMinute: record.rateLimitPerMinute,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastUsedAt: record.lastUsedAt,
  };
}

function toApiKeyRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    prefix: row.prefix,
    keyHash: row.keyHash,
    scopes: safeJsonParse<string[]>(row.scopesJson, []),
    modelAllowlist: safeJsonParse<string[]>(row.modelAllowlistJson, []),
    channelAllowlist: safeJsonParse<string[]>(row.channelAllowlistJson, []),
    enabled: row.enabled === 1,
    tokenLimitDaily: row.tokenLimitDaily,
    rateLimitPerMinute: row.rateLimitPerMinute,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt,
  };
}

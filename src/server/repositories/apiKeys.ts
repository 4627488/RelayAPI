import "server-only";

import { getMainDb } from "@/src/server/db/sqlite";
import type { ApiKeyRecord, PublicApiKey } from "@/src/shared/types/entities";
import { jsonStringify, safeJsonParse } from "@/src/server/services/crypto";

type ApiKeyRow = {
  id: string;
  tenant_id: string | null;
  name: string;
  key_hash: string;
  prefix: string;
  scopes_json: string;
  model_allowlist_json: string;
  channel_allowlist_json: string;
  enabled: number;
  token_limit_daily: number | null;
  rate_limit_per_minute: number | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
};

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
      ? ""
      : input.tenantId === null
        ? "WHERE tenant_id IS NULL"
        : "WHERE tenant_id = ?";
  const statement = getMainDb().prepare(
    `SELECT * FROM api_keys ${where} ORDER BY created_at DESC`,
  );
  const rows =
    input.tenantId === undefined || input.tenantId === null
      ? (statement.all() as ApiKeyRow[])
      : (statement.all(input.tenantId) as ApiKeyRow[]);
  return rows.map((row: ApiKeyRow) => toApiKeyRecord(row));
}

export function listPublicApiKeys(
  input: { tenantId?: string | null } = {},
): PublicApiKey[] {
  return listApiKeys(input).map(toPublicApiKey);
}

export function getApiKeyById(id: string): ApiKeyRecord | null {
  const row = getMainDb()
    .prepare("SELECT * FROM api_keys WHERE id = ?")
    .get(id) as ApiKeyRow | undefined;
  return row ? toApiKeyRecord(row) : null;
}

export function getApiKeyByHash(keyHash: string) {
  const row = getMainDb()
    .prepare("SELECT * FROM api_keys WHERE key_hash = ?")
    .get(keyHash) as ApiKeyRow | undefined;
  return row ? toApiKeyRecord(row) : null;
}

export function insertApiKey(input: UpsertApiKeyInput) {
  const now = new Date().toISOString();
  getMainDb()
    .prepare(
      `INSERT INTO api_keys (
        id, tenant_id, name, key_hash, prefix, scopes_json, model_allowlist_json,
        channel_allowlist_json, enabled, token_limit_daily,
        rate_limit_per_minute, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.tenantId ?? null,
      input.name,
      input.keyHash,
      input.prefix,
      jsonStringify(input.scopes),
      jsonStringify(input.modelAllowlist),
      jsonStringify(input.channelAllowlist),
      input.enabled ? 1 : 0,
      input.tokenLimitDaily,
      input.rateLimitPerMinute,
      input.expiresAt,
      now,
      now,
    );
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
  getMainDb()
    .prepare(
      `UPDATE api_keys SET
        name = ?, scopes_json = ?, model_allowlist_json = ?,
        channel_allowlist_json = ?, enabled = ?, token_limit_daily = ?,
        rate_limit_per_minute = ?, expires_at = ?, updated_at = ?
      WHERE id = ?`,
    )
    .run(
      next.name,
      jsonStringify(next.scopes),
      jsonStringify(next.modelAllowlist),
      jsonStringify(next.channelAllowlist),
      next.enabled ? 1 : 0,
      next.tokenLimitDaily,
      next.rateLimitPerMinute,
      next.expiresAt,
      new Date().toISOString(),
      id,
    );
  return getApiKeyById(id);
}

export function countApiKeysByTenant(tenantId: string) {
  const row = getMainDb()
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled
       FROM api_keys
       WHERE tenant_id = ?`,
    )
    .get(tenantId) as { total: number; enabled: number | null } | undefined;
  return {
    total: Number(row?.total || 0),
    enabled: Number(row?.enabled || 0),
  };
}

export function markApiKeyUsed(id: string) {
  getMainDb()
    .prepare(
      "UPDATE api_keys SET last_used_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(new Date().toISOString(), new Date().toISOString(), id);
}

export function deleteApiKey(id: string) {
  const result = getMainDb()
    .prepare("DELETE FROM api_keys WHERE id = ?")
    .run(id);
  return result.changes > 0;
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
    tenantId: row.tenant_id,
    name: row.name,
    prefix: row.prefix,
    keyHash: row.key_hash,
    scopes: safeJsonParse<string[]>(row.scopes_json, []),
    modelAllowlist: safeJsonParse<string[]>(row.model_allowlist_json, []),
    channelAllowlist: safeJsonParse<string[]>(row.channel_allowlist_json, []),
    enabled: row.enabled === 1,
    tokenLimitDaily: row.token_limit_daily,
    rateLimitPerMinute: row.rate_limit_per_minute,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

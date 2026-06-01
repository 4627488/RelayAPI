import "server-only";

import { getMainDb } from "@/src/server/db/sqlite";
import type {
  CredentialProxyConfig,
  PublicCredentialProxyConfig,
  TenantInviteRecord,
  TenantUserRecord,
  TenantWithSecrets,
} from "@/src/shared/types/entities";
import {
  decryptJson,
  encryptJson,
  jsonStringify,
  safeJsonParse,
} from "@/src/server/services/crypto";

type TenantRow = {
  id: string;
  name: string;
  owner_email: string;
  enabled: number;
  max_api_keys: number | null;
  token_limit_daily: number | null;
  rate_limit_per_minute: number | null;
  model_allowlist_json: string;
  channel_allowlist_json: string;
  allow_custom_proxy: number;
  allow_custom_user_agent: number;
  proxy_envelope: string | null;
  user_agent: string | null;
  expires_at: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type TenantUserRow = {
  id: string;
  tenant_id: string;
  email: string;
  display_name: string;
  role: string;
  enabled: number;
  password_hash: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
};

type TenantInviteRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  email: string;
  token_hash: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

export interface SaveTenantInput {
  id: string;
  name: string;
  ownerEmail: string;
  enabled: boolean;
  maxApiKeys: number | null;
  tokenLimitDaily: number | null;
  rateLimitPerMinute: number | null;
  modelAllowlist: string[];
  channelAllowlist: string[];
  allowCustomProxy: boolean;
  allowCustomUserAgent: boolean;
  proxy?: CredentialProxyConfig | null;
  userAgent: string | null;
  expiresAt: string | null;
  metadata?: Record<string, unknown>;
}

export interface UpdateTenantInput
  extends Partial<Omit<SaveTenantInput, "id" | "proxy">> {
  proxy?: CredentialProxyConfig | null;
  deletedAt?: string | null;
}

export function listTenants(): TenantWithSecrets[] {
  const rows = getMainDb()
    .prepare(
      "SELECT * FROM tenants WHERE deleted_at IS NULL ORDER BY created_at DESC",
    )
    .all() as TenantRow[];
  return rows.map(toTenantRecord);
}

export function getTenantById(id: string): TenantWithSecrets | null {
  const row = getMainDb()
    .prepare("SELECT * FROM tenants WHERE id = ? AND deleted_at IS NULL")
    .get(id) as TenantRow | undefined;
  return row ? toTenantRecord(row) : null;
}

export function insertTenant(input: SaveTenantInput) {
  const now = new Date().toISOString();
  getMainDb()
    .prepare(
      `INSERT INTO tenants (
        id, name, owner_email, enabled, max_api_keys, token_limit_daily,
        rate_limit_per_minute, model_allowlist_json, channel_allowlist_json,
        allow_custom_proxy, allow_custom_user_agent, proxy_envelope,
        user_agent, expires_at, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.name,
      input.ownerEmail,
      input.enabled ? 1 : 0,
      input.maxApiKeys,
      input.tokenLimitDaily,
      input.rateLimitPerMinute,
      jsonStringify(input.modelAllowlist),
      jsonStringify(input.channelAllowlist),
      input.allowCustomProxy ? 1 : 0,
      input.allowCustomUserAgent ? 1 : 0,
      input.proxy ? encryptJson(input.proxy) : null,
      input.userAgent,
      input.expiresAt,
      jsonStringify(input.metadata || {}),
      now,
      now,
    );
  return getTenantById(input.id);
}

export function updateTenant(id: string, patch: UpdateTenantInput) {
  const existing = getTenantById(id);
  if (!existing) {
    return null;
  }
  const next = {
    ...existing,
    ...patch,
    proxy: patch.proxy === undefined ? existing.proxy : patch.proxy,
    metadata: {
      ...existing.metadata,
      ...(patch.metadata || {}),
    },
  };
  getMainDb()
    .prepare(
      `UPDATE tenants SET
        name = ?, owner_email = ?, enabled = ?, max_api_keys = ?,
        token_limit_daily = ?, rate_limit_per_minute = ?,
        model_allowlist_json = ?, channel_allowlist_json = ?,
        allow_custom_proxy = ?, allow_custom_user_agent = ?,
        proxy_envelope = ?, user_agent = ?, expires_at = ?,
        metadata_json = ?, deleted_at = ?, updated_at = ?
      WHERE id = ?`,
    )
    .run(
      next.name,
      next.ownerEmail,
      next.enabled ? 1 : 0,
      next.maxApiKeys,
      next.tokenLimitDaily,
      next.rateLimitPerMinute,
      jsonStringify(next.modelAllowlist),
      jsonStringify(next.channelAllowlist),
      next.allowCustomProxy ? 1 : 0,
      next.allowCustomUserAgent ? 1 : 0,
      next.proxy ? encryptJson(next.proxy) : null,
      next.userAgent,
      next.expiresAt,
      jsonStringify(next.metadata),
      patch.deletedAt === undefined ? existing.deletedAt : patch.deletedAt,
      new Date().toISOString(),
      id,
    );
  return getTenantById(id);
}

export function insertTenantUser(input: {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  enabled?: boolean;
  passwordHash?: string | null;
}) {
  const now = new Date().toISOString();
  getMainDb()
    .prepare(
      `INSERT INTO tenant_users (
        id, tenant_id, email, display_name, role, enabled, password_hash,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'owner', ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.tenantId,
      input.email,
      input.displayName,
      input.enabled === false ? 0 : 1,
      input.passwordHash || null,
      now,
      now,
    );
  return getTenantUserById(input.id);
}

export function getTenantUserById(id: string): TenantUserRecord | null {
  const row = getMainDb()
    .prepare("SELECT * FROM tenant_users WHERE id = ?")
    .get(id) as TenantUserRow | undefined;
  return row ? toTenantUserRecord(row) : null;
}

export function getTenantUserByEmail(email: string): TenantUserRecord | null {
  const row = getMainDb()
    .prepare("SELECT * FROM tenant_users WHERE lower(email) = lower(?)")
    .get(email) as TenantUserRow | undefined;
  return row ? toTenantUserRecord(row) : null;
}

export function getTenantOwnerUser(tenantId: string): TenantUserRecord | null {
  const row = getMainDb()
    .prepare(
      `SELECT * FROM tenant_users
       WHERE tenant_id = ? AND role = 'owner'
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get(tenantId) as TenantUserRow | undefined;
  return row ? toTenantUserRecord(row) : null;
}

export function updateTenantUser(
  id: string,
  patch: Partial<
    Pick<
      TenantUserRecord,
      "displayName" | "enabled" | "passwordHash" | "lastLoginAt"
    >
  >,
) {
  const existing = getTenantUserById(id);
  if (!existing) {
    return null;
  }
  const next = { ...existing, ...patch };
  getMainDb()
    .prepare(
      `UPDATE tenant_users SET
        display_name = ?, enabled = ?, password_hash = ?,
        last_login_at = ?, updated_at = ?
      WHERE id = ?`,
    )
    .run(
      next.displayName,
      next.enabled ? 1 : 0,
      next.passwordHash,
      next.lastLoginAt,
      new Date().toISOString(),
      id,
    );
  return getTenantUserById(id);
}

export function insertTenantInvite(input: {
  id: string;
  tenantId: string;
  userId: string;
  email: string;
  tokenHash: string;
  expiresAt: string;
}) {
  const now = new Date().toISOString();
  getMainDb()
    .prepare(
      `INSERT INTO tenant_invites (
        id, tenant_id, user_id, email, token_hash, expires_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.tenantId,
      input.userId,
      input.email,
      input.tokenHash,
      input.expiresAt,
      now,
      now,
    );
  return getTenantInviteById(input.id);
}

export function getTenantInviteById(id: string): TenantInviteRecord | null {
  const row = getMainDb()
    .prepare("SELECT * FROM tenant_invites WHERE id = ?")
    .get(id) as TenantInviteRow | undefined;
  return row ? toTenantInviteRecord(row) : null;
}

export function getTenantInviteByTokenHash(
  tokenHash: string,
): TenantInviteRecord | null {
  const row = getMainDb()
    .prepare("SELECT * FROM tenant_invites WHERE token_hash = ?")
    .get(tokenHash) as TenantInviteRow | undefined;
  return row ? toTenantInviteRecord(row) : null;
}

export function revokeOpenTenantInvites(tenantId: string) {
  const now = new Date().toISOString();
  getMainDb()
    .prepare(
      `UPDATE tenant_invites
       SET revoked_at = ?, updated_at = ?
       WHERE tenant_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
    )
    .run(now, now, tenantId);
}

export function markTenantInviteAccepted(id: string) {
  const now = new Date().toISOString();
  getMainDb()
    .prepare(
      `UPDATE tenant_invites
       SET accepted_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(now, now, id);
  return getTenantInviteById(id);
}

export function publicProxy(
  proxy: CredentialProxyConfig | null,
): PublicCredentialProxyConfig | null {
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

function toTenantRecord(row: TenantRow): TenantWithSecrets {
  return {
    id: row.id,
    name: row.name,
    ownerEmail: row.owner_email,
    enabled: row.enabled === 1,
    maxApiKeys: row.max_api_keys,
    tokenLimitDaily: row.token_limit_daily,
    rateLimitPerMinute: row.rate_limit_per_minute,
    modelAllowlist: safeJsonParse<string[]>(row.model_allowlist_json, []),
    channelAllowlist: safeJsonParse<string[]>(row.channel_allowlist_json, []),
    allowCustomProxy: row.allow_custom_proxy === 1,
    allowCustomUserAgent: row.allow_custom_user_agent === 1,
    proxy: proxyFromEnvelope(row.proxy_envelope),
    userAgent: row.user_agent,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    metadata: safeJsonParse<Record<string, unknown>>(row.metadata_json, {}),
  };
}

function toTenantUserRecord(row: TenantUserRow): TenantUserRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    displayName: row.display_name,
    role: "owner",
    enabled: row.enabled === 1,
    passwordHash: row.password_hash,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTenantInviteRecord(row: TenantInviteRow): TenantInviteRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    email: row.email,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function proxyFromEnvelope(envelope: string | null) {
  if (!envelope) {
    return null;
  }
  try {
    return decryptJson<CredentialProxyConfig>(envelope);
  } catch {
    return null;
  }
}

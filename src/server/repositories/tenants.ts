import "server-only";

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import { getMainOrm } from "@/src/server/db/sqlite";
import {
  tenantInvites,
  tenants,
  tenantUsers,
} from "@/src/server/db/schema";
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

type TenantRow = typeof tenants.$inferSelect;
type TenantUserRow = typeof tenantUsers.$inferSelect;
type TenantInviteRow = typeof tenantInvites.$inferSelect;

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
  const rows = getMainOrm()
    .select()
    .from(tenants)
    .where(isNull(tenants.deletedAt))
    .orderBy(desc(tenants.createdAt))
    .all();
  return rows.map(toTenantRecord);
}

export function getTenantById(id: string): TenantWithSecrets | null {
  const row = getMainOrm()
    .select()
    .from(tenants)
    .where(and(eq(tenants.id, id), isNull(tenants.deletedAt)))
    .get();
  return row ? toTenantRecord(row) : null;
}

export function insertTenant(input: SaveTenantInput) {
  const now = new Date().toISOString();
  getMainOrm()
    .insert(tenants)
    .values({
      id: input.id,
      name: input.name,
      ownerEmail: input.ownerEmail,
      enabled: input.enabled ? 1 : 0,
      maxApiKeys: input.maxApiKeys,
      tokenLimitDaily: input.tokenLimitDaily,
      rateLimitPerMinute: input.rateLimitPerMinute,
      modelAllowlistJson: jsonStringify(input.modelAllowlist),
      channelAllowlistJson: jsonStringify(input.channelAllowlist),
      allowCustomProxy: input.allowCustomProxy ? 1 : 0,
      allowCustomUserAgent: input.allowCustomUserAgent ? 1 : 0,
      proxyEnvelope: input.proxy ? encryptJson(input.proxy) : null,
      userAgent: input.userAgent,
      expiresAt: input.expiresAt,
      metadataJson: jsonStringify(input.metadata || {}),
      createdAt: now,
      updatedAt: now,
    })
    .run();
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
  getMainOrm()
    .update(tenants)
    .set({
      name: next.name,
      ownerEmail: next.ownerEmail,
      enabled: next.enabled ? 1 : 0,
      maxApiKeys: next.maxApiKeys,
      tokenLimitDaily: next.tokenLimitDaily,
      rateLimitPerMinute: next.rateLimitPerMinute,
      modelAllowlistJson: jsonStringify(next.modelAllowlist),
      channelAllowlistJson: jsonStringify(next.channelAllowlist),
      allowCustomProxy: next.allowCustomProxy ? 1 : 0,
      allowCustomUserAgent: next.allowCustomUserAgent ? 1 : 0,
      proxyEnvelope: next.proxy ? encryptJson(next.proxy) : null,
      userAgent: next.userAgent,
      expiresAt: next.expiresAt,
      metadataJson: jsonStringify(next.metadata),
      deletedAt: patch.deletedAt === undefined ? existing.deletedAt : patch.deletedAt,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(tenants.id, id))
    .run();
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
  getMainOrm()
    .insert(tenantUsers)
    .values({
      id: input.id,
      tenantId: input.tenantId,
      email: input.email,
      displayName: input.displayName,
      role: "owner",
      enabled: input.enabled === false ? 0 : 1,
      passwordHash: input.passwordHash || null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return getTenantUserById(input.id);
}

export function getTenantUserById(id: string): TenantUserRecord | null {
  const row = getMainOrm()
    .select()
    .from(tenantUsers)
    .where(eq(tenantUsers.id, id))
    .get();
  return row ? toTenantUserRecord(row) : null;
}

export function getTenantUserByEmail(email: string): TenantUserRecord | null {
  const row = getMainOrm()
    .select()
    .from(tenantUsers)
    .where(sql`lower(${tenantUsers.email}) = lower(${email})`)
    .get();
  return row ? toTenantUserRecord(row) : null;
}

export function getTenantOwnerUser(tenantId: string): TenantUserRecord | null {
  const row = getMainOrm()
    .select()
    .from(tenantUsers)
    .where(and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.role, "owner")))
    .orderBy(asc(tenantUsers.createdAt))
    .limit(1)
    .get();
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
  getMainOrm()
    .update(tenantUsers)
    .set({
      displayName: next.displayName,
      enabled: next.enabled ? 1 : 0,
      passwordHash: next.passwordHash,
      lastLoginAt: next.lastLoginAt,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(tenantUsers.id, id))
    .run();
  return getTenantUserById(id);
}

export function insertTenantInvite(input: {
  id: string;
  tenantId: string;
  userId?: string | null;
  email?: string;
  tokenHash: string;
  expiresAt: string;
}) {
  const now = new Date().toISOString();
  getMainOrm()
    .insert(tenantInvites)
    .values({
      id: input.id,
      tenantId: input.tenantId,
      userId: input.userId || null,
      email: input.email || "",
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return getTenantInviteById(input.id);
}

export function getTenantInviteById(id: string): TenantInviteRecord | null {
  const row = getMainOrm()
    .select()
    .from(tenantInvites)
    .where(eq(tenantInvites.id, id))
    .get();
  return row ? toTenantInviteRecord(row) : null;
}

export function getTenantInviteByTokenHash(
  tokenHash: string,
): TenantInviteRecord | null {
  const row = getMainOrm()
    .select()
    .from(tenantInvites)
    .where(eq(tenantInvites.tokenHash, tokenHash))
    .get();
  return row ? toTenantInviteRecord(row) : null;
}

export function getLatestTenantInvite(
  tenantId: string,
): TenantInviteRecord | null {
  const row = getMainOrm()
    .select()
    .from(tenantInvites)
    .where(eq(tenantInvites.tenantId, tenantId))
    .orderBy(desc(tenantInvites.createdAt))
    .limit(1)
    .get();
  return row ? toTenantInviteRecord(row) : null;
}

export function getPendingTenantInvite(
  tenantId: string,
): TenantInviteRecord | null {
  const row = getMainOrm()
    .select()
    .from(tenantInvites)
    .where(
      and(
        eq(tenantInvites.tenantId, tenantId),
        isNull(tenantInvites.acceptedAt),
        isNull(tenantInvites.revokedAt),
      ),
    )
    .orderBy(desc(tenantInvites.createdAt))
    .limit(1)
    .get();
  return row ? toTenantInviteRecord(row) : null;
}

export function revokeOpenTenantInvites(tenantId: string) {
  const now = new Date().toISOString();
  getMainOrm()
    .update(tenantInvites)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(tenantInvites.tenantId, tenantId),
        isNull(tenantInvites.acceptedAt),
        isNull(tenantInvites.revokedAt),
      ),
    )
    .run();
}

export function markTenantInviteAccepted(
  id: string,
  patch: { userId?: string | null; email?: string } = {},
) {
  const now = new Date().toISOString();
  getMainOrm()
    .update(tenantInvites)
    .set({
      ...(patch.userId !== undefined ? { userId: patch.userId } : {}),
      ...(patch.email !== undefined ? { email: patch.email } : {}),
      acceptedAt: now,
      updatedAt: now,
    })
    .where(eq(tenantInvites.id, id))
    .run();
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
    ownerEmail: row.ownerEmail,
    enabled: row.enabled === 1,
    maxApiKeys: row.maxApiKeys,
    tokenLimitDaily: row.tokenLimitDaily,
    rateLimitPerMinute: row.rateLimitPerMinute,
    modelAllowlist: safeJsonParse<string[]>(row.modelAllowlistJson, []),
    channelAllowlist: safeJsonParse<string[]>(row.channelAllowlistJson, []),
    allowCustomProxy: row.allowCustomProxy === 1,
    allowCustomUserAgent: row.allowCustomUserAgent === 1,
    proxy: proxyFromEnvelope(row.proxyEnvelope),
    userAgent: row.userAgent,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    metadata: safeJsonParse<Record<string, unknown>>(row.metadataJson, {}),
  };
}

function toTenantUserRecord(row: TenantUserRow): TenantUserRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    email: row.email,
    displayName: row.displayName,
    role: "owner",
    enabled: row.enabled === 1,
    passwordHash: row.passwordHash,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toTenantInviteRecord(row: TenantInviteRow): TenantInviteRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    email: row.email,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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

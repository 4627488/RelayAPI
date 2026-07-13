import "server-only";

import type {
  ApiKeyRecord,
  CreatedApiKey,
  PublicApiKey,
  PublicTenant,
  RelayApiKeyContext,
  TenantWithSecrets,
} from "@/src/shared/types/entities";
import { getLogOrm, getMainOrm } from "@/src/server/db/sqlite";
import {
  countApiKeysByTenant,
  deleteApiKey,
  getApiKeyByHash,
  getApiKeyById,
  insertApiKey,
  listPublicApiKeys,
  markApiKeyUsed,
  toPublicApiKey,
  transferApiKeyTenant,
  updateApiKey,
} from "@/src/server/repositories/apiKeys";
import { getTenantById, getTenantUserById } from "@/src/server/repositories/tenants";
import {
  appendAuditLog,
  getApiKeyDailyUsage,
  getApiKeyRequestCountSince,
  getTenantDailyUsage,
  getTenantRequestCountSince,
  transferApiKeyLogScope,
} from "@/src/server/repositories/logs";
import { toPublicTenant } from "@/src/server/services/tenants";
import { base64Url, randomId, sha256 } from "@/src/server/services/crypto";
import { HttpError } from "@/src/server/http/errors";

const RATE_LIMIT_WINDOW_MS = 60_000;
const inFlightRateLimitBuckets = new Map<string, number[]>();

export interface CreateApiKeyInput {
  name?: string;
  scopes?: string[];
  modelAllowlist?: string[];
  channelAllowlist?: string[];
  enabled?: boolean;
  tokenLimitDaily?: number | null;
  rateLimitPerMinute?: number | null;
  expiresAt?: string | null;
}

export interface ApiKeyTransferResult {
  apiKey: PublicApiKey;
  tenant: PublicTenant;
  migrated: {
    requestLogs: number;
    usageRecords: number;
    usageDailyBuckets: number;
  };
}

export function createApiKey(input: CreateApiKeyInput = {}): CreatedApiKey {
  return createApiKeyRecord(input, null);
}

export function createTenantApiKey(
  tenant: TenantWithSecrets,
  input: CreateApiKeyInput = {},
): CreatedApiKey {
  assertTenantCanCreateApiKey(tenant, input);
  return createApiKeyRecord(input, tenant.id);
}

function createApiKeyRecord(
  input: CreateApiKeyInput,
  tenantId: string | null,
): CreatedApiKey {
  const key = `relay_sk_${base64Url(32)}`;
  const record = insertApiKey({
    id: randomId("key"),
    tenantId,
    name: cleanString(input.name) || "Relay API Key",
    keyHash: hashApiKey(key),
    prefix: key.slice(0, 18),
    scopes: cleanStringArray(input.scopes, ["relay"]),
    modelAllowlist: cleanStringArray(input.modelAllowlist, []),
    channelAllowlist: cleanStringArray(input.channelAllowlist, []),
    enabled: input.enabled ?? true,
    tokenLimitDaily: normalizeNullablePositiveInteger(input.tokenLimitDaily),
    rateLimitPerMinute: normalizeNullablePositiveInteger(
      input.rateLimitPerMinute,
    ),
    expiresAt: cleanString(input.expiresAt) || null,
  });
  if (!record) {
    throw new Error("Failed to create API key");
  }
  return { ...toPublicApiKey(record), key };
}

export function listApiKeyPublicRecords(): PublicApiKey[] {
  return listPublicApiKeys({ tenantId: null });
}

export function listTenantApiKeyPublicRecords(
  tenantId: string,
): PublicApiKey[] {
  return listPublicApiKeys({ tenantId });
}

export function patchApiKey(id: string, input: Partial<CreateApiKeyInput>) {
  const existing = getApiKeyById(id);
  if (!existing || existing.tenantId !== null) {
    throw new HttpError(404, "api_key_not_found", "API key not found");
  }
  const record = updateApiKey(id, {
    ...(input.name !== undefined ? { name: cleanString(input.name) } : {}),
    ...(input.scopes !== undefined
      ? { scopes: cleanStringArray(input.scopes, []) }
      : {}),
    ...(input.modelAllowlist !== undefined
      ? { modelAllowlist: cleanStringArray(input.modelAllowlist, []) }
      : {}),
    ...(input.channelAllowlist !== undefined
      ? { channelAllowlist: cleanStringArray(input.channelAllowlist, []) }
      : {}),
    ...(input.enabled !== undefined ? { enabled: Boolean(input.enabled) } : {}),
    ...(input.tokenLimitDaily !== undefined
      ? {
          tokenLimitDaily: normalizeNullablePositiveInteger(
            input.tokenLimitDaily,
          ),
        }
      : {}),
    ...(input.rateLimitPerMinute !== undefined
      ? {
          rateLimitPerMinute: normalizeNullablePositiveInteger(
            input.rateLimitPerMinute,
          ),
        }
      : {}),
    ...(input.expiresAt !== undefined
      ? { expiresAt: cleanString(input.expiresAt) || null }
      : {}),
  });
  if (!record) {
    throw new HttpError(404, "api_key_not_found", "API key not found");
  }
  return toPublicApiKey(record);
}

export function transferAdminApiKeyToTenant(
  id: string,
  input: { tenantId?: unknown },
): ApiKeyTransferResult {
  const tenantId = cleanString(input.tenantId);
  if (!tenantId) {
    throw new HttpError(
      400,
      "invalid_target_tenant",
      "Target tenant is required",
    );
  }
  const existing = getApiKeyById(id);
  if (!existing || existing.tenantId !== null) {
    throw new HttpError(404, "api_key_not_found", "API key not found");
  }
  const tenant = getTenantById(tenantId);
  if (!tenant) {
    throw new HttpError(404, "tenant_not_found", "Tenant not found");
  }

  return getMainOrm().transaction(() =>
    getLogOrm().transaction(() => {
    const record = transferApiKeyTenant(id, tenant.id);
    if (!record) {
      throw new HttpError(404, "api_key_not_found", "API key not found");
    }
    const migrated = transferApiKeyLogScope({
      apiKeyId: id,
      tenantId: tenant.id,
      tenantName: tenant.name,
    });
    appendAuditLog({
      action: "api_key.transfer_to_tenant",
      actorType: "web_admin",
      targetType: "api_key",
      targetId: id,
      detail: {
        apiKeyName: existing.name,
        apiKeyPrefix: existing.prefix,
        fromTenantId: existing.tenantId,
        toTenantId: tenant.id,
        toTenantName: tenant.name,
        migrated,
      },
    });
    return {
      apiKey: toPublicApiKey(record),
      tenant: toPublicTenant(tenant),
      migrated,
    };
    }),
  );
}

export function patchTenantApiKey(
  tenant: TenantWithSecrets,
  id: string,
  input: Partial<CreateApiKeyInput>,
) {
  const existing = getApiKeyById(id);
  if (!existing || existing.tenantId !== tenant.id) {
    throw new HttpError(404, "api_key_not_found", "API key not found");
  }
  assertTenantCanPatchApiKey(tenant, existing, input);
  const record = updateApiKey(id, {
    ...(input.name !== undefined ? { name: cleanString(input.name) } : {}),
    ...(input.scopes !== undefined
      ? { scopes: cleanStringArray(input.scopes, []) }
      : {}),
    ...(input.modelAllowlist !== undefined
      ? { modelAllowlist: cleanStringArray(input.modelAllowlist, []) }
      : {}),
    ...(input.channelAllowlist !== undefined
      ? { channelAllowlist: cleanStringArray(input.channelAllowlist, []) }
      : {}),
    ...(input.enabled !== undefined ? { enabled: Boolean(input.enabled) } : {}),
    ...(input.tokenLimitDaily !== undefined
      ? {
          tokenLimitDaily: normalizeNullablePositiveInteger(
            input.tokenLimitDaily,
          ),
        }
      : {}),
    ...(input.rateLimitPerMinute !== undefined
      ? {
          rateLimitPerMinute: normalizeNullablePositiveInteger(
            input.rateLimitPerMinute,
          ),
        }
      : {}),
    ...(input.expiresAt !== undefined
      ? { expiresAt: cleanString(input.expiresAt) || null }
      : {}),
  });
  if (!record) {
    throw new HttpError(404, "api_key_not_found", "API key not found");
  }
  return toPublicApiKey(record);
}

export function removeApiKey(id: string) {
  const existing = getApiKeyById(id);
  if (!existing || existing.tenantId !== null) {
    throw new HttpError(404, "api_key_not_found", "API key not found");
  }
  if (!deleteApiKey(id)) {
    throw new HttpError(404, "api_key_not_found", "API key not found");
  }
}

export function removeTenantApiKey(tenantId: string, id: string) {
  const existing = getApiKeyById(id);
  if (!existing || existing.tenantId !== tenantId) {
    throw new HttpError(404, "api_key_not_found", "API key not found");
  }
  if (!deleteApiKey(id)) {
    throw new HttpError(404, "api_key_not_found", "API key not found");
  }
}

export function authenticateRelayRequest(request: Request): RelayApiKeyContext {
  const key = extractApiKey(request);
  if (!key) {
    throw new HttpError(401, "missing_api_key", "Missing bearer API key");
  }
  const record = getApiKeyByHash(hashApiKey(key));
  if (!record) {
    throw new HttpError(401, "invalid_api_key", "Invalid API key");
  }
  if (!record.enabled) {
    throw new HttpError(403, "api_key_disabled", "API key is disabled");
  }
  if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
    throw new HttpError(403, "api_key_expired", "API key is expired");
  }
  let tenant: TenantWithSecrets | null = null;
  let tenantUserId: string | null = null;
  if (record.tenantId) {
    tenant = getTenantById(record.tenantId);
    assertTenantUsable(tenant);
  }
  const libreChatUserId = cleanString(
    request.headers.get("x-librechat-openid-id"),
  );
  if (libreChatUserId) {
    if (record.tenantId || !record.scopes.includes("librechat:identity")) {
      throw new HttpError(
        403,
        "librechat_identity_not_allowed",
        "This API key cannot select a LibreChat user identity",
      );
    }
    const user = getTenantUserById(libreChatUserId);
    if (!user || !user.enabled) {
      throw new HttpError(
        403,
        "librechat_user_not_available",
        "LibreChat user is not available",
      );
    }
    tenant = getTenantById(user.tenantId);
    assertTenantUsable(tenant);
    tenantUserId = user.id;
  }
  if (
    record.tokenLimitDaily !== null &&
    getApiKeyDailyUsage(record.id) >= record.tokenLimitDaily
  ) {
    throw new HttpError(
      429,
      "daily_token_limit_exceeded",
      "API key daily token limit has been reached",
    );
  }
  if (
    tenant?.tokenLimitDaily !== null &&
    tenant?.tokenLimitDaily !== undefined &&
    getTenantDailyUsage(tenant.id) >= tenant.tokenLimitDaily
  ) {
    throw new HttpError(
      429,
      "tenant_daily_token_limit_exceeded",
      "Tenant daily token limit has been reached",
    );
  }
  enforceRateLimit(`key:${record.id}`, record.rateLimitPerMinute, (since) =>
    getApiKeyRequestCountSince(record.id, since),
  );
  if (tenant) {
    enforceRateLimit(
      `tenant:${tenant.id}`,
      tenant.rateLimitPerMinute,
      (since) => getTenantRequestCountSince(tenant.id, since),
    );
  }
  markApiKeyUsed(record.id);
  return {
    id: record.id,
    tenantId: tenant?.id || null,
    tenantUserId,
    tenant: tenant
      ? {
          id: tenant.id,
          name: tenant.name,
          proxy: tenant.allowCustomProxy ? tenant.proxy : null,
          userAgent: tenant.allowCustomUserAgent ? tenant.userAgent : null,
        }
      : null,
    name: record.name,
    prefix: record.prefix,
    scopes: record.scopes,
    modelAllowlist: effectiveAllowlist(
      tenant?.modelAllowlist || [],
      record.modelAllowlist,
    ),
    channelAllowlist: effectiveAllowlist(
      tenant?.channelAllowlist || [],
      record.channelAllowlist,
    ),
    tokenLimitDaily: record.tokenLimitDaily,
    rateLimitPerMinute: record.rateLimitPerMinute,
  };
}

export function getPublicApiKeyById(id: string) {
  const record = getApiKeyById(id);
  return record ? toPublicApiKey(record) : null;
}

function extractApiKey(request: Request) {
  const authorization = request.headers.get("authorization") || "";
  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) {
    return bearerMatch[1].trim();
  }
  return (request.headers.get("x-api-key") || "").trim();
}

function hashApiKey(key: string) {
  return sha256(key.trim());
}

function enforceRateLimit(
  bucketId: string,
  limit: number | null,
  persistedCounter: (since: Date) => number,
) {
  if (!limit) {
    return;
  }
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const recentInFlight = (inFlightRateLimitBuckets.get(bucketId) || []).filter(
    (timestamp) => timestamp >= windowStart,
  );
  const persistedCount = persistedCounter(new Date(windowStart));
  if (persistedCount + recentInFlight.length >= limit) {
    inFlightRateLimitBuckets.set(bucketId, recentInFlight);
    throw new HttpError(
      429,
      "rate_limit_exceeded",
      "Rate limit has been reached",
    );
  }
  recentInFlight.push(now);
  inFlightRateLimitBuckets.set(bucketId, recentInFlight);
}

function assertTenantUsable(tenant: TenantWithSecrets | null): asserts tenant {
  if (!tenant) {
    throw new HttpError(403, "tenant_not_found", "Tenant is not available");
  }
  if (!tenant.enabled) {
    throw new HttpError(403, "tenant_disabled", "Tenant is disabled");
  }
  if (tenant.expiresAt && Date.parse(tenant.expiresAt) <= Date.now()) {
    throw new HttpError(403, "tenant_expired", "Tenant is expired");
  }
}

function assertTenantCanCreateApiKey(
  tenant: TenantWithSecrets,
  input: CreateApiKeyInput,
) {
  assertTenantUsable(tenant);
  const counts = countApiKeysByTenant(tenant.id);
  if (tenant.maxApiKeys !== null && counts.total >= tenant.maxApiKeys) {
    throw new HttpError(
      403,
      "tenant_key_limit_exceeded",
      "Tenant API key limit has been reached",
    );
  }
  assertTenantKeyPatchWithinLimits(tenant, input);
}

function assertTenantCanPatchApiKey(
  tenant: TenantWithSecrets,
  existing: ApiKeyRecord,
  input: Partial<CreateApiKeyInput>,
) {
  assertTenantUsable(tenant);
  assertTenantKeyPatchWithinLimits(tenant, {
    name: input.name ?? existing.name,
    scopes: input.scopes ?? existing.scopes,
    modelAllowlist: input.modelAllowlist ?? existing.modelAllowlist,
    channelAllowlist: input.channelAllowlist ?? existing.channelAllowlist,
    enabled: input.enabled ?? existing.enabled,
    tokenLimitDaily:
      input.tokenLimitDaily !== undefined
        ? input.tokenLimitDaily
        : existing.tokenLimitDaily,
    rateLimitPerMinute:
      input.rateLimitPerMinute !== undefined
        ? input.rateLimitPerMinute
        : existing.rateLimitPerMinute,
    expiresAt: input.expiresAt !== undefined ? input.expiresAt : existing.expiresAt,
  });
}

function assertTenantKeyPatchWithinLimits(
  tenant: TenantWithSecrets,
  input: Partial<CreateApiKeyInput>,
) {
  const modelAllowlist = cleanStringArray(input.modelAllowlist, []);
  const channelAllowlist = cleanStringArray(input.channelAllowlist, []);
  assertSubsetAllowlist(
    modelAllowlist,
    tenant.modelAllowlist,
    "tenant_model_not_allowed",
    "API key model allowlist must be within the tenant model allowlist",
  );
  assertSubsetAllowlist(
    channelAllowlist,
    tenant.channelAllowlist,
    "tenant_channel_not_allowed",
    "API key channel allowlist must be within the tenant channel allowlist",
  );
  const tokenLimitDaily = normalizeNullablePositiveInteger(
    input.tokenLimitDaily,
  );
  if (
    tokenLimitDaily !== null &&
    tenant.tokenLimitDaily !== null &&
    tokenLimitDaily > tenant.tokenLimitDaily
  ) {
    throw new HttpError(
      400,
      "tenant_token_limit_exceeded",
      "API key daily token limit cannot exceed tenant limit",
    );
  }
  const rateLimitPerMinute = normalizeNullablePositiveInteger(
    input.rateLimitPerMinute,
  );
  if (
    rateLimitPerMinute !== null &&
    tenant.rateLimitPerMinute !== null &&
    rateLimitPerMinute > tenant.rateLimitPerMinute
  ) {
    throw new HttpError(
      400,
      "tenant_rate_limit_exceeded",
      "API key rate limit cannot exceed tenant limit",
    );
  }
}

function assertSubsetAllowlist(
  requested: string[],
  allowed: string[],
  code: string,
  message: string,
) {
  if (requested.length === 0 || allowed.length === 0) {
    return;
  }
  const allowedSet = new Set(allowed);
  if (requested.some((item) => !allowedSet.has(item))) {
    throw new HttpError(400, code, message);
  }
}

function effectiveAllowlist(tenantAllowlist: string[], keyAllowlist: string[]) {
  if (tenantAllowlist.length === 0) {
    return keyAllowlist;
  }
  if (keyAllowlist.length === 0) {
    return tenantAllowlist;
  }
  const tenantSet = new Set(tenantAllowlist);
  return keyAllowlist.filter((item) => tenantSet.has(item));
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanStringArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) {
    return fallback;
  }
  return [...new Set(value.map(cleanString).filter(Boolean))];
}

function normalizeNullablePositiveInteger(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0
    ? Math.floor(numberValue)
    : null;
}


import "server-only";

import type {
  CreatedApiKey,
  PublicApiKey,
  RelayApiKeyContext,
} from "@/src/shared/types/entities";
import {
  deleteApiKey,
  getApiKeyByHash,
  getApiKeyById,
  insertApiKey,
  listPublicApiKeys,
  markApiKeyUsed,
  toPublicApiKey,
  updateApiKey,
} from "@/src/server/repositories/apiKeys";
import {
  getApiKeyDailyUsage,
  getApiKeyRequestCountSince,
} from "@/src/server/repositories/logs";
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

export function createApiKey(input: CreateApiKeyInput = {}): CreatedApiKey {
  const key = `relay_sk_${base64Url(32)}`;
  const record = insertApiKey({
    id: randomId("key"),
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
  return listPublicApiKeys();
}

export function patchApiKey(id: string, input: Partial<CreateApiKeyInput>) {
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
  enforceRateLimit(record.id, record.rateLimitPerMinute);
  markApiKeyUsed(record.id);
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    scopes: record.scopes,
    modelAllowlist: record.modelAllowlist,
    channelAllowlist: record.channelAllowlist,
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

function enforceRateLimit(apiKeyId: string, limit: number | null) {
  if (!limit) {
    return;
  }
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const recentInFlight = (inFlightRateLimitBuckets.get(apiKeyId) || []).filter(
    (timestamp) => timestamp >= windowStart,
  );
  const persistedCount = getApiKeyRequestCountSince(
    apiKeyId,
    new Date(windowStart),
  );
  if (persistedCount + recentInFlight.length >= limit) {
    inFlightRateLimitBuckets.set(apiKeyId, recentInFlight);
    throw new HttpError(
      429,
      "rate_limit_exceeded",
      "API key rate limit has been reached",
    );
  }
  recentInFlight.push(now);
  inFlightRateLimitBuckets.set(apiKeyId, recentInFlight);
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

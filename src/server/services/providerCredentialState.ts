import "server-only";

import { serverConfig } from "@/src/server/config/env";
import {
  markProviderCredentialUsed as markStoredProviderCredentialUsed,
  updateProviderCredentialLifecycle,
} from "@/src/server/repositories/providerCredentials";
import type { ProviderId } from "@/src/shared/types/entities";

export function markProviderCredentialUsed(provider: ProviderId, id: string) {
  markStoredProviderCredentialUsed(provider, id);
}

export function recordProviderCredentialSuccess(provider: ProviderId, id: string) {
  updateProviderCredentialState(provider, id, { cooldownUntil: null, lastError: null });
}

export function recordProviderCredentialFailure(provider: ProviderId, id: string, input: { statusCode?: number | null; message?: string | null; retryAfterMs?: number | null }) {
  const cooldownUntil = resolveCredentialCooldownUntil({ statusCode: input.statusCode, retryAfterMs: input.retryAfterMs });
  updateProviderCredentialState(provider, id, { cooldownUntil, lastError: input.message || null });
  return cooldownUntil;
}

export function resolveCredentialCooldownUntil(input: { statusCode?: number | null; retryAfterMs?: number | null; now?: Date }) {
  const now = input.now || new Date();
  const retryAfterMs = typeof input.retryAfterMs === "number" && Number.isFinite(input.retryAfterMs) && input.retryAfterMs >= 0 ? input.retryAfterMs : null;
  const cooldownMs = retryAfterMs ?? credentialCooldownMs(input.statusCode ?? null);
  return cooldownMs <= 0 ? null : new Date(now.getTime() + cooldownMs).toISOString();
}

function updateProviderCredentialState(provider: ProviderId, id: string, patch: { cooldownUntil: string | null; lastError: string | null }) {
  updateProviderCredentialLifecycle(provider, id, patch);
}

function credentialCooldownMs(statusCode: number | null) {
  if (statusCode === 401) return serverConfig.credentialCooldown401Ms;
  if (statusCode === 403) return serverConfig.credentialCooldown403Ms;
  if (statusCode === 429) return serverConfig.credentialCooldown429Ms;
  return 0;
}

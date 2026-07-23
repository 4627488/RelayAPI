import "server-only";

import type {
  ChannelRecord,
  ProviderUsageHealth,
  CodexCredentialRecord,
  ProviderId,
  RelayApiKeyContext,
} from "@/src/shared/types/entities";
import {
  deleteChannel,
  getChannelById,
  insertChannel,
  listChannels,
  markChannelUsed,
  updateChannel,
} from "@/src/server/repositories/channels";
import {
  getCodexCredentialWithTokens,
  listCodexCredentials,
} from "@/src/server/repositories/codexCredentials";
import { getProviderCredentialWithTokens } from "@/src/server/repositories/providerCredentials";
import {
  channelUsageHealth,
  credentialUsageHealth,
} from "@/src/server/repositories/logs";
import { appendChannelHealthEvent } from "@/src/server/repositories/operationalEvents";
import { serverConfig } from "@/src/server/config/env";
import { randomId } from "@/src/server/services/crypto";
import { HttpError } from "@/src/server/http/errors";
import { eligibleCredentialIdsForTenant } from "@/src/server/services/tenantQuota";
import {
  isProviderRoutingChannelAvailable,
  isProviderRoutingCredentialAvailable,
  routingChannelDeclaresModel,
  routingModelMatchesAllowlist,
  selectProviderRoutingItem,
} from "@/src/server/services/providerRoutingCore";
import {
  markProviderCredentialUsed,
  recordProviderCredentialFailure,
  recordProviderCredentialSuccess,
} from "@/src/server/services/providerCredentialState";
export { resolveCredentialCooldownUntil } from "@/src/server/services/providerCredentialState";
import {
  normalizeProviderId,
  providerCredentialDefaultBaseUrl,
  providerLabel,
  providerUnavailableChannelCode,
} from "@/src/shared/providerCapabilities";

export interface CreateChannelInput {
  provider?: ProviderId;
  name?: string;
  baseUrl?: string;
  credentialId?: string;
  credentialIds?: string[];
  enabled?: boolean;
  priority?: number;
  weight?: number;
  modelAllowlist?: string[];
}

export function listChannelRecords() {
  const channels = listChannels();
  const healthByChannelId = channelUsageHealth(
    channels.map((channel) => channel.id),
  );
  return channels.map((channel) =>
    attachChannelUsageHealth(channel, healthByChannelId[channel.id]),
  );
}

export function createChannel(input: CreateChannelInput) {
  const provider = normalizeProviderId(input.provider);
  const credentials = assertChannelCredentials(input, provider);
  const modelAllowlist = requireDeclaredModels(input.modelAllowlist);
  const primaryCredential = credentials[0];
  const channel = insertChannel({
    id: randomId("ch"),
    name:
      cleanString(input.name) ||
      (primaryCredential.email
        ? `${providerLabel(provider)} · ${primaryCredential.email}`
        : `${providerLabel(provider)} · ${primaryCredential.id}`),
    provider,
    baseUrl:
      cleanString(input.baseUrl) ||
      providerCredentialDefaultBaseUrl(
        primaryCredential,
        serverConfig.codexBaseUrl,
      ),
    credentialIds: credentials.map((credential) => credential.id),
    enabled: input.enabled ?? true,
    priority: normalizeInteger(input.priority, 100),
    weight: Math.max(1, normalizeInteger(input.weight, 1)),
    modelAllowlist,
    status: "healthy",
  });
  if (!channel) {
    throw new Error("Failed to create channel");
  }
  return channel;
}

export function patchChannel(
  id: string,
  input: Partial<CreateChannelInput> & {
    status?: ChannelRecord["status"];
    healthScore?: number;
    cooldownUntil?: string | null;
  },
) {
  const current = getChannelById(id);
  const currentProvider = current?.provider || "codex";
  const replacementCredentials =
    input.credentialIds !== undefined || input.credentialId !== undefined
      ? assertChannelCredentials(input, currentProvider)
      : null;
  const fallbackCredential =
    replacementCredentials?.[0] ||
    (current?.credentialIds[0]
      ? getProviderCredentialWithTokens(
          current.credentialIds[0],
          currentProvider,
        )
      : null);
  const credentialPatch = replacementCredentials
    ? {
        credentialIds: replacementCredentials.map(
          (credential) => credential.id,
        ),
      }
    : {};
  const channel = updateChannel(id, {
    ...(input.name !== undefined ? { name: cleanString(input.name) } : {}),
    ...(input.baseUrl !== undefined
      ? {
          baseUrl:
            cleanString(input.baseUrl) ||
            (fallbackCredential
              ? providerCredentialDefaultBaseUrl(
                  fallbackCredential,
                  serverConfig.codexBaseUrl,
                )
              : serverConfig.codexBaseUrl),
        }
      : {}),
    ...credentialPatch,
    ...(input.enabled !== undefined ? { enabled: Boolean(input.enabled) } : {}),
    ...(input.priority !== undefined
      ? { priority: normalizeInteger(input.priority, 100) }
      : {}),
    ...(input.weight !== undefined
      ? { weight: Math.max(1, normalizeInteger(input.weight, 1)) }
      : {}),
    ...(input.modelAllowlist !== undefined
      ? { modelAllowlist: requireDeclaredModels(input.modelAllowlist) }
      : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.healthScore !== undefined
      ? { healthScore: clamp(Number(input.healthScore), 0, 100) }
      : {}),
    ...(input.cooldownUntil !== undefined
      ? { cooldownUntil: cleanString(input.cooldownUntil) || null }
      : {}),
  });
  if (!channel) {
    throw new HttpError(404, "channel_not_found", "Channel not found");
  }
  return channel;
}

export function removeChannel(id: string) {
  if (!deleteChannel(id)) {
    throw new HttpError(404, "channel_not_found", "Channel not found");
  }
}

export function selectChannel(input: {
  model: string;
  apiKey: RelayApiKeyContext;
  excludedCredentialIds?: Set<string>;
  markUsed?: boolean;
}) {
  const model = cleanString(input.model);
  assertApiKeyModelAllowed(model, input.apiKey);

  const now = Date.now();
  const eligibleCredentialIds = input.apiKey.tenantId
    ? new Set(
        eligibleCredentialIdsForTenant(
          input.apiKey.tenantId,
          input.apiKey.tenantUserId,
        ),
      )
    : null;
  const availableChannels = listChannels().filter((channel) =>
    isProviderRoutingChannelAvailable(channel, {
      provider: "codex",
      model,
      channelAllowlist: input.apiKey.channelAllowlist,
      now,
    }),
  );
  const credentialIds = availableChannels.flatMap(
    (channel) => channel.credentialIds,
  );
  const credentialsById = credentialRoutingMap(credentialIds);
  const candidates = availableChannels.flatMap((channel) => {
    const credential = selectCredentialForChannel(
      channel,
      credentialsById,
      now,
      eligibleCredentialIds,
      input.excludedCredentialIds,
    );
    if (!credential) {
      return [];
    }
    const channelForRequest = { ...channel, credentialId: credential.id };
    return [{ channel: channelForRequest, credential }];
  });

  if (candidates.length === 0) {
    throw new HttpError(
      503,
      providerUnavailableChannelCode("codex"),
      "No usable channel is available for this request",
    );
  }

  const selected = selectProviderRoutingItem(
    candidates,
    (candidate) => candidate.channel.priority,
    (candidate) => candidate.channel.weight,
    (candidate) =>
      Math.min(
        candidate.channel.healthScore,
        usageHealthScore(candidate.credential.usageHealth),
      ),
  );
  const credential = getCodexCredentialWithTokens(selected.credential.id);
  if (!credential) {
    throw new HttpError(
      503,
      "codex_credential_not_found",
      "Selected channel credential was not found",
    );
  }
  const channel = { ...selected.channel, credentialId: credential.id };
  if (input.markUsed !== false) {
    markChannelUsed(channel.id);
    markProviderCredentialUsed("codex", credential.id);
  }
  return { channel, credential };
}

export function assertApiKeyModelAllowed(
  model: string,
  apiKey: RelayApiKeyContext,
) {
  const cleanModel = cleanString(model);
  if (
    apiKey.modelAllowlist.length > 0 &&
    cleanModel &&
    !routingModelMatchesAllowlist(cleanModel, apiKey.modelAllowlist)
  ) {
    throw new HttpError(
      403,
      "model_not_allowed",
      `API key is not allowed to use model: ${cleanModel}`,
    );
  }
}

export function channelDeclaresModel(
  channel: Pick<ChannelRecord, "modelAllowlist">,
  model: string,
) {
  return routingChannelDeclaresModel(channel, model);
}

export function recordChannelSuccess(channel: ChannelRecord) {
  recordProviderCredentialSuccess(channel.provider, channel.credentialId);
  const nextScore = clamp(channel.healthScore + 2, 0, 100);
  const next = updateChannel(channel.id, {
    status: nextScore >= 60 ? "healthy" : "degraded",
    healthScore: nextScore,
    cooldownUntil: null,
    lastError: null,
  });
  appendChannelHealthEvent({
    channelId: channel.id,
    channelName: channel.name,
    credentialId: channel.credentialId,
    eventType: "success",
    healthScore: next?.healthScore ?? nextScore,
  });
}

export function recordChannelFailure(
  channel: ChannelRecord,
  input: {
    statusCode?: number | null;
    message?: string | null;
    retryAfterMs?: number | null;
  },
) {
  const statusCode = input.statusCode ?? null;
  if (isCredentialScopedFailure(statusCode)) {
    const cooldownUntil = recordProviderCredentialFailure(
      channel.provider,
      channel.credentialId,
      input,
    );
    updateChannel(channel.id, { lastError: input.message || null });
    appendChannelHealthEvent({
      channelId: channel.id,
      channelName: channel.name,
      credentialId: channel.credentialId,
      eventType: "credential_failure",
      statusCode,
      healthScore: channel.healthScore,
      cooldownUntil,
      message: input.message || null,
    });
    return;
  }

  const penalty = statusCode && statusCode >= 500 ? 15 : 8;
  const nextScore = clamp(channel.healthScore - penalty, 0, 100);
  const next = updateChannel(channel.id, {
    status: nextScore >= 60 ? "healthy" : "degraded",
    healthScore: nextScore,
    cooldownUntil: null,
    lastError: input.message || null,
  });
  appendChannelHealthEvent({
    channelId: channel.id,
    channelName: channel.name,
    credentialId: channel.credentialId,
    eventType: "failure",
    statusCode,
    healthScore: next?.healthScore ?? nextScore,
    cooldownUntil: null,
    message: input.message || null,
  });
}

function isCredentialScopedFailure(statusCode: number | null) {
  return statusCode === 401 || statusCode === 403 || statusCode === 429;
}

type CredentialRoutingRecord = CodexCredentialRecord & {
  usageHealth: ProviderUsageHealth;
};

function attachChannelUsageHealth(
  channel: ChannelRecord,
  usageHealth?: ProviderUsageHealth,
): ChannelRecord {
  const health = usageHealth || unusedUsageHealth(100);
  return { ...channel, usageHealth: health, healthScore: health.score };
}

function credentialRoutingMap(credentialIds: string[]) {
  const requestedIds = new Set(cleanStringArray(credentialIds));
  const healthByCredentialId = credentialUsageHealth([...requestedIds]);
  return new Map(
    listCodexCredentials()
      .filter((credential) => requestedIds.has(credential.id))
      .map((credential) => [
        credential.id,
        {
          ...credential,
          usageHealth:
            healthByCredentialId[credential.id] || unusedUsageHealth(50),
        },
      ]),
  );
}

function selectCredentialForChannel(
  channel: ChannelRecord,
  credentialsById: Map<string, CredentialRoutingRecord>,
  now: number,
  eligibleCredentialIds: Set<string> | null,
  excludedCredentialIds?: Set<string>,
) {
  const credentials = channel.credentialIds
    .map((credentialId) => credentialsById.get(credentialId))
    .filter((credential): credential is CredentialRoutingRecord =>
      Boolean(
        credential &&
          isProviderRoutingCredentialAvailable(credential, {
            now,
            eligibleCredentialIds,
            excludedCredentialIds,
          }),
      ),
    );
  if (credentials.length === 0) {
    return null;
  }
  return selectProviderRoutingItem(
    credentials,
    (credential) => credential.priority,
    (credential) => credential.weight,
    (credential) => usageHealthScore(credential.usageHealth),
  );
}

function assertChannelCredentials(
  input: CreateChannelInput,
  provider: ProviderId = "codex",
) {
  const credentialIds = cleanStringArray([
    ...(Array.isArray(input.credentialIds) ? input.credentialIds : []),
    ...(input.credentialId ? [input.credentialId] : []),
  ]);
  if (credentialIds.length === 0) {
    throw new HttpError(
      400,
      "missing_channel_credentials",
      "Channel must include at least one provider credential",
    );
  }
  return credentialIds.map((credentialId) => {
    const credential = getProviderCredentialWithTokens(credentialId, provider);
    if (!credential || credential.provider !== provider) {
      throw new HttpError(
        400,
        "provider_credential_not_found",
        `Cannot bind channel to a missing ${providerLabel(provider)} credential`,
      );
    }
    return credential;
  });
}

function usageHealthScore(health: ProviderUsageHealth | undefined) {
  return clamp(health?.score ?? 100, 0, 100);
}

function unusedUsageHealth(windowSize: number): ProviderUsageHealth {
  return {
    status: "unused",
    score: 100,
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    lastUsedAt: null,
    lastStatusCode: null,
    lastErrorCode: null,
    windowSize,
  };
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map(cleanString).filter(Boolean))];
}

function requireDeclaredModels(value: unknown) {
  const models = cleanStringArray(value);
  if (models.length === 0) {
    throw new HttpError(
      400,
      "channel_models_required",
      "Channel must declare at least one model",
    );
  }
  return models;
}

function normalizeInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, value));
}

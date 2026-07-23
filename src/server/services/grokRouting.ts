import "server-only";
import {
  listChannels,
  markChannelUsed,
} from "@/src/server/repositories/channels";
import {
  getGrokCredentialWithTokens,
  listGrokCredentials,
} from "@/src/server/repositories/grokCredentials";
import { eligibleCredentialIdsForTenant } from "@/src/server/services/tenantQuota";
import { HttpError } from "@/src/server/http/errors";
import type {
  ChannelRecord,
  RelayApiKeyContext,
} from "@/src/shared/types/entities";
import {
  assertApiKeyModelAllowed,
  recordChannelFailure,
  recordChannelSuccess,
} from "@/src/server/services/channels";
import { credentialUsageHealth } from "@/src/server/repositories/logAnalytics";
import {
  isProviderRoutingChannelAvailable,
  isProviderRoutingCredentialAvailable,
  selectProviderRoutingItem,
  wildcardModelMatch,
} from "@/src/server/services/providerRoutingCore";
import { markProviderCredentialUsed } from "@/src/server/services/providerCredentialState";
import { providerUnavailableChannelCode } from "@/src/shared/providerCapabilities";

export function selectGrokChannel(input: {
  model: string;
  apiKey: RelayApiKeyContext;
  excludedCredentialIds?: Set<string>;
  markUsed?: boolean;
}) {
  assertApiKeyModelAllowed(input.model, input.apiKey);
  const now = Date.now();
  const eligible = input.apiKey.tenantId
    ? new Set(
        eligibleCredentialIdsForTenant(
          input.apiKey.tenantId,
          input.apiKey.tenantUserId,
        ),
      )
    : null;
  const storedCredentials = listGrokCredentials();
  const health = credentialUsageHealth(
    storedCredentials.map((item) => item.id),
  );
  const credentials = new Map(
    storedCredentials.map((item) => [
      item.id,
      { ...item, usageHealth: health[item.id] },
    ]),
  );
  const candidates = listChannels()
    .filter((channel) =>
      isProviderRoutingChannelAvailable(channel, {
        provider: "grok",
        model: input.model,
        channelAllowlist: input.apiKey.channelAllowlist,
        now,
      }),
    )
    .flatMap((channel) =>
      channel.credentialIds
        .map((id) => credentials.get(id))
        .filter((item): item is NonNullable<typeof item> =>
          Boolean(
            item &&
              isProviderRoutingCredentialAvailable(item, {
                now,
                eligibleCredentialIds: eligible,
                excludedCredentialIds: input.excludedCredentialIds,
              }) &&
              !item.grokExcludedModels.some((pattern) =>
                wildcardModelMatch(pattern, input.model),
              ),
          ),
        )
        .map((credential) => ({ channel, credential })),
    );
  if (!candidates.length)
    throw new HttpError(
      503,
      providerUnavailableChannelCode("grok"),
      "No usable Grok channel is available",
    );
  const selected = selectProviderRoutingItem(
    candidates,
    (item) => item.channel.priority,
    (item) =>
      Math.max(1, item.channel.weight) * Math.max(1, item.credential.weight),
    (item) =>
      Math.min(
        item.channel.healthScore,
        item.credential.usageHealth?.score ?? 100,
      ),
  );
  if (input.markUsed !== false) {
    markChannelUsed(selected.channel.id);
    markProviderCredentialUsed("grok", selected.credential.id);
  }
  return {
    channel: { ...selected.channel, credentialId: selected.credential.id },
    credential: getGrokCredentialWithTokens(selected.credential.id)!,
  };
}

export function recordGrokChannelFailure(
  channel: ChannelRecord,
  status: number,
  message: string,
  retryAfterMs?: number | null,
) {
  recordChannelFailure(channel, { statusCode: status, message, retryAfterMs });
}
export function recordGrokChannelSuccess(channel: ChannelRecord) {
  recordChannelSuccess(channel);
}

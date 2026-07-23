import "server-only";

import { HttpError, isHttpError } from "@/src/server/http/errors";
import { listChannels } from "@/src/server/repositories/channels";
import { selectChannel } from "@/src/server/services/channels";
import { selectGrokChannel } from "@/src/server/services/grokRouting";
import { providerRoutingHealthTier } from "@/src/server/services/providerRoutingCore";
import { providerUnavailableChannelCode } from "@/src/shared/providerCapabilities";
import type {
  ChannelRecord,
  ProviderUsageHealth,
  ProviderId,
  RelayApiKeyContext,
} from "@/src/shared/types/entities";

type ProviderRoutingAdapter = {
  provider: ProviderId;
  missingChannelCode: string;
  select: (input: {
    model: string;
    apiKey: RelayApiKeyContext;
    excludedCredentialIds?: Set<string>;
    markUsed?: boolean;
  }) => {
    channel: ChannelRecord;
    credential: { usageHealth?: ProviderUsageHealth };
  };
};

const providerRoutingAdapters: ProviderRoutingAdapter[] = [
  {
    provider: "codex",
    missingChannelCode: providerUnavailableChannelCode("codex"),
    select: selectChannel,
  },
  {
    provider: "grok",
    missingChannelCode: providerUnavailableChannelCode("grok"),
    select: selectGrokChannel,
  },
];

export function selectProviderForModel(input: {
  model: string;
  apiKey: RelayApiKeyContext;
}): ProviderId {
  const channelOrder = new Map(
    listChannels().map((channel, index) => [channel.id, index]),
  );
  const candidates: Array<{
    provider: ProviderId;
    priority: number;
    order: number;
    healthScore: number;
  }> = [];

  for (const adapter of providerRoutingAdapters) {
    try {
      const selected = adapter.select({ ...input, markUsed: false });
      candidates.push({
        provider: adapter.provider,
        priority: selected.channel.priority,
        order: channelOrder.get(selected.channel.id) ?? Number.MAX_SAFE_INTEGER,
        healthScore: Math.min(
          selected.channel.healthScore,
          selected.credential.usageHealth?.score ?? 100,
        ),
      });
    } catch (error) {
      if (!isMissingProviderChannel(error, adapter.missingChannelCode))
        throw error;
    }
  }

  if (candidates.length === 0) {
    throw new HttpError(
      503,
      "no_declared_model_channel",
      `No usable channel declares model: ${input.model}`,
    );
  }

  candidates.sort(
    (left, right) =>
      providerRoutingHealthTier(right.healthScore) -
        providerRoutingHealthTier(left.healthScore) ||
      right.priority - left.priority ||
      left.order - right.order,
  );
  return candidates[0].provider;
}

export function listRoutableModelsForApiKey(apiKey: RelayApiKeyContext) {
  const declaredModels = [
    ...new Set(listChannels().flatMap((channel) => channel.modelAllowlist)),
  ];
  return declaredModels.filter((model) => {
    try {
      selectProviderForModel({ model, apiKey });
      return true;
    } catch (error) {
      if (
        isHttpError(error) &&
        ["model_not_allowed", "no_declared_model_channel"].includes(error.code)
      )
        return false;
      throw error;
    }
  });
}

function isMissingProviderChannel(error: unknown, code: string) {
  return isHttpError(error) && error.code === code;
}

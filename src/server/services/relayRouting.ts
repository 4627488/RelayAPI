import "server-only";

import { HttpError, isHttpError } from "@/src/server/http/errors";
import { listChannels } from "@/src/server/repositories/channels";
import { selectChannel } from "@/src/server/services/channels";
import { selectGrokChannel } from "@/src/server/services/grokRouting";
import type { ProviderId, RelayApiKeyContext } from "@/src/shared/types/entities";

export function selectProviderForModel(input: {
  model: string;
  apiKey: RelayApiKeyContext;
}): ProviderId {
  const channelOrder = new Map(
    listChannels().map((channel, index) => [channel.id, index]),
  );
  const candidates: Array<{ provider: ProviderId; priority: number; order: number }> = [];

  try {
    const selected = selectChannel({ ...input, markUsed: false });
    candidates.push({
      provider: "codex",
      priority: selected.channel.priority,
      order: channelOrder.get(selected.channel.id) ?? Number.MAX_SAFE_INTEGER,
    });
  } catch (error) {
    if (!isMissingProviderChannel(error, "no_available_channel")) throw error;
  }

  try {
    const selected = selectGrokChannel({ ...input, markUsed: false });
    candidates.push({
      provider: "grok",
      priority: selected.channel.priority,
      order: channelOrder.get(selected.channel.id) ?? Number.MAX_SAFE_INTEGER,
    });
  } catch (error) {
    if (!isMissingProviderChannel(error, "no_available_grok_channel")) throw error;
  }

  if (candidates.length === 0) {
    throw new HttpError(
      503,
      "no_declared_model_channel",
      `No usable channel declares model: ${input.model}`,
    );
  }

  candidates.sort((left, right) =>
    right.priority - left.priority || left.order - right.order,
  );
  return candidates[0].provider;
}

function isMissingProviderChannel(error: unknown, code: string) {
  return isHttpError(error) && error.code === code;
}

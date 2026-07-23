import "server-only";

import { listCodexUpstreamModelIds, listGrokCatalogModelIds } from "@/src/server/codex/models";
import { providerIds } from "@/src/shared/providerCapabilities";
import type { ProviderId } from "@/src/shared/types/entities";

const providerModelLoaders: Record<ProviderId, () => Promise<string[]>> = {
  codex: listCodexUpstreamModelIds,
  grok: listGrokCatalogModelIds,
};

export async function listProviderModelIds(provider?: ProviderId) {
  if (provider) return providerModelLoaders[provider]();
  const results = await Promise.allSettled(
    providerIds.map((providerId) => providerModelLoaders[providerId]()),
  );
  const models = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  if (models.length === 0) {
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
  }
  return [...new Set(models)];
}

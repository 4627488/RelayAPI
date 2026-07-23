import "server-only";

import { HttpError } from "@/src/server/http/errors";
import { detachCredentialFromChannels } from "@/src/server/repositories/channels";
import { getProviderCredential } from "@/src/server/repositories/providerCredentials";
import { patchCodexCredentialRouting, removeCodexCredential, listPublicCodexCredentials } from "@/src/server/services/codexCredentials";
import { listPublicGrokCredentials, patchGrokCredential, removeGrokCredential } from "@/src/server/services/grokCredentials";
import { normalizeProviderId } from "@/src/shared/providerCapabilities";
import type { ProviderId } from "@/src/shared/types/entities";

type ProviderCredentialService = {
  list: () => unknown;
  patch: (id: string, input: Record<string, unknown>) => unknown;
  remove: (id: string) => unknown;
};

const providerCredentialServices: Record<ProviderId, ProviderCredentialService> = {
  codex: {
    list: listPublicCodexCredentials,
    patch: patchCodexCredentialRouting,
    remove: removeCodexCredential,
  },
  grok: {
    list: listPublicGrokCredentials,
    patch: patchGrokCredential,
    remove: removeGrokCredential,
  },
};

export function parseProviderId(value: string): ProviderId {
  const provider = normalizeProviderId(value);
  if (provider !== value) throw new HttpError(404, "provider_not_found", `Unknown provider: ${value}`);
  return provider;
}

export function listPublicProviderCredentials(provider: ProviderId) {
  return Promise.resolve(providerCredentialServices[provider].list());
}

export function patchProviderCredential(provider: ProviderId, id: string, input: Record<string, unknown>) {
  return providerCredentialServices[provider].patch(id, input);
}

export async function removeProviderCredential(provider: ProviderId, id: string) {
  const credential = getProviderCredential(id);
  if (!credential || credential.provider !== provider) {
    await providerCredentialServices[provider].remove(id);
    return;
  }
  detachCredentialFromChannels(id);
  await providerCredentialServices[provider].remove(id);
}

import "server-only";

import {
  getCodexCredentialById,
  getCodexCredentialWithTokens,
  listCodexCredentials,
  listCodexCredentialsWithTokens,
  markCodexCredentialUsed,
  updateCodexCredential,
} from "@/src/server/repositories/codexCredentials";
import {
  getGrokCredentialWithTokens,
  listGrokCredentials,
  listGrokCredentialsWithTokens,
  updateGrokCredential,
} from "@/src/server/repositories/grokCredentials";
import { providerCredentialIdentity, providerIds } from "@/src/shared/providerCapabilities";
import type {
  ProviderCredentialRecord,
  ProviderCredentialWithTokens,
  ProviderId,
} from "@/src/shared/types/entities";

type ProviderCredentialStore = {
  list: () => ProviderCredentialRecord[];
  listWithTokens: () => ProviderCredentialWithTokens[];
  get: (id: string) => ProviderCredentialRecord | null;
  getWithTokens: (id: string) => ProviderCredentialWithTokens | null;
  markUsed: (id: string) => void;
  updateLifecycle: (id: string, patch: ProviderCredentialLifecyclePatch) => unknown;
};

type ProviderCredentialLifecyclePatch = {
  cooldownUntil?: string | null;
  lastError?: string | null;
  lastUsedAt?: string | null;
};

const providerCredentialStores: Record<ProviderId, ProviderCredentialStore> = {
  codex: {
    list: listCodexCredentials,
    listWithTokens: listCodexCredentialsWithTokens,
    get: getCodexCredentialById,
    getWithTokens: getCodexCredentialWithTokens,
    markUsed: markCodexCredentialUsed,
    updateLifecycle: updateCodexCredential,
  },
  grok: {
    list: listGrokCredentials,
    listWithTokens: listGrokCredentialsWithTokens,
    get: (id) => listGrokCredentials().find((item) => item.id === id) || null,
    getWithTokens: getGrokCredentialWithTokens,
    markUsed: (id) => updateGrokCredential(id, { lastUsedAt: new Date().toISOString() }),
    updateLifecycle: updateGrokCredential,
  },
};

export function listProviderCredentials(
  provider?: ProviderId,
): ProviderCredentialRecord[] {
  if (provider) return providerCredentialStores[provider].list();
  return providerIds.flatMap((id) => providerCredentialStores[id].list());
}

export function listProviderCredentialsWithTokens(
  provider?: ProviderId,
): ProviderCredentialWithTokens[] {
  if (provider) return providerCredentialStores[provider].listWithTokens();
  return providerIds.flatMap((id) => providerCredentialStores[id].listWithTokens());
}

export function getProviderCredential(
  id: string,
): ProviderCredentialRecord | null {
  for (const provider of providerIds) {
    const credential = providerCredentialStores[provider].get(id);
    if (credential) return credential;
  }
  return null;
}

export function getProviderCredentialWithTokens(
  id: string,
  provider?: ProviderId,
): ProviderCredentialWithTokens | null {
  if (provider) return providerCredentialStores[provider].getWithTokens(id);
  for (const providerId of providerIds) {
    const credential = providerCredentialStores[providerId].getWithTokens(id);
    if (credential) return credential;
  }
  return null;
}

export function markProviderCredentialUsed(provider: ProviderId, id: string) {
  providerCredentialStores[provider].markUsed(id);
}

export function updateProviderCredentialLifecycle(
  provider: ProviderId,
  id: string,
  patch: ProviderCredentialLifecyclePatch,
) {
  return providerCredentialStores[provider].updateLifecycle(id, patch);
}

export { providerCredentialIdentity };

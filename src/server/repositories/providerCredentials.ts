import "server-only";

import {
  getCodexCredentialById,
  getCodexCredentialWithTokens,
  listCodexCredentials,
  listCodexCredentialsWithTokens,
} from "@/src/server/repositories/codexCredentials";
import {
  getGrokCredentialWithTokens,
  listGrokCredentials,
  listGrokCredentialsWithTokens,
} from "@/src/server/repositories/grokCredentials";
import { providerIds } from "@/src/shared/providerCapabilities";
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
};

const providerCredentialStores: Record<ProviderId, ProviderCredentialStore> = {
  codex: {
    list: listCodexCredentials,
    listWithTokens: listCodexCredentialsWithTokens,
    get: getCodexCredentialById,
    getWithTokens: getCodexCredentialWithTokens,
  },
  grok: {
    list: listGrokCredentials,
    listWithTokens: listGrokCredentialsWithTokens,
    get: (id) => listGrokCredentials().find((item) => item.id === id) || null,
    getWithTokens: getGrokCredentialWithTokens,
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

export function providerCredentialIdentity(
  credential: ProviderCredentialRecord,
) {
  return credential.provider === "codex"
    ? credential.accountId
    : credential.subject;
}

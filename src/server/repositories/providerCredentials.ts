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
import type {
  ProviderCredentialRecord,
  ProviderCredentialWithTokens,
  ProviderId,
} from "@/src/shared/types/entities";

export function listProviderCredentials(
  provider?: ProviderId,
): ProviderCredentialRecord[] {
  if (provider === "codex") return listCodexCredentials();
  if (provider === "grok") return listGrokCredentials();
  return [...listCodexCredentials(), ...listGrokCredentials()];
}

export function listProviderCredentialsWithTokens(
  provider?: ProviderId,
): ProviderCredentialWithTokens[] {
  if (provider === "codex") return listCodexCredentialsWithTokens();
  if (provider === "grok") return listGrokCredentialsWithTokens();
  return [
    ...listCodexCredentialsWithTokens(),
    ...listGrokCredentialsWithTokens(),
  ];
}

export function getProviderCredential(
  id: string,
): ProviderCredentialRecord | null {
  return getCodexCredentialById(id) || getGrokCredentialWithTokens(id);
}

export function getProviderCredentialWithTokens(
  id: string,
  provider?: ProviderId,
): ProviderCredentialWithTokens | null {
  if (provider === "codex") return getCodexCredentialWithTokens(id);
  if (provider === "grok") return getGrokCredentialWithTokens(id);
  return getCodexCredentialWithTokens(id) || getGrokCredentialWithTokens(id);
}

export function providerCredentialIdentity(
  credential: ProviderCredentialRecord,
) {
  return credential.provider === "codex"
    ? credential.accountId
    : credential.subject;
}

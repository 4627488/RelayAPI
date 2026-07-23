import "server-only";

import { logServerError } from "@/src/server/http/errors";
import { getCodexQuota } from "@/src/server/services/codexQuota";
import { getGrokQuota } from "@/src/server/services/grokQuota";
import type {
  CodexQuotaReport,
  GrokQuotaReport,
} from "@/src/shared/providerQuota";
import type {
  ProviderCredentialRecord,
  ProviderId,
} from "@/src/shared/types/entities";
import { providerSupportsAutomaticQuota } from "@/src/shared/providerCapabilities";

type ProviderQuotaOptions = {
  forceRefresh?: boolean;
  includeRaw?: boolean;
};

const providerQuotaReaders: Record<
  ProviderId,
  (credentialId: string, options: ProviderQuotaOptions) => Promise<unknown>
> = {
  codex: (credentialId, options) =>
    getCodexQuota({
      credentialId,
      forceRefresh: options.forceRefresh,
      includeRaw: options.includeRaw,
    }),
  grok: (credentialId) => getGrokQuota(credentialId),
};
const inFlightQuotaReads = new Map<string, Promise<unknown>>();

const quotaObservationAt = new Map<string, number>();
const QUOTA_OBSERVATION_INTERVAL_MS = 5 * 60 * 1000;

export function getProviderQuota(
  provider: "codex",
  credentialId: string,
  options?: ProviderQuotaOptions,
): Promise<CodexQuotaReport>;
export function getProviderQuota(
  provider: "grok",
  credentialId: string,
  options?: ProviderQuotaOptions,
): Promise<GrokQuotaReport>;
export function getProviderQuota(
  provider: ProviderId,
  credentialId: string,
  options?: ProviderQuotaOptions,
): Promise<CodexQuotaReport | GrokQuotaReport>;
export function getProviderQuota(
  provider: ProviderId,
  credentialId: string,
  options: ProviderQuotaOptions = {},
) {
  const key = [
    provider,
    credentialId,
    options.forceRefresh ? "refresh" : "cached",
    options.includeRaw ? "raw" : "clean",
  ].join(":");
  const existing = inFlightQuotaReads.get(key);
  if (existing) {
    return existing as Promise<CodexQuotaReport | GrokQuotaReport>;
  }
  const task = providerQuotaReaders[provider](credentialId, options).finally(
    () => {
      if (inFlightQuotaReads.get(key) === task) inFlightQuotaReads.delete(key);
    },
  );
  inFlightQuotaReads.set(key, task);
  return task as Promise<CodexQuotaReport | GrokQuotaReport>;
}

export function scheduleProviderQuotaObservation(
  credential: ProviderCredentialRecord | null,
) {
  if (
    !credential ||
    !providerCredentialSupportsQuota(credential) ||
    credential.provider !== "grok"
  ) {
    return;
  }
  const now = Date.now();
  if (
    now - (quotaObservationAt.get(credential.id) || 0) <
    QUOTA_OBSERVATION_INTERVAL_MS
  ) {
    return;
  }
  quotaObservationAt.set(credential.id, now);
  setImmediate(() => {
    void getProviderQuota("grok", credential.id).catch((error) =>
      logServerError(error, {
        operation: "provider.quota.observe_after_usage",
        metadata: {
          provider: credential.provider,
          credentialId: credential.id,
        },
      }),
    );
  });
}

export function providerCredentialSupportsQuota(
  credential: ProviderCredentialRecord | null,
) {
  return Boolean(
    credential &&
      providerSupportsAutomaticQuota(
        credential.provider,
        credential.provider === "grok" ? credential.authType : undefined,
      ),
  );
}

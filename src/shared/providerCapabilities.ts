import { codexPlanLabel, codexPlanShares } from "@/src/shared/codexPlans";
import type {
  ProviderCredentialRecord,
  ProviderId,
} from "@/src/shared/types/entities";

export type ProviderCapability = {
  id: ProviderId;
  label: string;
  defaultBaseUrl: string | null;
  planLabel: (planType: string) => string;
  capacityUnits: (planType: string) => number;
  calibratedCostQuota: boolean;
  quotaResetStrategy: "codex-cache" | "rolling";
  quotaAccess: "all" | "oauth";
  unavailableChannelCode: string;
};

const PROVIDER_CAPABILITIES: Record<ProviderId, ProviderCapability> = {
  codex: {
    id: "codex",
    label: "Codex",
    defaultBaseUrl: null,
    planLabel: codexPlanLabel,
    capacityUnits: codexPlanShares,
    calibratedCostQuota: true,
    quotaResetStrategy: "codex-cache",
    quotaAccess: "all",
    unavailableChannelCode: "no_available_channel",
  },
  grok: {
    id: "grok",
    label: "Grok",
    defaultBaseUrl: "https://cli-chat-proxy.grok.com/v1",
    planLabel: grokPlanLabel,
    capacityUnits: () => 1,
    calibratedCostQuota: true,
    quotaResetStrategy: "rolling",
    quotaAccess: "oauth",
    unavailableChannelCode: "no_available_grok_channel",
  },
};

export const providerIds = Object.freeze(
  Object.keys(PROVIDER_CAPABILITIES) as ProviderId[],
);

export function providerCapability(provider: ProviderId) {
  return PROVIDER_CAPABILITIES[provider];
}

export function normalizeProviderId(
  value: unknown,
  fallback: ProviderId = "codex",
) {
  return typeof value === "string" && providerIds.includes(value as ProviderId)
    ? (value as ProviderId)
    : fallback;
}

export function providerLabel(provider: ProviderId) {
  return providerCapability(provider).label;
}

export function providerPlanLabel(provider: ProviderId, planType: string) {
  return providerCapability(provider).planLabel(planType);
}

export function providerCapacityUnits(provider: ProviderId, planType: string) {
  return Math.max(1, providerCapability(provider).capacityUnits(planType));
}

export function providerDefaultBaseUrl(
  provider: ProviderId,
  codexBaseUrl: string,
) {
  return providerCapability(provider).defaultBaseUrl || codexBaseUrl;
}

export function providerCredentialDefaultBaseUrl(
  credential: ProviderCredentialRecord,
  codexBaseUrl: string,
) {
  if (credential.provider === "grok" && credential.grokBaseUrl) {
    return credential.grokBaseUrl;
  }
  if (credential.provider === "grok" && credential.authType === "api_key") {
    return "https://api.x.ai/v1";
  }
  return providerDefaultBaseUrl(credential.provider, codexBaseUrl);
}

export function providerUnavailableChannelCode(provider: ProviderId) {
  return providerCapability(provider).unavailableChannelCode;
}

export function providerSupportsAutomaticQuota(
  provider: ProviderId,
  authType?: "oauth" | "api_key",
) {
  const access = providerCapability(provider).quotaAccess;
  return access === "all" || authType === "oauth";
}

export function providerCredentialIdentity(
  credential: ProviderCredentialRecord,
) {
  return credential.provider === "codex"
    ? credential.accountId
    : credential.subject;
}

export function providerCredentialName(credential: ProviderCredentialRecord) {
  return (
    credential.email || providerCredentialIdentity(credential) || credential.id
  );
}

function grokPlanLabel(planType: string) {
  const normalized = String(planType || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (normalized === "apikey") return "Grok API";
  if (normalized === "supergrokheavy") return "SuperGrok Heavy";
  if (normalized === "supergrok") return "SuperGrok";
  if (normalized === "free") return "Free";
  if (!normalized || normalized === "groksubscription") return "Grok";
  return String(planType).trim();
}

import { codexPlanLabel, codexPlanShares } from "@/src/shared/codexPlans";
import type { ProviderId } from "@/src/shared/types/entities";

export type ProviderCapability = {
  id: ProviderId;
  label: string;
  defaultBaseUrl: string | null;
  planLabel: (planType: string) => string;
  capacityUnits: (planType: string) => number;
  calibratedCostQuota: boolean;
  quotaResetStrategy: "codex-cache" | "rolling";
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
  },
  grok: {
    id: "grok",
    label: "Grok",
    defaultBaseUrl: "https://cli-chat-proxy.grok.com/v1",
    planLabel: grokPlanLabel,
    capacityUnits: () => 1,
    calibratedCostQuota: false,
    quotaResetStrategy: "rolling",
  },
};

export const providerIds = Object.freeze(
  Object.keys(PROVIDER_CAPABILITIES) as ProviderId[],
);

export function providerCapability(provider: ProviderId) {
  return PROVIDER_CAPABILITIES[provider];
}

export function normalizeProviderId(value: unknown, fallback: ProviderId = "codex") {
  return typeof value === "string" && providerIds.includes(value as ProviderId)
    ? value as ProviderId
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

export function providerDefaultBaseUrl(provider: ProviderId, codexBaseUrl: string) {
  return providerCapability(provider).defaultBaseUrl || codexBaseUrl;
}

function grokPlanLabel(planType: string) {
  const normalized = String(planType || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (normalized === "supergrokheavy") return "SuperGrok Heavy";
  if (normalized === "supergrok") return "SuperGrok";
  if (normalized === "free") return "Free";
  if (!normalized || normalized === "groksubscription") return "Grok";
  return String(planType).trim();
}

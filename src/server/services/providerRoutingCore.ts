export function selectProviderRoutingItem<T>(
  items: T[],
  getPriority: (item: T) => number,
  getWeight: (item: T) => number,
  getHealthScore: (item: T) => number,
) {
  if (items.length === 0) throw new Error("Cannot select from an empty provider routing set");
  const candidates = items.map((item) => ({ item, priority: getPriority(item), weight: getWeight(item), healthScore: clamp(getHealthScore(item), 0, 100) }));
  for (const tier of [3, 2, 1, 0]) {
    const available = candidates.filter(
      (candidate) => providerRoutingHealthTier(candidate.healthScore) === tier,
    );
    if (available.length > 0) return weightedPickHighestPriority(available).item;
  }
  return candidates[0].item;
}

export function providerRoutingHealthTier(healthScore: number) {
  const score = clamp(healthScore, 0, 100);
  if (score >= 80) return 3;
  if (score >= 50) return 2;
  if (score >= 1) return 1;
  return 0;
}

export function wildcardModelMatch(pattern: string, value: string) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

export function routingModelMatchesAllowlist(
  model: string,
  allowlist: string[],
) {
  const cleanModel = model.trim();
  const baseModel = stripModelThinkingSuffix(cleanModel);
  return allowlist.some((allowed) => {
    const cleanAllowed = allowed.trim();
    return cleanAllowed === cleanModel || cleanAllowed === baseModel;
  });
}

export function routingChannelDeclaresModel(
  channel: Pick<ChannelRecord, "modelAllowlist">,
  model: string,
) {
  return Boolean(
    model.trim() &&
      channel.modelAllowlist.length > 0 &&
      routingModelMatchesAllowlist(model, channel.modelAllowlist),
  );
}

export function isProviderRoutingChannelAvailable(
  channel: ChannelRecord,
  input: {
    provider: ProviderId;
    model: string;
    channelAllowlist: string[];
    now: number;
  },
) {
  return (
    channel.provider === input.provider &&
    channel.enabled &&
    channel.status !== "disabled" &&
    (!channel.cooldownUntil || Date.parse(channel.cooldownUntil) <= input.now) &&
    routingChannelDeclaresModel(channel, input.model) &&
    (input.channelAllowlist.length === 0 ||
      input.channelAllowlist.includes(channel.id)) &&
    channel.credentialIds.length > 0
  );
}

export function isProviderRoutingCredentialAvailable(
  credential: {
    id: string;
    enabled: boolean;
    cooldownUntil: string | null;
  },
  input: {
    now: number;
    eligibleCredentialIds: Set<string> | null;
    excludedCredentialIds?: Set<string>;
  },
) {
  return (
    credential.enabled &&
    (!input.eligibleCredentialIds ||
      input.eligibleCredentialIds.has(credential.id)) &&
    !input.excludedCredentialIds?.has(credential.id) &&
    (!credential.cooldownUntil ||
      Date.parse(credential.cooldownUntil) <= input.now)
  );
}

export function stripModelThinkingSuffix(model: string) {
  const value = model.trim();
  const lastOpen = value.lastIndexOf("(");
  if (lastOpen <= 0 || !value.endsWith(")")) return value;
  const baseModel = value.slice(0, lastOpen).trim();
  const suffix = value.slice(lastOpen + 1, -1).trim().toLowerCase();
  if (
    !baseModel ||
    (!THINKING_SUFFIX_LEVELS.has(suffix) && !/^\d+$/.test(suffix))
  ) {
    return value;
  }
  return baseModel;
}

function weightedPickHighestPriority<T>(candidates: Array<{ item: T; priority: number; weight: number; healthScore: number }>) {
  const maxPriority = Math.max(...candidates.map((candidate) => candidate.priority));
  const priorityCandidates = candidates.filter((candidate) => candidate.priority === maxPriority);
  const totalWeight = priorityCandidates.reduce((sum, candidate) => sum + routingWeight(candidate), 0);
  let cursor = Math.random() * totalWeight;
  for (const candidate of priorityCandidates) {
    cursor -= routingWeight(candidate);
    if (cursor <= 0) return candidate;
  }
  return priorityCandidates[0];
}

function routingWeight(candidate: { weight: number; healthScore: number }) {
  return Math.max(1, candidate.weight) * Math.max(1, candidate.healthScore);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
import type { ChannelRecord, ProviderId } from "@/src/shared/types/entities";

const THINKING_SUFFIX_LEVELS = new Set([
  "none",
  "auto",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

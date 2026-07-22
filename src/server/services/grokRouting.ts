import "server-only";
import { listChannels, markChannelUsed } from "@/src/server/repositories/channels";
import { getGrokCredentialWithTokens, listGrokCredentials, updateGrokCredential } from "@/src/server/repositories/grokCredentials";
import { eligibleCredentialIdsForTenant } from "@/src/server/services/tenantQuota";
import { HttpError } from "@/src/server/http/errors";
import type { RelayApiKeyContext } from "@/src/shared/types/entities";
import { assertApiKeyModelAllowed, channelDeclaresModel } from "@/src/server/services/channels";

export function selectGrokChannel(input: { model: string; apiKey: RelayApiKeyContext; excludedCredentialIds?: Set<string>; markUsed?: boolean }) {
  assertApiKeyModelAllowed(input.model, input.apiKey);
  const now = Date.now(); const eligible = input.apiKey.tenantId ? new Set(eligibleCredentialIdsForTenant(input.apiKey.tenantId, input.apiKey.tenantUserId)) : null;
  const credentials = new Map(listGrokCredentials().map((item) => [item.id, item]));
  const candidates = listChannels().filter((channel) => channel.provider === "grok" && channel.enabled && channel.status !== "disabled" &&
    (!channel.cooldownUntil || Date.parse(channel.cooldownUntil) <= now) && channelDeclaresModel(channel, input.model) &&
    (!input.apiKey.channelAllowlist.length || input.apiKey.channelAllowlist.includes(channel.id)))
    .flatMap((channel) => channel.credentialIds.map((id) => credentials.get(id)).filter((item) => item?.enabled && (!eligible || eligible.has(item.id)) &&
      !input.excludedCredentialIds?.has(item.id) && !item.grokExcludedModels.some((pattern) => wildcard(pattern, input.model)) && (!item.cooldownUntil || Date.parse(item.cooldownUntil) <= now)).map((credential) => ({ channel, credential: credential! })));
  if (!candidates.length) throw new HttpError(503, "no_available_grok_channel", "No usable Grok channel is available");
  const maxPriority = Math.max(...candidates.map((item) => item.channel.priority)); const tier = candidates.filter((item) => item.channel.priority === maxPriority);
  const total = tier.reduce((sum, item) => sum + Math.max(1, item.channel.weight) * Math.max(1, item.credential.weight), 0); let cursor = Math.random() * total;
  const selected = tier.find((item) => ((cursor -= Math.max(1, item.channel.weight) * Math.max(1, item.credential.weight)) <= 0)) || tier[0];
  if (input.markUsed !== false) { markChannelUsed(selected.channel.id); updateGrokCredential(selected.credential.id, { lastUsedAt: new Date().toISOString() }); }
  return { channel: { ...selected.channel, credentialId: selected.credential.id }, credential: getGrokCredentialWithTokens(selected.credential.id)! };
}

export function recordGrokCredentialFailure(id: string, status: number, message: string, retryAfterMs?: number | null) {
  const cooldown = status === 429 ? new Date(Date.now() + (retryAfterMs ?? 5 * 60_000)).toISOString() : null;
  updateGrokCredential(id, { cooldownUntil: cooldown, lastError: message });
}
export function recordGrokCredentialSuccess(id: string) { updateGrokCredential(id, { cooldownUntil: null, lastError: null }); }
function wildcard(pattern: string, value: string) { const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"); return new RegExp(`^${escaped}$`, "i").test(value); }

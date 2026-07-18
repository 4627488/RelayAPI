import "server-only";

import { HttpError } from "@/src/server/http/errors";
import { getCodexQuotaCacheByCredentialId } from "@/src/server/repositories/quota";
import { getProviderCredential } from "@/src/server/repositories/providerCredentials";
import { getTenantSubscription, listActiveTenantSubscriptions } from "@/src/server/repositories/tenantSubscriptions";
import { getSubscriptionQuotaState, releaseSubscriptionQuota, settleSubscriptionQuota, SubscriptionQuotaCapacityError, type SubscriptionQuotaState } from "@/src/server/repositories/quotaAccounting";
import { reserveCostQuotaPolicies, subscriptionCostQuotaPolicies } from "@/src/server/services/quotaPolicy";
import type { ModelPriceSnapshot } from "@/src/server/services/modelPricing";
import { resolveConfiguredModelPrice } from "@/src/server/services/quotaAdministration";
import { getEffectiveQuotaBaselines, getQuotaOversellRatios, quotaSharesForPlan } from "@/src/server/services/quotaCalibration";

export interface TenantQuotaAdmission { requestId: string; tenantId: string; subscriptionId: string | null; units: number | null; unitsPerCredential: number | null; price: ModelPriceSnapshot | null; state: SubscriptionQuotaState | null; }

export function eligibleCredentialIdsForTenant(tenantId: string) { return [...new Set(listActiveTenantSubscriptions(tenantId).filter((item) => hasLocalCapacity(item)).map((item) => item.credentialId))]; }

export function subscriptionQuotaLimits(subscription: { units: number; unitsPerCredential: number; credentialId: string }) {
  const baselines = getEffectiveQuotaBaselines();
  const oversellRatios = getQuotaOversellRatios();
  const credential = getProviderCredential(subscription.credentialId);
  if (!credential || credential.provider !== "codex" || !baselines["5h"].effectiveNanoUsd || !baselines["7d"].effectiveNanoUsd) return null;
  const parentCapacityMultiplier = BigInt(quotaSharesForPlan(credential.planType));
  const fractionMilli = BigInt(Math.floor(subscription.units * 1_000_000 / subscription.unitsPerCredential));
  return Object.fromEntries((["5h", "7d"] as const).map((kind) => {
    const oversellMilli = BigInt(Math.round(oversellRatios[kind] * 1000));
    return [kind, baselines[kind].effectiveNanoUsd! * parentCapacityMultiplier * fractionMilli * oversellMilli / 1_000_000_000n];
  })) as Record<"5h" | "7d", bigint>;
}

export function admitTenantRequest(input: { tenantId: string; credentialId: string; requestId: string; model: string; now?: Date }): TenantQuotaAdmission {
  const price = resolveConfiguredModelPrice(input.model);
  const providerCredential = getProviderCredential(input.credentialId);
  if (!providerCredential) throw new HttpError(404, "credential_not_found", "Credential not found");
  const candidates = listActiveTenantSubscriptions(input.tenantId, input.now).filter((item) => item.credentialId === input.credentialId).sort((a, b) => b.priority - a.priority || availableRatio(b.id) - availableRatio(a.id));
  if (!candidates.length) throw new HttpError(403, "subscription_not_available", "No active subscription is assigned for the selected credential");
  if (providerCredential.provider === "grok") { const subscription = candidates[0]; return { requestId: input.requestId, tenantId: input.tenantId, subscriptionId: subscription.id, units: subscription.units, unitsPerCredential: subscription.unitsPerCredential, price, state: null }; }
  // Unknown prices must not turn into an outage. Keep the subscription association
  // for the request log, but defer monetary accounting until an admin sets a price.
  if (!price) {
    const subscription = candidates[0];
    return { requestId: input.requestId, tenantId: input.tenantId, subscriptionId: subscription.id, units: subscription.units, unitsPerCredential: subscription.unitsPerCredential, price: null, state: null };
  }
  const baselines = getEffectiveQuotaBaselines();
  if (!baselines["5h"].effectiveNanoUsd || !baselines["7d"].effectiveNanoUsd) throw new HttpError(503, "quota_baseline_unavailable", "Subscription capacity has not been calibrated or configured");
  const resetTimes = credentialResetTimes(input.credentialId);
  let capacityError: SubscriptionQuotaCapacityError | null = null;
  for (const subscription of candidates) {
    const limits = subscriptionQuotaLimits(subscription)!;
    const reserve = max(1n, min(10_000_000n, min(limits["5h"], limits["7d"]) / 100n));
    const now = input.now || new Date();
    try {
      const state = reserveCostQuotaPolicies({
        requestId: input.requestId,
        reserveNanoUsd: reserve,
        policies: subscriptionCostQuotaPolicies({
          subscriptionId: subscription.id,
          limits,
          resetsAt: resetTimes,
        }),
        now,
        expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
      });
      return { requestId: input.requestId, tenantId: input.tenantId, subscriptionId: subscription.id, units: subscription.units, unitsPerCredential: subscription.unitsPerCredential, price, state };
    } catch (error) { if (!(error instanceof SubscriptionQuotaCapacityError)) throw error; capacityError = error; }
  }
  const now = input.now || new Date(); const state = capacityError!.state;
  throw new HttpError(429, "subscription_quota_exceeded", `Subscription ${capacityError!.window} quota is exhausted.`, { type: "rate_limit_error", window: capacityError!.window, resets_at: state.resetsAt, retry_after: Math.max(1, Math.ceil((Date.parse(state.resetsAt) - now.getTime()) / 1000)) });
}

export const settleTenantRequest = settleSubscriptionQuota;
export const releaseTenantRequest = releaseSubscriptionQuota;
export function tenantQuotaHeaders(state: SubscriptionQuotaState) { const subscription = getTenantSubscription(state.subscriptionId); const headers: Record<string, string> = { "x-relay-subscription-id": state.subscriptionId, ...(subscription ? { "x-relay-subscription-units": `${subscription.units}/${subscription.unitsPerCredential}` } : {}) }; for (const kind of ["5h", "7d"] as const) { const window = state.windows[kind]; if (!window) continue; const used = window.settledNanoUsd + window.reservedNanoUsd; headers[`x-relay-quota-${kind}-limit-nanousd`] = String(window.limitNanoUsd); headers[`x-relay-quota-${kind}-used-nanousd`] = String(used); headers[`x-relay-quota-${kind}-reset`] = window.resetsAt; } return headers; }

function credentialResetTimes(credentialId: string) { const cache = getCodexQuotaCacheByCredentialId(credentialId); const windows = cache?.cache && typeof cache.cache === "object" ? (cache.cache as { windows?: Array<{ id?: string; resets_at?: string | null }> }).windows || [] : []; const five = windows.find((item) => item.id === "code-5h")?.resets_at; const seven = windows.find((item) => item.id === "code-7d")?.resets_at; if (!five || !seven) throw new HttpError(503, "credential_quota_not_cached", "Credential quota must be refreshed before its subscriptions can be used"); return { "5h": five, "7d": seven }; }
function availableRatio(id: string) { const state = getSubscriptionQuotaState(id); const values = ["5h", "7d"].map((kind) => state.windows[kind as "5h" | "7d"]).filter(Boolean).map((window) => Number(window.limitNanoUsd - window.settledNanoUsd - window.reservedNanoUsd) / Math.max(1, Number(window.limitNanoUsd))); return values.length ? Math.min(...values) : 1; }
function hasLocalCapacity(subscription: { id: string; units: number; unitsPerCredential: number; credentialId: string }) { const state = getSubscriptionQuotaState(subscription.id); const limits = subscriptionQuotaLimits(subscription); const windows = (["5h", "7d"] as const).map((kind) => ({ window: state.windows[kind], limit: limits?.[kind] })).filter((item) => item.window); return windows.length < 2 || windows.every(({ window, limit }) => window.resetsAt <= new Date().toISOString() || window.settledNanoUsd + window.reservedNanoUsd < (limit ?? window.limitNanoUsd)); }
function min(a: bigint, b: bigint) { return a < b ? a : b; } function max(a: bigint, b: bigint) { return a > b ? a : b; }

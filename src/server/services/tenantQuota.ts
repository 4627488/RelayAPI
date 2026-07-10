import "server-only";

import { HttpError } from "@/src/server/http/errors";
import { getCodexQuotaCacheByCredentialId } from "@/src/server/repositories/quota";
import { getCodexCredentialById } from "@/src/server/repositories/codexCredentials";
import { getTenantSubscription, listActiveTenantSubscriptions } from "@/src/server/repositories/tenantSubscriptions";
import { getSubscriptionQuotaState, releaseSubscriptionQuota, reserveSubscriptionQuota, settleSubscriptionQuota, SubscriptionQuotaCapacityError, type SubscriptionQuotaState } from "@/src/server/repositories/quotaAccounting";
import type { ModelPriceSnapshot } from "@/src/server/services/modelPricing";
import { resolveConfiguredModelPrice } from "@/src/server/services/quotaAdministration";
import { getEffectiveQuotaBaselines, getQuotaOversellRatios, quotaSharesForPlan } from "@/src/server/services/quotaCalibration";

export interface TenantQuotaAdmission { requestId: string; tenantId: string; subscriptionId: string | null; units: number | null; unitsPerCredential: number | null; price: ModelPriceSnapshot | null; state: SubscriptionQuotaState | null; }

export function eligibleCredentialIdsForTenant(tenantId: string) { return [...new Set(listActiveTenantSubscriptions(tenantId).filter((item) => hasLocalCapacity(item.id)).map((item) => item.credentialId))]; }

export function admitTenantRequest(input: { tenantId: string; credentialId: string; requestId: string; model: string; now?: Date }): TenantQuotaAdmission {
  const price = resolveConfiguredModelPrice(input.model);
  if (!price) throw new HttpError(503, "model_price_unavailable", `No price is configured for model ${input.model}`, { model: input.model });
  const baselines = getEffectiveQuotaBaselines();
  const oversellRatios = getQuotaOversellRatios();
  if (!baselines["5h"].effectiveNanoUsd || !baselines["7d"].effectiveNanoUsd) throw new HttpError(503, "quota_baseline_unavailable", "Subscription capacity has not been calibrated or configured");
  const resetTimes = credentialResetTimes(input.credentialId);
  const credential = getCodexCredentialById(input.credentialId);
  if (!credential) throw new HttpError(404, "codex_credential_not_found", "Credential not found");
  const parentCapacityMultiplier = BigInt(quotaSharesForPlan(credential.planType));
  const candidates = listActiveTenantSubscriptions(input.tenantId, input.now).filter((item) => item.credentialId === input.credentialId).sort((a, b) => b.priority - a.priority || availableRatio(b.id) - availableRatio(a.id));
  if (!candidates.length) throw new HttpError(403, "subscription_not_available", "No active subscription is assigned for the selected credential");
  let capacityError: SubscriptionQuotaCapacityError | null = null;
  for (const subscription of candidates) {
    const fractionMilli = BigInt(Math.floor(subscription.units * 1_000_000 / subscription.unitsPerCredential));
    const oversellMilli = { "5h": BigInt(Math.round(oversellRatios["5h"] * 1000)), "7d": BigInt(Math.round(oversellRatios["7d"] * 1000)) };
    const limits = { "5h": baselines["5h"].effectiveNanoUsd! * parentCapacityMultiplier * fractionMilli * oversellMilli["5h"] / 1_000_000_000n, "7d": baselines["7d"].effectiveNanoUsd! * parentCapacityMultiplier * fractionMilli * oversellMilli["7d"] / 1_000_000_000n };
    const reserve = max(1n, min(10_000_000n, min(limits["5h"], limits["7d"]) / 100n));
    const now = input.now || new Date();
    try {
      const state = reserveSubscriptionQuota({ requestId: input.requestId, subscriptionId: subscription.id, reserveNanoUsd: reserve, windows: { "5h": { limitNanoUsd: limits["5h"], resetsAt: resetTimes["5h"] }, "7d": { limitNanoUsd: limits["7d"], resetsAt: resetTimes["7d"] } }, now, expiresAt: new Date(now.getTime() + 30 * 60 * 1000) });
      return { requestId: input.requestId, tenantId: input.tenantId, subscriptionId: subscription.id, units: subscription.units, unitsPerCredential: subscription.unitsPerCredential, price, state };
    } catch (error) { if (!(error instanceof SubscriptionQuotaCapacityError)) throw error; capacityError = error; }
  }
  const now = input.now || new Date(); const state = capacityError!.state;
  throw new HttpError(429, "subscription_quota_exceeded", `Subscription ${capacityError!.window} quota is exhausted.`, { type: "rate_limit_error", window: capacityError!.window, resets_at: state.resetsAt, retry_after: Math.max(1, Math.ceil((Date.parse(state.resetsAt) - now.getTime()) / 1000)) });
}

export const settleTenantRequest = settleSubscriptionQuota;
export const releaseTenantRequest = releaseSubscriptionQuota;
export function tenantQuotaHeaders(state: SubscriptionQuotaState) { const subscription = getTenantSubscription(state.subscriptionId); const headers: Record<string, string> = { "x-relay-subscription-id": state.subscriptionId, ...(subscription ? { "x-relay-subscription-units": `${subscription.units}/${subscription.unitsPerCredential}` } : {}) }; for (const kind of ["5h", "7d"] as const) { const window = state.windows[kind]; if (!window) continue; const used = window.settledNanoUsd + window.reservedNanoUsd; headers[`x-relay-quota-${kind}-limit-nanousd`] = String(window.limitNanoUsd); headers[`x-relay-quota-${kind}-used-nanousd`] = String(used); headers[`x-relay-quota-${kind}-remaining-nanousd`] = String(max(0n, window.limitNanoUsd - used)); headers[`x-relay-quota-${kind}-reset`] = window.resetsAt; } return headers; }

function credentialResetTimes(credentialId: string) { const cache = getCodexQuotaCacheByCredentialId(credentialId); const windows = cache?.cache && typeof cache.cache === "object" ? (cache.cache as { windows?: Array<{ id?: string; resets_at?: string | null }> }).windows || [] : []; const five = windows.find((item) => item.id === "code-5h")?.resets_at; const seven = windows.find((item) => item.id === "code-7d")?.resets_at; if (!five || !seven) throw new HttpError(503, "credential_quota_not_cached", "Credential quota must be refreshed before its subscriptions can be used"); return { "5h": five, "7d": seven }; }
function availableRatio(id: string) { const state = getSubscriptionQuotaState(id); const values = ["5h", "7d"].map((kind) => state.windows[kind as "5h" | "7d"]).filter(Boolean).map((window) => Number(window.limitNanoUsd - window.settledNanoUsd - window.reservedNanoUsd) / Math.max(1, Number(window.limitNanoUsd))); return values.length ? Math.min(...values) : 1; }
function hasLocalCapacity(id: string) { const state = getSubscriptionQuotaState(id); const windows = [state.windows["5h"], state.windows["7d"]].filter(Boolean); return windows.length < 2 || windows.every((window) => window.resetsAt <= new Date().toISOString() || window.settledNanoUsd + window.reservedNanoUsd < window.limitNanoUsd); }
function min(a: bigint, b: bigint) { return a < b ? a : b; } function max(a: bigint, b: bigint) { return a > b ? a : b; }

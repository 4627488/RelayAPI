import "server-only";

import { HttpError } from "@/src/server/http/errors";
import { getSubscriptionCalibrationCost } from "@/src/server/repositories/logs";
import {
  calibrateSubscriptionQuota,
  getSubscriptionQuotaState,
  synchronizeSubscriptionQuotaWindows,
  type QuotaWindowKind,
} from "@/src/server/repositories/quotaAccounting";
import { getProviderCredential } from "@/src/server/repositories/providerCredentials";
import { getTenantSubscription } from "@/src/server/repositories/tenantSubscriptions";
import {
  getProviderQuota,
  providerCredentialSupportsQuota,
} from "@/src/server/services/providerQuota";

export type SubscriptionCalibrationTask = { subscriptionId: string; status: "idle" | "pending" | "running" | "completed" | "failed"; startedAt: string | null; completedAt: string | null; error: string | null; windows?: Record<"5h" | "7d", { startedAt: string; costNanoUsd: string; requestCount: number }> };
const tasks = new Map<string, SubscriptionCalibrationTask>();

export function getSubscriptionCalibrationTask(subscriptionId: string): SubscriptionCalibrationTask { return tasks.get(subscriptionId) || { subscriptionId, status: "idle", startedAt: null, completedAt: null, error: null }; }
export function scheduleSubscriptionCalibration(subscriptionId: string) {
  const current = getSubscriptionCalibrationTask(subscriptionId);
  if (current.status === "pending" || current.status === "running") return current;
  if (!getTenantSubscription(subscriptionId)) throw new HttpError(404, "subscription_not_found", "Subscription not found");
  const task: SubscriptionCalibrationTask = { subscriptionId, status: "pending", startedAt: null, completedAt: null, error: null };
  tasks.set(subscriptionId, task);
  const timer = setTimeout(() => void run(subscriptionId), 0); timer.unref?.();
  return task;
}
async function run(subscriptionId: string) {
  const subscription = getTenantSubscription(subscriptionId);
  if (!subscription) return;
  const startedAt = new Date().toISOString();
  tasks.set(subscriptionId, { subscriptionId, status: "running", startedAt, completedAt: null, error: null });
  try {
    await Promise.resolve();
    const now = new Date();
    const credential = getProviderCredential(subscription.credentialId);
    if (!credential) {
      throw new Error("Subscription credential was not found");
    }
    if (providerCredentialSupportsQuota(credential)) {
      await getProviderQuota(credential.provider, credential.id, {
        forceRefresh: true,
      });
    }
    advanceStaleCalibrationWindows(subscriptionId, now);
    const quotaState = getSubscriptionQuotaState(subscriptionId);
    const windows = Object.fromEntries((["5h", "7d"] as const).map((kind) => {
      const quotaWindow = quotaState.windows[kind];
      if (!quotaWindow) throw new Error(`Subscription ${kind} quota window has not been initialized`);
      const windowStartedAt = calibrationWindowStartedAt(kind, quotaWindow.resetsAt, now);
      const result = getSubscriptionCalibrationCost({ subscriptionId, tenantId: subscription.tenantId, credentialId: subscription.credentialId, startedAt: windowStartedAt, endedAt: now.toISOString() });
      return [kind, { startedAt: windowStartedAt, costNanoUsd: String(result.costNanoUsd), requestCount: result.requestCount }];
    })) as Record<"5h" | "7d", { startedAt: string; costNanoUsd: string; requestCount: number }>;
    calibrateSubscriptionQuota(subscriptionId, { "5h": { startedAt: windows["5h"].startedAt, settledNanoUsd: BigInt(windows["5h"].costNanoUsd) }, "7d": { startedAt: windows["7d"].startedAt, settledNanoUsd: BigInt(windows["7d"].costNanoUsd) } });
    tasks.set(subscriptionId, { subscriptionId, status: "completed", startedAt, completedAt: new Date().toISOString(), error: null, windows });
  } catch (error) { tasks.set(subscriptionId, { subscriptionId, status: "failed", startedAt, completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }); }
}

export function advanceStaleCalibrationWindows(
  subscriptionId: string,
  now = new Date(),
) {
  const state = getSubscriptionQuotaState(subscriptionId);
  const resetsAt = Object.fromEntries(
    (["5h", "7d"] as const).flatMap((kind) => {
      const window = state.windows[kind];
      if (!window || Date.parse(window.resetsAt) > now.getTime()) return [];
      return [[kind, nextCalibrationResetAt(kind, window.resetsAt, now)]];
    }),
  ) as Partial<Record<QuotaWindowKind, string>>;
  if (Object.keys(resetsAt).length > 0) {
    synchronizeSubscriptionQuotaWindows([subscriptionId], resetsAt, now);
  }
  return getSubscriptionQuotaState(subscriptionId);
}

export function nextCalibrationResetAt(
  kind: QuotaWindowKind,
  resetsAt: string,
  now: Date,
) {
  const resetAtMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetAtMs)) {
    throw new Error(`Subscription ${kind} quota window has an invalid reset time`);
  }
  const durationMs = windowDurationMs(kind);
  const periods = Math.max(
    1,
    Math.floor((now.getTime() - resetAtMs) / durationMs) + 1,
  );
  return new Date(resetAtMs + periods * durationMs).toISOString();
}

export function calibrationWindowStartedAt(kind: QuotaWindowKind, resetsAt: string, now: Date) {
  const resetAtMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetAtMs)) throw new Error(`Subscription ${kind} quota window has an invalid reset time`);
  if (resetAtMs <= now.getTime()) throw new Error(`Subscription ${kind} quota window is stale; refresh credential quota before calibrating`);
  return new Date(resetAtMs - windowDurationMs(kind)).toISOString();
}

function windowDurationMs(kind: QuotaWindowKind) {
  return kind === "5h" ? 5 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
}

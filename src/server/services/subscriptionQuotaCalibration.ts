import "server-only";

import { HttpError } from "@/src/server/http/errors";
import { getSubscriptionCalibrationCost } from "@/src/server/repositories/logs";
import { calibrateSubscriptionQuota } from "@/src/server/repositories/quotaAccounting";
import { getTenantSubscription } from "@/src/server/repositories/tenantSubscriptions";

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
    const windows = Object.fromEntries((["5h", "7d"] as const).map((kind) => {
      const duration = kind === "5h" ? 5 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
      const windowStartedAt = new Date(now.getTime() - duration).toISOString();
      const result = getSubscriptionCalibrationCost({ subscriptionId, tenantId: subscription.tenantId, credentialId: subscription.credentialId, startedAt: windowStartedAt, endedAt: now.toISOString() });
      return [kind, { startedAt: windowStartedAt, costNanoUsd: String(result.costNanoUsd), requestCount: result.requestCount }];
    })) as Record<"5h" | "7d", { startedAt: string; costNanoUsd: string; requestCount: number }>;
    calibrateSubscriptionQuota(subscriptionId, { "5h": { startedAt: windows["5h"].startedAt, settledNanoUsd: BigInt(windows["5h"].costNanoUsd) }, "7d": { startedAt: windows["7d"].startedAt, settledNanoUsd: BigInt(windows["7d"].costNanoUsd) } });
    tasks.set(subscriptionId, { subscriptionId, status: "completed", startedAt, completedAt: new Date().toISOString(), error: null, windows });
  } catch (error) { tasks.set(subscriptionId, { subscriptionId, status: "failed", startedAt, completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }); }
}

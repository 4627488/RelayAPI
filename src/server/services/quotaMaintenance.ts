import "server-only";

import { logServerError } from "@/src/server/http/errors";
import { reclaimExpiredQuotaReservations } from "@/src/server/repositories/quotaAccounting";
import { refreshLiteLlmPricing } from "@/src/server/services/quotaAdministration";
import { getCodexQuota } from "@/src/server/services/codexQuota";
import { listPublicCodexCredentials } from "@/src/server/services/codexCredentials";

const MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;
const PRICE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const QUOTA_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

type State = {
  running: boolean;
  lastPriceRefreshAt: number;
  lastQuotaRefreshAt: number;
  timer?: ReturnType<typeof setInterval>;
};

type GlobalState = typeof globalThis & { __relayQuotaMaintenance?: State };

export function startQuotaMaintenance() {
  const root = globalThis as GlobalState;
  if (root.__relayQuotaMaintenance) return;
  const state: State = { running: false, lastPriceRefreshAt: 0, lastQuotaRefreshAt: 0 };
  state.timer = setInterval(() => void runQuotaMaintenance(state), MAINTENANCE_INTERVAL_MS);
  state.timer.unref?.();
  root.__relayQuotaMaintenance = state;
  void runQuotaMaintenance(state);
}

export async function runQuotaMaintenance(state?: State) {
  const current = state || { running: false, lastPriceRefreshAt: 0, lastQuotaRefreshAt: 0 };
  if (current.running) return { skipped: true, reclaimed: 0, pricingRefreshed: false };
  current.running = true;
  let reclaimed = 0;
  let pricingRefreshed = false;
  try {
    reclaimed = reclaimExpiredQuotaReservations();
    if (Date.now() - current.lastQuotaRefreshAt >= QUOTA_REFRESH_INTERVAL_MS) {
      for (const credential of await listPublicCodexCredentials()) {
        if (!credential.enabled) continue;
        try {
          await getCodexQuota({ credentialId: credential.id, forceRefresh: true });
        } catch (error) {
          logServerError(error, {
            operation: "quota.calibration.maintenance",
            metadata: { credentialId: credential.id },
          });
        }
      }
      current.lastQuotaRefreshAt = Date.now();
    }
    if (Date.now() - current.lastPriceRefreshAt >= PRICE_REFRESH_INTERVAL_MS) {
      try {
        await refreshLiteLlmPricing();
        current.lastPriceRefreshAt = Date.now();
        pricingRefreshed = true;
      } catch (error) {
        logServerError(error, { operation: "quota.pricing.maintenance" });
      }
    }
    return { skipped: false, reclaimed, pricingRefreshed };
  } finally {
    current.running = false;
  }
}

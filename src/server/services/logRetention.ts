import "server-only";

import {
  pruneRequestLogs,
  type PruneRequestLogsResult,
} from "@/src/server/repositories/logs";
import {
  getSettingValue,
  upsertSettingValue,
} from "@/src/server/repositories/settings";
import { getRequestLogRetentionSettings } from "@/src/server/services/settings";

const LAST_AUTO_PRUNE_SETTING_KEY = "request_logs_last_auto_prune_at";
const AUTO_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const AUTO_PRUNE_IN_MEMORY_CHECK_INTERVAL_MS = 60 * 1000;

let lastInMemoryCheckAt = 0;
let autoPruneInFlight = false;

export function maybeAutoPruneRequestLogs(
  options: { force?: boolean; throwOnError?: boolean } = {},
): PruneRequestLogsResult | null {
  const now = Date.now();
  if (!options.force) {
    if (now - lastInMemoryCheckAt < AUTO_PRUNE_IN_MEMORY_CHECK_INTERVAL_MS) {
      return null;
    }
    lastInMemoryCheckAt = now;

    const lastAutoPruneAt = Date.parse(
      getSettingValue(LAST_AUTO_PRUNE_SETTING_KEY) || "",
    );
    if (
      Number.isFinite(lastAutoPruneAt) &&
      now - lastAutoPruneAt < AUTO_PRUNE_INTERVAL_MS
    ) {
      return null;
    }
  }

  if (autoPruneInFlight) {
    return null;
  }

  autoPruneInFlight = true;
  try {
    upsertSettingValue(
      LAST_AUTO_PRUNE_SETTING_KEY,
      new Date(now).toISOString(),
    );
    const settings = getRequestLogRetentionSettings();
    return pruneRequestLogs({
      summaryRetentionDays: settings.requestLogRetentionDays,
      detailRetentionDays: settings.requestLogDetailRetentionDays,
    });
  } catch (error) {
    if (options.throwOnError) {
      throw error;
    }
    console.warn("Automatic request log pruning failed", error);
    return null;
  } finally {
    autoPruneInFlight = false;
  }
}

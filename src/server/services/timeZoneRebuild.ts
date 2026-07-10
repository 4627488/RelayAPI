import "server-only";

import { rebuildDailyAggregates } from "@/src/server/repositories/logs";
import {
  getTimeZoneRebuildState,
  updateTimeZoneRebuildState,
} from "@/src/server/services/settings";

let scheduled = false;
let running: Promise<void> | null = null;

export function scheduleTimeZoneRebuild() {
  if (scheduled || running) {
    return;
  }
  scheduled = true;
  const timer = setTimeout(() => {
    scheduled = false;
    void runPendingTimeZoneRebuild();
  }, 0);
  timer.unref?.();
}

export function resumePendingTimeZoneRebuild() {
  const state = getTimeZoneRebuildState();
  if (
    state.timeZonePending &&
    (state.timeZoneRebuildStatus === "pending" ||
      state.timeZoneRebuildStatus === "running")
  ) {
    scheduleTimeZoneRebuild();
  }
}

export function runPendingTimeZoneRebuild() {
  if (running) {
    return running;
  }
  const task = runRebuild();
  running = task.finally(() => {
    running = null;
  });
  return running;
}

async function runRebuild() {
  const state = getTimeZoneRebuildState();
  const target = state.timeZonePending;
  if (!target) {
    return;
  }
  updateTimeZoneRebuildState({ status: "running" });
  try {
    await Promise.resolve();
    rebuildDailyAggregates(target);
    updateTimeZoneRebuildState({ status: "idle", activate: target });
  } catch (error) {
    try {
      rebuildDailyAggregates(state.timeZone);
    } catch {
      // The original rebuild transaction already rolled back on failure.
    }
    updateTimeZoneRebuildState({
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

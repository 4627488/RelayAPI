import "server-only";

import { getLogClient } from "@/src/server/db/sqlite";
import { getGlobalTimeZoneSetting } from "@/src/server/services/settings";
import type { ActivityHeatmapStats } from "@/src/shared/types/entities";
import { addDateKeyDays, instantToDateKey } from "@/src/shared/time";

const DEFAULT_HEATMAP_WEEKS = 53;
const MAX_HEATMAP_WEEKS = 53;

export interface ActivityHeatmapQueryInput {
  apiKeyId?: string | null;
  apiKeyName?: string | null;
  apiKeyPrefix?: string | null;
  endDate?: Date;
  weeks?: number;
}

export function getActivityHeatmapStats(
  input: ActivityHeatmapQueryInput = {},
): ActivityHeatmapStats {
  const weeks = normalizeWeeks(input.weeks);
  const endDateKey = instantToDateKey(input.endDate || new Date(), getGlobalTimeZoneSetting());
  const weekStart = addDateKeyDays(endDateKey, -weekday(endDateKey));
  const startDateKey = addDateKeyDays(weekStart, -(weeks - 1) * 7);
  const endExclusive = addDateKeyDays(endDateKey, 1);
  const apiKeyId = cleanString(input.apiKeyId);
  const conditions = ["started_at >= ?", "started_at < ?"];
  const params: string[] = [startDateKey, endExclusive];
  if (apiKeyId) {
    conditions.push("api_key_id = ?");
    params.push(apiKeyId);
  }

  const rows = getLogClient().prepare(
    `SELECT relay_date_key(started_at) AS date,
       COUNT(*) AS request_count,
       SUM(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END) AS success_count,
       SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS error_count,
       SUM(stream) AS stream_count,
       COALESCE(SUM(total_tokens), 0) AS total_tokens
     FROM request_logs
     WHERE ${conditions.join(" AND ")}
     GROUP BY relay_date_key(started_at)`,
  ).all(...params) as Array<Record<string, unknown>>;

  const rowsByDate = new Map(rows.map((row) => [String(row.date || ""), row]));
  const rawDays = Array.from({ length: weeks * 7 }, (_, index) => {
    const date = addDateKeyDays(startDateKey, index);
    if (date > endDateKey) return null;
    const row = rowsByDate.get(date);
    return {
      date,
      requestCount: numberValue(row?.request_count),
      successCount: numberValue(row?.success_count),
      errorCount: numberValue(row?.error_count),
      streamCount: numberValue(row?.stream_count),
      totalTokens: numberValue(row?.total_tokens),
      level: 0,
    };
  }).filter((day): day is ActivityHeatmapStats["days"][number] => Boolean(day));

  const maxRequests = Math.max(0, ...rawDays.map((day) => day.requestCount));
  const days = rawDays.map((day) => ({
    ...day,
    level: heatmapLevel(day.requestCount, maxRequests),
  }));
  const streaks = heatmapStreaks(days);

  return {
    generatedAt: new Date().toISOString(),
    scope: apiKeyId ? "api_key" : "site",
    apiKeyId: apiKeyId || null,
    apiKeyName: cleanString(input.apiKeyName),
    apiKeyPrefix: cleanString(input.apiKeyPrefix),
    from: startDateKey,
    to: endDateKey,
    weeks,
    days,
    totalRequests: days.reduce((total, day) => total + day.requestCount, 0),
    totalTokens: days.reduce((total, day) => total + day.totalTokens, 0),
    activeDays: days.filter((day) => day.requestCount > 0).length,
    maxRequests,
    currentStreakDays: streaks.current,
    longestStreakDays: streaks.longest,
  };
}

function normalizeWeeks(value: unknown) {
  const weeks = Number(value || DEFAULT_HEATMAP_WEEKS);
  return Number.isFinite(weeks)
    ? Math.max(1, Math.min(MAX_HEATMAP_WEEKS, Math.floor(weeks)))
    : DEFAULT_HEATMAP_WEEKS;
}

function heatmapLevel(count: number, max: number) {
  if (count <= 0 || max <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil(Math.sqrt(count / max) * 4)));
}

function heatmapStreaks(days: ActivityHeatmapStats["days"]) {
  let current = 0;
  let longest = 0;
  for (const day of days) {
    current = day.requestCount > 0 ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return { current, longest };
}

function weekday(dateKey: string) {
  return new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
}

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

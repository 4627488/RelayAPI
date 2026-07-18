import type { AdminDashboardRequestLogRow } from "@/lib/admin-api";

export type HourlyTrendPoint = {
  hour: string;
  requestCount: number;
  successRate: number;
  totalTokens: number;
  p95FirstTokenLatencyMs: number;
};

export function aggregateHourlyTrends(
  rows: AdminDashboardRequestLogRow[],
  now = Date.now(),
): HourlyTrendPoint[] {
  const hourMs = 60 * 60 * 1000;
  const currentHour = Math.floor(now / hourMs) * hourMs;

  return Array.from({ length: 24 }, (_, index) => {
    const startedAt = currentHour - (23 - index) * hourMs;
    const endedAt = startedAt + hourMs;
    const bucket = rows.filter((row) => {
      const value = Date.parse(row.started_at);
      return value >= startedAt && value < endedAt;
    });
    const successCount = bucket.filter(
      (row) => row.status_code >= 200 && row.status_code < 400,
    ).length;
    const firstTokenLatencies = bucket
      .map((row) => row.first_token_latency_ms)
      .filter((value): value is number => value !== null && value > 0)
      .sort((left, right) => left - right);

    return {
      hour: new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        hour12: false,
      }).format(startedAt),
      requestCount: bucket.length,
      successRate: bucket.length ? (successCount / bucket.length) * 100 : 0,
      totalTokens: bucket.reduce((total, row) => total + row.total_tokens, 0),
      p95FirstTokenLatencyMs: percentile(firstTokenLatencies, 0.95),
    };
  });
}

function percentile(values: number[], ratio: number) {
  if (!values.length) return 0;
  return values[Math.min(Math.ceil(values.length * ratio) - 1, values.length - 1)];
}

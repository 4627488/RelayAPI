"use client";

import * as React from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";
import {
  ActivityIcon,
  Clock3Icon,
  DatabaseIcon,
  GaugeIcon,
  ShieldCheckIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { HourlyTrendPoint } from "@/components/workspace/hourly-trends";
import {
  getDisplayTimeZone,
} from "@/components/workspace/format";
import { MetricStrip, MetricStripItem } from "@/components/workspace/metric-strip";
import {
  adminErrorMessage,
  type CostAnalysis,
} from "@/lib/admin-api";
import type {
  AdminOverviewStats,
  DailyUsageStatsRow,
  UsageStatsRow,
} from "@/src/shared/types/entities";
import { addDateKeyDays, instantToDateKey } from "@/src/shared/time";

type TrendDirection = "up" | "down" | "flat";
type TrendTone = "positive" | "negative" | "neutral";
type DailyUsageRow = AdminOverviewStats["byDay"][number];
type TrendPoint = { date: string; value: number };
type TrendMetricCardProps = {
  title: string;
  value: string;
  description: string;
  changeLabel: string;
  direction: TrendDirection;
  tone: TrendTone;
  data: TrendPoint[];
  icon: LucideIcon;
};

export function OverviewSection({
  apiKeyCount,
  channelCount,
  credentialCount,
  enabledChannelCount,
  hasOperationalData,
  overviewStats,
  costAnalysis,
  hourlyTrends,
  tenantCount,
  onRefresh,
}: {
  apiKeyCount: number;
  channelCount: number;
  credentialCount: number;
  enabledChannelCount: number;
  hasOperationalData: boolean;
  overviewStats: AdminOverviewStats;
  costAnalysis: CostAnalysis | null;
  hourlyTrends: HourlyTrendPoint[];
  tenantCount: number;
  onRefresh: (days?: number) => Promise<AdminOverviewStats>;
}) {
  const [refreshing, setRefreshing] = React.useState(false);
  const [overviewDays, setOverviewDays] = React.useState(
    String(overviewStats.range?.days || 30),
  );
  const trendMetrics = buildOverviewTrendMetrics(hourlyTrends);
  const topTenants = overviewStats.byTenant.slice(0, 5);
  const topModels = overviewStats.byModel.slice(0, 5);
  const recentDays = usageDateWindow(overviewStats.byDay, Number(overviewDays));
  async function changeOverviewDays(value: string) {
    if (!value || value === overviewDays) {
      return;
    }
    setOverviewDays(value);
    setRefreshing(true);
    try {
      await onRefresh(Number(value));
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="grid gap-6">
      {!hasOperationalData && (
        <Alert>
          <WorkflowIcon />
          <AlertTitle>暂无请求数据</AlertTitle>
          <AlertDescription>等待配置和请求。</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {trendMetrics.map((metric) => (
          <TrendMetricCard key={metric.title} {...metric} />
        ))}
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.65fr)_minmax(20rem,0.7fr)]">
        <DailyOperationsCard
          days={overviewDays}
          onDaysChange={changeOverviewDays}
          refreshing={refreshing}
          rows={recentDays}
        />
        <AnomalyRadarCard anomalies={overviewStats.anomalies} />
      </div>

      <BusinessStatusStrip
        costAnalysis={costAnalysis}
        stats={overviewStats}
        tenantCount={tenantCount}
      />

      <details className="group rounded-md border bg-card">
        <summary className="cursor-pointer list-none px-3 py-2.5 text-sm font-medium marker:hidden">
          深度分析
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            排行、每日矩阵与维度钻取
          </span>
        </summary>
        <div className="grid gap-4 border-t p-3">
          <MetricStrip className="md:grid-cols-3 xl:grid-cols-3">
            <MetricStripItem label="租户" value={formatNumber(tenantCount)} detail={`${formatNumber(apiKeyCount)} Key`} />
            <MetricStripItem label="Codex 凭据" value={formatNumber(credentialCount)} detail="已授权" />
            <MetricStripItem label="路由池" value={formatNumber(channelCount)} detail={`${formatNumber(enabledChannelCount)} 启用`} />
          </MetricStrip>
          <div className="grid gap-4 xl:grid-cols-3">
            <UsageListCard title="租户消耗排行" emptyTitle="暂无租户使用数据" rows={topTenants} />
            <UsageListCard title="模型排行" emptyTitle="暂无模型使用数据" rows={topModels} />
            <DailyUsageCard rows={recentDays} />
          </div>
        </div>
      </details>
    </div>
  );
}

type DailyTrendMetric =
  | "requests"
  | "tokens"
  | "errorRate"
  | "latency"
  | "cache"
  | "stream";

const DAILY_TREND_METRICS: Array<{ id: DailyTrendMetric; label: string }> = [
  { id: "requests", label: "请求" },
  { id: "tokens", label: "Token" },
  { id: "errorRate", label: "错误率" },
  { id: "latency", label: "延迟" },
  { id: "cache", label: "缓存" },
  { id: "stream", label: "流式" },
];

const dailyChartConfig = {
  requestCount: { label: "请求数", color: "var(--chart-1)" },
  errorCount: { label: "错误数", color: "var(--chart-5)" },
  totalTokens: { label: "Token", color: "var(--chart-2)" },
  errorRate: { label: "错误率", color: "var(--chart-5)" },
  avgLatencyMs: { label: "平均延迟", color: "var(--chart-3)" },
  cacheHitRate: { label: "缓存命中", color: "var(--chart-4)" },
  streamRate: { label: "流式占比", color: "var(--chart-1)" },
} satisfies ChartConfig;

function BusinessStatusStrip({
  costAnalysis,
  stats,
  tenantCount,
}: {
  costAnalysis: CostAnalysis | null;
  stats: AdminOverviewStats;
  tenantCount: number;
}) {
  const latest = usageDateWindow(stats.byDay, 2).at(-1);
  const errorRate = latest ? ratio(latest.errorCount, latest.requestCount) : null;
  const totalCost = costAnalysis?.totalCostNanoUsd ?? null;
  const perPersonCost = totalCost
    ? divideNanoUsd(totalCost, Math.max(tenantCount, 1))
    : null;
  const topCostModel = costAnalysis?.models[0];

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <SignalCard
        label="累计模型费用"
        value={formatUsd(totalCost)}
        detail={`${formatNumber(costAnalysis?.pricedRequests || 0)} 个已计价请求`}
        badge={<Badge variant="outline">USD</Badge>}
      />
      <SignalCard
        label="每人费用"
        value={formatUsd(perPersonCost)}
        detail={`按 ${formatNumber(Math.max(tenantCount, 1))} 个租户均摊`}
      />
      <SignalCard
        label="今日可用性"
        value={formatPercent(errorRate === null ? null : 100 - errorRate)}
        detail={`${formatNumber(latest?.errorCount || 0)} 个失败 / ${formatNumber(latest?.requestCount || 0)} 次请求`}
      />
      <SignalCard
        label="主要成本模型"
        value={topCostModel?.model || "-"}
        detail={topCostModel ? `${formatUsd(topCostModel.costNanoUsd)} · ${formatNumber(topCostModel.requestCount)} 次请求` : "暂无计价数据"}
      />
    </div>
  );
}

function SignalCard({
  badge,
  detail,
  label,
  value,
}: {
  badge?: React.ReactNode;
  detail: string;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <div className="text-xs text-muted-foreground">{label}</div>
        {badge && <CardAction>{badge}</CardAction>}
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </CardHeader>
    </Card>
  );
}

function DailyOperationsCard({
  days,
  onDaysChange,
  refreshing,
  rows,
}: {
  days: string;
  onDaysChange: (value: string) => Promise<void>;
  refreshing: boolean;
  rows: DailyUsageStatsRow[];
}) {
  const [metric, setMetric] = React.useState<DailyTrendMetric>("requests");
  const data = rows.map((row) => ({
    ...row,
    errorRate: ratio(row.errorCount, row.requestCount) || 0,
    streamRate: ratio(row.streamCount, row.requestCount) || 0,
  }));

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>区间运行趋势</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            {days} 天聚合，仅此区域受时间范围影响
          </p>
        </div>
        <CardAction className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            value={[days]}
            variant="outline"
            size="sm"
            disabled={refreshing}
            onValueChange={(value) => value[0] && void onDaysChange(String(value[0]))}
          >
            {["7", "14", "30", "90"].map((item) => (
              <ToggleGroupItem key={item} value={item}>
                {item} 天
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <ToggleGroup
            value={[metric]}
            variant="outline"
            size="sm"
            onValueChange={(value) =>
              value[0] && setMetric(value[0] as DailyTrendMetric)
            }
          >
            {DAILY_TREND_METRICS.map((item) => (
              <ToggleGroupItem key={item.id} value={item.id}>
                {item.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </CardAction>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <EmptyState
            icon={ActivityIcon}
            title="暂无趋势数据"
            description="等待请求。"
            compact
          />
        ) : (
          <ChartContainer
            config={dailyChartConfig}
            className="h-72 w-full aspect-auto"
            initialDimension={{ width: 900, height: 288 }}
          >
            {renderDailyTrendChart(metric, data)}
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

function renderDailyTrendChart(
  metric: DailyTrendMetric,
  data: Array<DailyUsageStatsRow & { errorRate: number; streamRate: number }>,
) {
  const common = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} />
      <YAxis tickLine={false} axisLine={false} width={48} />
      <ChartTooltip content={<ChartTooltipContent />} />
    </>
  );
  if (metric === "requests") {
    return (
      <BarChart data={data}>
        {common}
        <Bar dataKey="requestCount" fill="var(--color-requestCount)" radius={4} />
        <Bar dataKey="errorCount" fill="var(--color-errorCount)" radius={4} />
      </BarChart>
    );
  }
  if (metric === "tokens") {
    return (
      <AreaChart data={data}>
        {common}
        <Area
          dataKey="totalTokens"
          fill="var(--color-totalTokens)"
          fillOpacity={0.22}
          stroke="var(--color-totalTokens)"
          strokeWidth={2}
          type="monotone"
        />
      </AreaChart>
    );
  }
  const dataKey =
    metric === "errorRate"
      ? "errorRate"
      : metric === "latency"
        ? "avgLatencyMs"
        : metric === "cache"
          ? "cacheHitRate"
          : "streamRate";
  return (
    <LineChart data={data}>
      {common}
      <Line
        dataKey={dataKey}
        dot={false}
        stroke={`var(--color-${dataKey})`}
        strokeWidth={2.2}
        type="monotone"
      />
    </LineChart>
  );
}

function AnomalyRadarCard({
  anomalies,
}: {
  anomalies: AdminOverviewStats["anomalies"];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>阈值记录</CardTitle>
        <CardAction>
          <Badge variant={anomalies.length > 0 ? "destructive" : "secondary"}>
            {formatNumber(anomalies.length)} 项
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {anomalies.length === 0 ? (
          <EmptyState
            icon={ShieldCheckIcon}
            title="暂无记录"
            description="观察窗口内没有生成分析项。"
            compact
          />
        ) : (
          <div className="grid gap-3">
            {anomalies.map((item) => (
              <div
                key={item.id}
                className="grid gap-1 rounded-lg border border-border/60 p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium">{item.title}</div>
                  <Badge variant={anomalyBadgeVariant(item.severity)}>
                    {anomalySeverityLabel(item.severity)}
                  </Badge>
                </div>
                <div className="text-sm text-muted-foreground">
                  {item.description}
                </div>
                <div className="text-xs text-muted-foreground">
                  {item.date || item.targetName || item.metric}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function anomalyBadgeVariant(
  severity: AdminOverviewStats["anomalies"][number]["severity"],
) {
  return severity === "critical"
    ? "destructive"
    : severity === "warning"
      ? "outline"
      : "secondary";
}

function anomalySeverityLabel(
  severity: AdminOverviewStats["anomalies"][number]["severity"],
) {
  const labels: Record<
    AdminOverviewStats["anomalies"][number]["severity"],
    string
  > = {
    critical: "阈值 2",
    warning: "阈值 1",
    info: "信息",
  };
  return labels[severity];
}

function buildOverviewTrendMetrics(
  rows: HourlyTrendPoint[],
): TrendMetricCardProps[] {
  const current = rows.at(-1) ?? { hour: "-", requestCount: 0, successRate: 0, totalTokens: 0, p95FirstTokenLatencyMs: 0 };
  const previous = rows.at(-2) ?? current;
  const requestChange = percentChange(current.requestCount, previous.requestCount);
  const tokenChange = percentChange(current.totalTokens, previous.totalTokens);
  const latencyChange = percentChange(current.p95FirstTokenLatencyMs, previous.p95FirstTokenLatencyMs);
  const successPointChange = current.successRate - previous.successRate;
  const successDirection = directionFromDelta(successPointChange);
  const totalRequests = rows.reduce((sum, row) => sum + row.requestCount, 0);
  const totalTokens = rows.reduce((sum, row) => sum + row.totalTokens, 0);

  return [
    {
      title: "过去 24h 请求",
      value: formatCompactNumber(totalRequests),
      description: `当前小时 ${formatNumber(current.requestCount)} 次`,
      changeLabel: formatChangePercent(requestChange.value),
      direction: requestChange.direction,
      tone: directionTone(requestChange.direction),
      data: rows.map((row) => ({ date: row.hour, value: row.requestCount })),
      icon: ActivityIcon,
    },
    {
      title: "当前小时可用性",
      value: formatPercent(current.successRate),
      description: "折线展示过去 24 小时成功率",
      changeLabel: formatPointChange(successPointChange),
      direction: successDirection,
      tone: directionTone(successDirection),
      data: rows.map((row) => ({
        date: row.hour,
        value: row.successRate,
      })),
      icon: ShieldCheckIcon,
    },
    {
      title: "过去 24h Token",
      value: formatTokenNumber(totalTokens),
      description: `当前小时 ${formatTokenNumber(current.totalTokens)}`,
      changeLabel: formatChangePercent(tokenChange.value),
      direction: tokenChange.direction,
      tone: directionTone(tokenChange.direction),
      data: rows.map((row) => ({ date: row.hour, value: row.totalTokens })),
      icon: DatabaseIcon,
    },
    {
      title: "当前小时 P95 首 Token",
      value: formatDuration(current.p95FirstTokenLatencyMs),
      description: "折线展示过去 24 小时首 Token 延迟",
      changeLabel: formatChangePercent(latencyChange.value),
      direction: latencyChange.direction,
      tone: directionTone(latencyChange.direction, { lowerIsBetter: true }),
      data: rows.map((row) => ({
        date: row.hour,
        value: row.p95FirstTokenLatencyMs,
      })),
      icon: Clock3Icon,
    },
  ];
}

function usageDateWindow(rows: AdminOverviewStats["byDay"], days: number) {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const today = todayDateKey();
  return Array.from({ length: days }, (_, index) => {
    const date = addUtcDays(today, index - days + 1);
    return byDate.get(date) ?? emptyDailyUsageRow(date);
  });
}

function emptyDailyUsageRow(date: string): DailyUsageRow {
  return {
    date,
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    streamCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    cacheHitRate: 0,
    avgLatencyMs: 0,
    p95LatencyMs: 0,
    avgFirstTokenLatencyMs: 0,
    p95FirstTokenLatencyMs: 0,
    avgTokensPerRequest: 0,
    tokensPerSecond: 0,
  };
}

function todayDateKey() {
  return instantToDateKey(new Date(), getDisplayTimeZone());
}

function addUtcDays(dateKey: string, deltaDays: number) {
  return addDateKeyDays(dateKey, deltaDays);
}

function percentChange(current: number, previous: number) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) {
    return { value: 0, direction: "flat" as const };
  }
  if (previous === 0) {
    return {
      value: current > 0 ? 100 : 0,
      direction: current > 0 ? ("up" as const) : ("flat" as const),
    };
  }
  const value = ((current - previous) / Math.abs(previous)) * 100;
  return { value, direction: directionFromDelta(value) };
}

function directionFromDelta(value: number): TrendDirection {
  if (!Number.isFinite(value) || Math.abs(value) < 0.05) {
    return "flat";
  }
  return value > 0 ? "up" : "down";
}

function directionTone(
  direction: TrendDirection,
  options: { lowerIsBetter?: boolean } = {},
): TrendTone {
  if (direction === "flat") {
    return "neutral";
  }
  if (options.lowerIsBetter) {
    return direction === "down" ? "positive" : "negative";
  }
  return direction === "up" ? "positive" : "negative";
}

function formatChangePercent(value: number) {
  if (!Number.isFinite(value)) {
    return "0.0%";
  }
  return `${Math.abs(value).toFixed(1)}%`;
}

function formatPointChange(value: number) {
  if (!Number.isFinite(value)) {
    return "0.0pct";
  }
  return `${Math.abs(value).toFixed(1)}pct`;
}

function TrendMetricCard({
  title,
  value,
  description,
  changeLabel,
  direction,
  tone,
  data,
  icon: Icon,
}: TrendMetricCardProps) {
  const directionIcon =
    direction === "up" ? "↑" : direction === "down" ? "↓" : "→";
  const toneClasses: Record<TrendTone, string> = {
    positive: "text-emerald-600 dark:text-emerald-400",
    negative: "text-destructive",
    neutral: "text-muted-foreground",
  };

  return (
    <Card className="gap-1 overflow-hidden py-3">
      <CardHeader className="pb-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Icon className="size-3.5" />
              {title}
            </div>
            <CardTitle className="text-3xl leading-none font-semibold tracking-tight tabular-nums sm:text-4xl">
              {value}
            </CardTitle>
            <p className="truncate text-xs text-muted-foreground">
              {description}
            </p>
          </div>
          <div
            className={`shrink-0 text-sm font-semibold tabular-nums ${toneClasses[tone]}`}
          >
            {directionIcon} {changeLabel}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className={`h-10 w-full min-w-0 ${toneClasses[tone]}`}>
          <LineChart
            accessibilityLayer
            width={320}
            height={40}
            data={data}
            margin={{ top: 6, right: 4, bottom: 2, left: 4 }}
            className="h-10 w-full"
          >
            <Line
              type="monotone"
              dataKey="value"
              stroke="currentColor"
              strokeWidth={2.2}
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </div>
      </CardContent>
    </Card>
  );
}

function UsageListCard({
  title,
  emptyTitle,
  rows,
}: {
  title: string;
  emptyTitle: string;
  rows: UsageStatsRow[];
}) {
  const maxTokens = Math.max(...rows.map((row) => row.totalTokens), 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={GaugeIcon}
            title={emptyTitle}
            description="等待请求。"
            compact
          />
        ) : (
          <div className="grid gap-4">
            {rows.map((row, index) => (
              <UsageListRow
                key={`${row.key}:${index}`}
                maxTokens={maxTokens}
                row={row}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UsageListRow({
  maxTokens,
  row,
}: {
  maxTokens: number;
  row: UsageStatsRow;
}) {
  const progressValue = maxTokens > 0 ? (row.totalTokens / maxTokens) * 100 : 0;

  return (
    <div className="grid gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium">
            {row.label || row.key || "-"}
          </div>
          <div className="text-xs text-muted-foreground">
            {formatNumber(row.requestCount)} 次请求 ·{" "}
            {formatNumber(row.errorCount)} 个错误
          </div>
        </div>
        <div className="text-right text-sm font-medium tabular-nums">
          {formatTokenNumber(row.totalTokens)}
          <div className="text-xs font-normal text-muted-foreground">
            tokens
          </div>
        </div>
      </div>
      <Progress value={clamp(progressValue, 0, 100)} />
    </div>
  );
}

function DailyUsageCard({ rows }: { rows: AdminOverviewStats["byDay"] }) {
  const maxTokens = Math.max(...rows.map((row) => row.totalTokens), 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>每日用量</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={ActivityIcon}
            title="暂无每日统计"
            description="等待请求。"
            compact
          />
        ) : (
          <div className="grid gap-4">
            {rows.map((row) => {
              const progressValue =
                maxTokens > 0 ? (row.totalTokens / maxTokens) * 100 : 0;
              return (
                <div key={row.date} className="grid gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-medium">{row.date}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatNumber(row.requestCount)} 次请求 ·{" "}
                        {formatNumber(row.errorCount)} 个错误
                      </div>
                    </div>
                    <div className="text-sm font-medium tabular-nums">
                      {formatTokenNumber(row.totalTokens)}
                    </div>
                  </div>
                  <Progress value={clamp(progressValue, 0, 100)} />
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyState({
  compact = false,
  description,
  icon: Icon,
  title,
}: {
  compact?: boolean;
  description: string;
  icon: LucideIcon;
  title: string;
}) {
  return (
    <Empty className={compact ? "min-h-36" : "min-h-64"}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function formatDuration(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 ms";
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
}

function formatCompactNumber(value: number) {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: value >= 1000 ? 1 : 0,
    notation: "compact",
  }).format(value);
}

function formatTokenNumber(value: number) {
  if (!Number.isFinite(value)) return "0";
  const absValue = Math.abs(value);
  if (absValue >= 1_000_000_000) return `${formatScaledNumber(value / 1_000_000_000)}B`;
  if (absValue >= 1_000_000) return `${formatScaledNumber(value / 1_000_000)}M`;
  if (absValue >= 1_000) return `${formatScaledNumber(value / 1_000)}K`;
  return formatNumber(value);
}

function formatScaledNumber(value: number) {
  const absValue = Math.abs(value);
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: absValue >= 100 ? 0 : absValue >= 10 ? 1 : 2,
    minimumFractionDigits: 0,
  }).format(value);
}

function formatPercent(value: number | null) {
  return value === null || !Number.isFinite(value) ? "-" : `${value.toFixed(1)}%`;
}

function divideNanoUsd(value: string, divisor: number) {
  return divisor ? (BigInt(value) / BigInt(divisor)).toString() : value;
}

function formatUsd(value: string | null) {
  if (!value) return "$0.00";
  const amount = Number(BigInt(value)) / 1_000_000_000;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: amount < 1 ? 4 : 2,
    maximumFractionDigits: amount < 1 ? 4 : 2,
  }).format(amount);
}

function ratio(numerator: number, denominator: number) {
  return denominator ? (numerator / denominator) * 100 : null;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

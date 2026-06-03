"use client";

import * as React from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  ActivityIcon,
  KeyRoundIcon,
  NetworkIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";

import { LimitLine } from "@/components/dashboard/limit-line";
import {
  formatNumber,
  formatRatioPercent,
  formatTokenNumber,
} from "@/components/dashboard/format";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type {
  AdminOverviewStats,
  ApiKeyDailyUsageStatsRow,
  ApiKeyUsageStatsRow,
  DailyUsageStatsRow,
  PublicTenant,
  UsageStatsRow,
} from "@/src/shared/types/entities";

type SpendPeriod = "day" | "week" | "month";
type KeyFilter = "all" | string;

const spendChartConfig = {
  totalTokens: {
    label: "Token 开销",
    color: "var(--chart-1)",
  },
  cachedTokens: {
    label: "缓存 Token",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

const modelChartConfig = {
  totalTokens: {
    label: "Token",
    color: "var(--chart-3)",
  },
} satisfies ChartConfig;

const pieColors = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export function TenantOverviewSection({
  stats,
  tenant,
}: {
  stats: AdminOverviewStats;
  tenant: PublicTenant;
}) {
  const [periodValue, setPeriodValue] = React.useState<SpendPeriod[]>(["day"]);
  const [keyFilter, setKeyFilter] = React.useState<KeyFilter>("all");
  const period = periodValue[0] || "day";
  const totals = stats.totals;
  const filteredStats = React.useMemo(
    () => scopedStats(stats, keyFilter),
    [stats, keyFilter],
  );
  const spendRows = React.useMemo(
    () => aggregateSpendRows(filteredStats.byDay, period),
    [filteredStats.byDay, period],
  );
  const topKeys = stats.byApiKey.slice(0, 8);
  const topModels = filteredStats.byModel.slice(0, 6);
  const selectedKey =
    keyFilter === "all"
      ? null
      : stats.byApiKey.find((row) => row.apiKeyId === keyFilter) || null;
  const cacheHitRate = totals.cacheHitRate;
  const selectedCacheHitRate = filteredStats.totals.cacheHitRate;
  const tenantLimitValue = tenant.tokenLimitDaily
    ? Math.round((tenant.todayTokens / tenant.tokenLimitDaily) * 100)
    : 0;

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <TenantMetricCard
          title="今日 Token"
          value={formatTokenNumber(tenant.todayTokens)}
          description={
            tenant.tokenLimitDaily
              ? `每日上限 ${formatTokenNumber(tenant.tokenLimitDaily)}`
              : "管理员未设置每日 token 上限"
          }
          icon={NetworkIcon}
        />
        <TenantMetricCard
          title="成功率"
          value={formatRatioPercent(totals.successCount, totals.requestCount)}
          description={`${formatNumber(totals.successCount)} 成功 / ${formatNumber(totals.requestCount)} 请求`}
          icon={ShieldCheckIcon}
        />
        <TenantMetricCard
          title="缓存命中率"
          value={formatPercent(cacheHitRate)}
          description={`${formatTokenNumber(totals.cachedTokens)} 缓存 token / ${formatTokenNumber(totals.promptTokens)} 输入 token`}
          icon={SparklesIcon}
        />
        <TenantMetricCard
          title="活跃 Key"
          value={formatNumber(totals.distinctApiKeyCount)}
          description={`${formatNumber(tenant.enabledApiKeyCount)} 个启用 / ${formatNumber(tenant.apiKeyCount)} 个总 Key`}
          icon={KeyRoundIcon}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(20rem,0.85fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Token 开销趋势</CardTitle>
            <CardDescription>
              按日、周、月查看当前租户的 token 消耗和缓存贡献。
            </CardDescription>
            <CardAction className="flex flex-wrap items-center gap-2">
              <Select
                value={keyFilter}
                onValueChange={(value) => setKeyFilter(value || "all")}
              >
                <SelectTrigger size="sm" className="min-w-36">
                  <SelectValue placeholder="全部 Key" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">全部 Key</SelectItem>
                    {stats.byApiKey
                      .filter((row) => row.apiKeyId)
                      .map((row) => (
                        <SelectItem key={row.apiKeyId} value={row.apiKeyId || ""}>
                          {row.apiKeyName}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <ToggleGroup
                value={periodValue}
                onValueChange={(value) => {
                  if (value[0]) {
                    setPeriodValue([value[0] as SpendPeriod]);
                  }
                }}
                size="sm"
                variant="outline"
              >
                <ToggleGroupItem value="day">日</ToggleGroupItem>
                <ToggleGroupItem value="week">周</ToggleGroupItem>
                <ToggleGroupItem value="month">月</ToggleGroupItem>
              </ToggleGroup>
            </CardAction>
          </CardHeader>
          <CardContent>
            {spendRows.length === 0 ? (
              <TenantEmptyState
                title="暂无开销趋势"
                description="产生请求后会按时间窗口汇总 token 开销。"
              />
            ) : (
              <ChartContainer
                config={spendChartConfig}
                className="h-80 w-full"
                initialDimension={{ width: 760, height: 320 }}
              >
                <AreaChart data={spendRows} margin={{ left: 8, right: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                  />
                  <YAxis hide domain={[0, "dataMax"]} />
                  <ChartTooltip
                    cursor={false}
                    content={
                      <ChartTooltipContent
                        formatter={(value, name) => (
                          <>
                            <span className="text-muted-foreground">
                              {spendLabel(String(name))}
                            </span>
                            <span className="font-mono font-medium tabular-nums">
                              {formatTokenNumber(Number(value))}
                            </span>
                          </>
                        )}
                      />
                    }
                  />
                  <Area
                    dataKey="totalTokens"
                    type="monotone"
                    fill="var(--color-totalTokens)"
                    fillOpacity={0.24}
                    stroke="var(--color-totalTokens)"
                    strokeWidth={2}
                    isAnimationActive={false}
                  />
                  <Area
                    dataKey="cachedTokens"
                    type="monotone"
                    fill="var(--color-cachedTokens)"
                    fillOpacity={0.16}
                    stroke="var(--color-cachedTokens)"
                    strokeWidth={2}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>额度与效率</CardTitle>
            <CardDescription>
              关注今日额度压力、缓存命中率和所选 key 的表现。
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <div className="grid gap-3">
              <LimitLine
                label="Key 数"
                value={tenant.apiKeyCount}
                limit={tenant.maxApiKeys}
              />
              <LimitLine
                label="今日 token"
                value={tenant.todayTokens}
                limit={tenant.tokenLimitDaily}
              />
              <LimitLine
                label="每分钟请求"
                value={0}
                limit={tenant.rateLimitPerMinute}
                hideValue
              />
            </div>
            {tenant.tokenLimitDaily && (
              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium">今日额度使用</span>
                  <span className="text-muted-foreground">
                    {formatPercent(tenantLimitValue)}
                  </span>
                </div>
                <Progress value={clamp(tenantLimitValue, 0, 100)} />
              </div>
            )}
            <div className="grid gap-3 rounded-md border bg-muted/20 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium">
                    {selectedKey ? selectedKey.apiKeyName : "全部 Key"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    当前筛选维度
                  </div>
                </div>
                <Badge variant="outline">
                  缓存 {formatPercent(selectedCacheHitRate)}
                </Badge>
              </div>
              <div className="grid gap-2 text-sm">
                <MetricLine
                  label="请求"
                  value={formatNumber(filteredStats.totals.requestCount)}
                />
                <MetricLine
                  label="Token"
                  value={formatTokenNumber(filteredStats.totals.totalTokens)}
                />
                <MetricLine
                  label="平均延迟"
                  value={formatDuration(filteredStats.totals.avgLatencyMs)}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ApiKeyPerformanceCard rows={topKeys} />
        <ModelUsageCard rows={topModels} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <CacheBreakdownCard stats={filteredStats} />
        <RecentSpendTable rows={spendRows} period={period} />
      </div>
    </div>
  );
}

function TenantMetricCard({
  description,
  icon: Icon,
  title,
  value,
}: {
  description: string;
  icon: React.ComponentType;
  title: string;
  value: string;
}) {
  return (
    <Card className="bg-card/95">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
          <Icon />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        <div className="text-2xl font-semibold tracking-tight tabular-nums">
          {value}
        </div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

function ApiKeyPerformanceCard({ rows }: { rows: ApiKeyUsageStatsRow[] }) {
  const maxTokens = Math.max(...rows.map((row) => row.totalTokens), 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Key 表现</CardTitle>
        <CardDescription>
          面向接入管理：每个 key 的 token、成功率、缓存命中率和今日额度。
        </CardDescription>
        <CardAction>
          <Badge variant="outline">{formatNumber(rows.length)} 个 Key</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <TenantEmptyState
            title="暂无 Key 数据"
            description="创建 key 并调用后，这里会显示 key 级别表现。"
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>成功率</TableHead>
                <TableHead>缓存</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>今日上限</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.apiKeyId || row.key}>
                  <TableCell>
                    <div className="font-medium">{row.apiKeyName}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {row.apiKeyPrefix || row.apiKeyId || "-"}
                    </div>
                  </TableCell>
                  <TableCell>
                    {formatRatioPercent(row.successCount, row.requestCount)}
                  </TableCell>
                  <TableCell>{formatPercent(row.cacheHitRate)}</TableCell>
                  <TableCell>
                    <div className="grid min-w-32 gap-1">
                      <div className="flex justify-between gap-3 text-sm">
                        <span>{formatTokenNumber(row.totalTokens)}</span>
                        <span className="text-muted-foreground">
                          {formatNumber(row.requestCount)} 请求
                        </span>
                      </div>
                      <Progress
                        value={maxTokens > 0 ? (row.totalTokens / maxTokens) * 100 : 0}
                      />
                    </div>
                  </TableCell>
                  <TableCell>
                    <DailyKeyLimit row={row} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function ModelUsageCard({ rows }: { rows: UsageStatsRow[] }) {
  const chartRows = rows.map((row) => ({
    name: row.label || row.key,
    totalTokens: row.totalTokens,
  }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>模型消耗</CardTitle>
        <CardDescription>
          当前筛选范围内，哪些模型贡献了主要 token 开销。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <TenantEmptyState
            title="暂无模型数据"
            description="请求产生后会按模型聚合 token 消耗。"
          />
        ) : (
          <ChartContainer
            config={modelChartConfig}
            className="h-72 w-full"
            initialDimension={{ width: 620, height: 288 }}
          >
            <BarChart data={chartRows} layout="vertical" margin={{ left: 8 }}>
              <CartesianGrid horizontal={false} />
              <XAxis type="number" hide />
              <YAxis
                dataKey="name"
                type="category"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                width={132}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    formatter={(value) => (
                      <span className="font-mono font-medium tabular-nums">
                        {formatTokenNumber(Number(value))}
                      </span>
                    )}
                  />
                }
              />
              <Bar
                dataKey="totalTokens"
                fill="var(--color-totalTokens)"
                radius={4}
                isAnimationActive={false}
              />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

function CacheBreakdownCard({ stats }: { stats: AdminOverviewStats }) {
  const promptOnly = Math.max(stats.totals.promptTokens - stats.totals.cachedTokens, 0);
  const rows = [
    { name: "缓存命中", value: stats.totals.cachedTokens },
    { name: "输入未命中", value: promptOnly },
    { name: "输出", value: stats.totals.completionTokens },
  ].filter((row) => row.value > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>缓存命中率</CardTitle>
        <CardDescription>
          将输入 token 中已缓存的部分单独展示，方便观察复用效率。
        </CardDescription>
        <CardAction>
          <Badge variant="secondary">{formatPercent(stats.totals.cacheHitRate)}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <TenantEmptyState
            title="暂无缓存数据"
            description="产生带 usage 的请求后会展示缓存命中率。"
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
            <ChartContainer
              config={{ value: { label: "Token" } }}
              className="mx-auto h-56 w-full max-w-60"
              initialDimension={{ width: 240, height: 224 }}
            >
              <PieChart>
                <Pie
                  data={rows}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={54}
                  outerRadius={88}
                  paddingAngle={2}
                  isAnimationActive={false}
                >
                  {rows.map((row, index) => (
                    <Cell
                      key={row.name}
                      fill={pieColors[index % pieColors.length]}
                    />
                  ))}
                </Pie>
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={(value, name) => (
                        <>
                          <span className="text-muted-foreground">
                            {String(name)}
                          </span>
                          <span className="font-mono font-medium tabular-nums">
                            {formatTokenNumber(Number(value))}
                          </span>
                        </>
                      )}
                    />
                  }
                />
              </PieChart>
            </ChartContainer>
            <div className="grid content-center gap-3">
              {rows.map((row, index) => (
                <div key={row.name} className="grid gap-1">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex items-center gap-2">
                      <span
                        className="size-2 rounded-sm"
                        style={{ backgroundColor: pieColors[index % pieColors.length] }}
                      />
                      {row.name}
                    </span>
                    <span className="font-medium tabular-nums">
                      {formatTokenNumber(row.value)}
                    </span>
                  </div>
                  <Progress
                    value={
                      stats.totals.totalTokens > 0
                        ? (row.value / stats.totals.totalTokens) * 100
                        : 0
                    }
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RecentSpendTable({
  period,
  rows,
}: {
  period: SpendPeriod;
  rows: SpendRow[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{periodLabel(period)}开销明细</CardTitle>
        <CardDescription>
          最近窗口内每个时间段的请求、错误、token 和缓存命中率。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <TenantEmptyState
            title="暂无开销明细"
            description="产生请求后会展示分时统计。"
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>请求</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>缓存</TableHead>
                <TableHead>延迟</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows
                .slice()
                .reverse()
                .slice(0, 8)
                .map((row) => (
                  <TableRow key={row.key}>
                    <TableCell className="font-medium">{row.label}</TableCell>
                    <TableCell>
                      <div>{formatNumber(row.requestCount)}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatNumber(row.errorCount)} 错误
                      </div>
                    </TableCell>
                    <TableCell>{formatTokenNumber(row.totalTokens)}</TableCell>
                    <TableCell>{formatPercent(row.cacheHitRate)}</TableCell>
                    <TableCell>{formatDuration(row.avgLatencyMs)}</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function DailyKeyLimit({ row }: { row: ApiKeyUsageStatsRow }) {
  if (!row.tokenLimitDaily) {
    return <span className="text-muted-foreground">不限制</span>;
  }
  return (
    <div className="grid min-w-28 gap-1">
      <div className="flex justify-between gap-3 text-xs">
        <span>{formatTokenNumber(row.todayTokens)}</span>
        <span className="text-muted-foreground">
          {formatTokenNumber(row.tokenLimitDaily)}
        </span>
      </div>
      <Progress value={clamp(row.tokenLimitUtilization || 0, 0, 100)} />
    </div>
  );
}

function MetricLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

function TenantEmptyState({
  description,
  title,
}: {
  description: string;
  title: string;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ActivityIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function scopedStats(stats: AdminOverviewStats, keyFilter: KeyFilter) {
  if (keyFilter === "all") {
    return stats;
  }
  const keyRows = stats.byApiKey.filter((row) => row.apiKeyId === keyFilter);
  const modelRows = stats.byApiKeyModel
    .filter((row) => row.apiKeyId === keyFilter)
    .map((row) => ({
      ...row,
      key: row.model || row.key,
      label: row.model || "未知模型",
      subLabel: row.apiKeyName,
    }));
  return {
    ...stats,
    totals: aggregateUsageTotals(keyRows),
    byDay: dailyRowsForKey(stats.byApiKeyDay, keyFilter),
    byModel: modelRows,
  };
}

function dailyRowsForKey(rows: ApiKeyDailyUsageStatsRow[], apiKeyId: string) {
  const filtered = rows.filter((row) => row.apiKeyId === apiKeyId);
  const byDate = new Map(filtered.map((row) => [row.date, row]));
  return filtered.map((row) => toDailyUsageRow(byDate.get(row.date) || row));
}

function toDailyUsageRow(row: ApiKeyDailyUsageStatsRow): DailyUsageStatsRow {
  return {
    date: row.date,
    requestCount: row.requestCount,
    successCount: row.successCount,
    errorCount: row.errorCount,
    streamCount: row.streamCount,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    totalTokens: row.totalTokens,
    cachedTokens: row.cachedTokens,
    cacheHitRate: row.cacheHitRate,
    avgLatencyMs: row.avgLatencyMs,
    p95LatencyMs: row.p95LatencyMs,
    avgFirstTokenLatencyMs: row.avgFirstTokenLatencyMs,
    p95FirstTokenLatencyMs: row.p95FirstTokenLatencyMs,
    avgTokensPerRequest: row.avgTokensPerRequest,
    tokensPerSecond: row.tokensPerSecond,
  };
}
function aggregateUsageTotals(rows: UsageStatsRow[]) {
  const requestCount = sum(rows, "requestCount");
  const successCount = sum(rows, "successCount");
  const promptTokens = sum(rows, "promptTokens");
  const totalTokens = sum(rows, "totalTokens");
  const cachedTokens = sum(rows, "cachedTokens");
  return {
    requestCount,
    successCount,
    errorCount: sum(rows, "errorCount"),
    streamCount: sum(rows, "streamCount"),
    promptTokens,
    completionTokens: sum(rows, "completionTokens"),
    totalTokens,
    cachedTokens,
    cacheHitRate: promptTokens > 0 ? (cachedTokens / promptTokens) * 100 : 0,
    avgLatencyMs: weightedAverage(rows, "avgLatencyMs"),
    p95LatencyMs: Math.max(...rows.map((row) => row.p95LatencyMs), 0),
    avgFirstTokenLatencyMs: weightedAverage(rows, "avgFirstTokenLatencyMs"),
    p95FirstTokenLatencyMs: Math.max(
      ...rows.map((row) => row.p95FirstTokenLatencyMs),
      0,
    ),
    avgTokensPerRequest:
      requestCount > 0 ? Math.round((totalTokens / requestCount) * 100) / 100 : 0,
    tokensPerSecond: sum(rows, "tokensPerSecond"),
    distinctApiKeyCount: rows.filter((row) => row.key).length,
    distinctModelCount: 0,
    distinctChannelCount: 0,
    firstRequestAt: earliest(rows.map((row) => row.firstRequestAt)),
    lastRequestAt: latest(rows.map((row) => row.lastRequestAt)),
  };
}

type SpendRow = {
  key: string;
  label: string;
  requestCount: number;
  successCount: number;
  errorCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheHitRate: number;
  avgLatencyMs: number;
};

function aggregateSpendRows(rows: DailyUsageStatsRow[], period: SpendPeriod) {
  const orderedRows = rows.slice().reverse();
  const groups = new Map<string, SpendRow & { latencyTotal: number }>();
  for (const row of orderedRows) {
    const key = periodKey(row.date, period);
    const existing =
      groups.get(key) ||
      ({
        key,
        label: periodDisplayLabel(key, period),
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        cacheHitRate: 0,
        avgLatencyMs: 0,
        latencyTotal: 0,
      } satisfies SpendRow & { latencyTotal: number });
    existing.requestCount += row.requestCount;
    existing.successCount += row.successCount;
    existing.errorCount += row.errorCount;
    existing.promptTokens += row.promptTokens;
    existing.completionTokens += row.completionTokens;
    existing.totalTokens += row.totalTokens;
    existing.cachedTokens += row.cachedTokens;
    existing.latencyTotal += row.avgLatencyMs * row.requestCount;
    groups.set(key, existing);
  }
  return [...groups.values()].map(({ latencyTotal, ...row }) => ({
    ...row,
    cacheHitRate:
      row.promptTokens > 0 ? (row.cachedTokens / row.promptTokens) * 100 : 0,
    avgLatencyMs:
      row.requestCount > 0 ? Math.round(latencyTotal / row.requestCount) : 0,
  }));
}

function periodKey(dateKey: string, period: SpendPeriod) {
  if (period === "day") {
    return dateKey;
  }
  if (period === "month") {
    return dateKey.slice(0, 7);
  }
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function periodDisplayLabel(key: string, period: SpendPeriod) {
  if (period === "week") {
    return `${key} 周`;
  }
  if (period === "month") {
    return key;
  }
  return key.slice(5);
}

function periodLabel(period: SpendPeriod) {
  return period === "day" ? "每日" : period === "week" ? "每周" : "每月";
}

function spendLabel(name: string) {
  return name === "cachedTokens" ? "缓存 Token" : "Token 开销";
}

function formatPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "0%";
  }
  return `${value.toFixed(1)}%`;
}

function formatDuration(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "-";
  }
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function sum<T extends UsageStatsRow>(rows: T[], key: keyof UsageStatsRow) {
  return rows.reduce((total, row) => total + Number(row[key] || 0), 0);
}

function weightedAverage(rows: UsageStatsRow[], key: keyof UsageStatsRow) {
  const totalWeight = sum(rows, "requestCount");
  if (totalWeight <= 0) {
    return 0;
  }
  return Math.round(
    rows.reduce(
      (total, row) => total + Number(row[key] || 0) * row.requestCount,
      0,
    ) / totalWeight,
  );
}

function earliest(values: Array<string | null>) {
  return values.filter(Boolean).sort()[0] || null;
}

function latest(values: Array<string | null>) {
  return values.filter(Boolean).sort().at(-1) || null;
}

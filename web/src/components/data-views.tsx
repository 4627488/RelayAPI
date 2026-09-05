import { useState, type ReactNode } from "react"
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Activity01Icon,
  CircleDollarSignIcon,
  Clock03Icon,
  Coins01Icon,
  TriangleAlertIcon,
} from "@hugeicons/core-free-icons"

import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { StatStrip } from "@/components/workspace-ui"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { RequestLog, UsageReport } from "@/lib/api"
import { routeHref, type Workspace } from "@/lib/routes"
import {
  compact,
  compactTokens,
  dateTime,
  money,
  requestLogStatus,
  requestLogSucceeded,
} from "@/lib/format"
import { CacheHitRateBadge } from "@/components/token-cache-rate"

interface Metric {
  label: string
  value: string
  hint: string
  icon: typeof Activity01Icon
}

export function MetricGrid({ items }: { items: Metric[] }) {
  return (
    <StatStrip
      className="sm:grid-cols-2 xl:grid-cols-4"
      items={items.map((item) => ({
        label: item.label,
        value: item.value,
        detail: item.hint,
        icon: item.icon,
      }))}
    />
  )
}

const chartConfig = {
  requests: { label: "请求", color: "var(--chart-2)" },
  tokens: { label: "Tokens", color: "var(--chart-4)" },
} satisfies ChartConfig

export function UsageChart({ report }: { report: UsageReport }) {
  const daily = report.daily ?? []
  const [metric, setMetric] = useState<"requests" | "tokens">("requests")
  const metricLabel = metric === "requests" ? "请求数" : "Token 数"
  return (
    <Card>
      <CardHeader className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-start">
        <div>
          <CardTitle>用量趋势</CardTitle>
          <CardDescription>
            最近 {report.days} 天，当前显示单位：{metricLabel}。
          </CardDescription>
        </div>
        <ToggleGroup
          value={[metric]}
          onValueChange={(value) =>
            value[0] && setMetric(value[0] as "requests" | "tokens")
          }
          variant="outline"
          size="sm"
          aria-label="选择用量趋势指标"
        >
          <ToggleGroupItem value="requests">请求</ToggleGroupItem>
          <ToggleGroupItem value="tokens">Tokens</ToggleGroupItem>
        </ToggleGroup>
      </CardHeader>
      <CardContent>
        {daily.length ? (
          <ChartContainer config={chartConfig} className="h-52 w-full sm:h-56">
            <AreaChart data={daily} accessibilityLayer>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={10}
                tickFormatter={(value: string) => value.slice(5)}
              />
              <ChartTooltip
                content={<ChartTooltipContent indicator="line" />}
              />
              <Area
                dataKey={metric}
                name={metricLabel}
                type="monotone"
                fill={`var(--color-${metric})`}
                fillOpacity={0.12}
                stroke={`var(--color-${metric})`}
                strokeWidth={2}
              />
            </AreaChart>
          </ChartContainer>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon strokeWidth={2} icon={Activity01Icon} />
              </EmptyMedia>
              <EmptyTitle>暂无用量</EmptyTitle>
              <EmptyDescription>
                发起第一次模型请求后，趋势会显示在这里。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </CardContent>
    </Card>
  )
}

export function ModelTable({ report }: { report: UsageReport }) {
  const models = report.models ?? []
  return (
    <Card>
      <CardHeader>
        <CardTitle>模型分布</CardTitle>
        <CardDescription>按 Token 消耗排序。</CardDescription>
      </CardHeader>
      <CardContent>
        {models.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>模型</TableHead>
                <TableHead className="text-right">请求</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">费用</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((model) => (
                <TableRow key={model.model}>
                  <TableCell className="font-mono text-xs">
                    {model.model || "未识别"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {compact(model.requests)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {compactTokens(model.tokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(model.cost_nano_usd)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon strokeWidth={2} icon={Coins01Icon} />
              </EmptyMedia>
              <EmptyTitle>没有模型数据</EmptyTitle>
              <EmptyDescription>当前时间范围内没有请求。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </CardContent>
    </Card>
  )
}

export function ApiKeyUsageTable({
  report,
  showTenant = false,
}: {
  report: UsageReport
  showTenant?: boolean
}) {
  const apiKeys = report.api_keys ?? []
  return (
    <Card>
      <CardHeader>
        <CardTitle>Key 用量</CardTitle>
        <CardDescription>
          按 Token 消耗排序，统计最近 {report.days} 天仍在请求日志中的数据。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {apiKeys.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                {showTenant ? <TableHead>用户</TableHead> : null}
                <TableHead>Key</TableHead>
                <TableHead className="text-right">请求</TableHead>
                <TableHead className="text-right">错误</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">费用</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apiKeys.map((apiKey) => (
                <TableRow
                  key={`${apiKey.api_key_id}-${apiKey.api_key_name}-${apiKey.api_key_prefix}`}
                >
                  {showTenant ? (
                    <TableCell>{apiKey.tenant_name || "未知用户"}</TableCell>
                  ) : null}
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <span className="font-medium">
                        {apiKey.api_key_name || "已删除的 Key"}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {apiKey.api_key_prefix || "未知前缀"}…
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {compact(apiKey.requests)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {compact(apiKey.errors)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {compactTokens(apiKey.tokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(apiKey.cost_nano_usd)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon strokeWidth={2} icon={Coins01Icon} />
              </EmptyMedia>
              <EmptyTitle>没有 Key 用量</EmptyTitle>
              <EmptyDescription>
                当前时间范围内没有 API Key 请求。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </CardContent>
    </Card>
  )
}

export function LogsTable({
  logs,
  action,
  workspace = "user",
}: {
  logs: RequestLog[]
  action?: ReactNode
  workspace?: Workspace
}) {
  return (
    <Card>
      <CardHeader className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-start">
        <div>
          <CardTitle>最近请求</CardTitle>
          <CardDescription>状态、模型、Token 和响应耗时。</CardDescription>
        </div>
        {action}
      </CardHeader>
      <CardContent>
        {logs.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>客户端</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">耗时</TableHead>
                <TableHead className="text-right">费用</TableHead>
                <TableHead className="text-right">详情</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="text-muted-foreground">
                    {dateTime(log.started_at)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        requestLogSucceeded(log.status_code, log.error_code)
                          ? "secondary"
                          : "destructive"
                      }
                    >
                      {requestLogStatus(log.status_code)}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-52 truncate font-mono text-xs">
                    {log.model || log.path}
                  </TableCell>
                  <TableCell
                    className="max-w-44 truncate text-xs"
                    title={log.user_agent || undefined}
                  >
                    {[log.client_name, log.client_version]
                      .filter(Boolean)
                      .join(" ") || "未知客户端"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <span className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap">
                      <span>{compactTokens(log.total_tokens)}</span>
                      <CacheHitRateBadge
                        cachedTokens={log.cached_tokens}
                        promptTokens={log.prompt_tokens}
                      />
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {log.latency_ms} ms
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(log.cost_nano_usd)}
                  </TableCell>
                  <TableCell className="text-right">
                    <a
                      className="text-sm text-primary underline-offset-4 hover:underline focus-visible:underline"
                      aria-label={`查看日志 ${log.model || log.path} ${dateTime(log.started_at)}`}
                      href={routeHref({
                        workspace,
                        page: "logs",
                        logId: log.id,
                      })}
                    >
                      查看
                    </a>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon strokeWidth={2} icon={Clock03Icon} />
              </EmptyMedia>
              <EmptyTitle>暂无请求记录</EmptyTitle>
              <EmptyDescription>API 调用记录会显示在这里。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </CardContent>
    </Card>
  )
}

export function UsageMetrics({ report }: { report: UsageReport }) {
  return (
    <MetricGrid
      items={[
        {
          label: "请求",
          value: compact(report.summary.requests),
          hint: `最近 ${report.days} 天`,
          icon: Activity01Icon,
        },
        {
          label: "Tokens",
          value: compactTokens(report.summary.tokens),
          hint: "输入与输出合计",
          icon: Coins01Icon,
        },
        {
          label: "错误",
          value: compact(report.summary.errors),
          hint: "HTTP 错误或中断",
          icon: TriangleAlertIcon,
        },
        {
          label: "模型成本",
          value: money(report.summary.cost_nano_usd),
          hint: `订阅承担 ${money(report.summary.subscription_covered_nano_usd)} · 余额支付 ${money(report.summary.balance_charged_nano_usd)}`,
          icon: CircleDollarSignIcon,
        },
      ]}
    />
  )
}

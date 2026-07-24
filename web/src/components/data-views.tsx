import { Area, AreaChart, CartesianGrid, XAxis } from "recharts"
import {
  ActivityIcon,
  CircleDollarSignIcon,
  Clock3Icon,
  CoinsIcon,
  TriangleAlertIcon,
} from "lucide-react"

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
import type { RequestLog, UsageReport } from "@/lib/api"
import { compact, dateTime, money } from "@/lib/format"

interface Metric {
  label: string
  value: string
  hint: string
  icon: typeof ActivityIcon
}

export function MetricGrid({ items }: { items: Metric[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => (
        <Card key={item.label}>
          <CardHeader className="flex-row items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <CardDescription>{item.label}</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{item.value}</CardTitle>
            </div>
            <div className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <item.icon className="size-4" />
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">{item.hint}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

const chartConfig = {
  requests: { label: "请求", color: "var(--chart-2)" },
  tokens: { label: "Tokens", color: "var(--chart-4)" },
} satisfies ChartConfig

export function UsageChart({ report }: { report: UsageReport }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>用量趋势</CardTitle>
        <CardDescription>最近 {report.days} 天的请求与 Token 消耗。</CardDescription>
      </CardHeader>
      <CardContent>
        {report.daily.length ? (
          <ChartContainer config={chartConfig} className="h-72 w-full">
            <AreaChart data={report.daily} accessibilityLayer>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={10}
                tickFormatter={(value: string) => value.slice(5)}
              />
              <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
              <Area
                dataKey="tokens"
                type="monotone"
                fill="var(--color-tokens)"
                fillOpacity={0.12}
                stroke="var(--color-tokens)"
                strokeWidth={2}
              />
              <Area
                dataKey="requests"
                type="monotone"
                fill="var(--color-requests)"
                fillOpacity={0.12}
                stroke="var(--color-requests)"
                strokeWidth={2}
              />
            </AreaChart>
          </ChartContainer>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon"><ActivityIcon /></EmptyMedia>
              <EmptyTitle>暂无用量</EmptyTitle>
              <EmptyDescription>发起第一次模型请求后，趋势会显示在这里。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </CardContent>
    </Card>
  )
}

export function ModelTable({ report }: { report: UsageReport }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>模型分布</CardTitle>
        <CardDescription>按 Token 消耗排序。</CardDescription>
      </CardHeader>
      <CardContent>
        {report.models.length ? (
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
              {report.models.map((model) => (
                <TableRow key={model.model}>
                  <TableCell className="font-mono text-xs">{model.model || "未识别"}</TableCell>
                  <TableCell className="text-right tabular-nums">{compact(model.requests)}</TableCell>
                  <TableCell className="text-right tabular-nums">{compact(model.tokens)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(model.cost_nano_usd)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon"><CoinsIcon /></EmptyMedia>
              <EmptyTitle>没有模型数据</EmptyTitle>
              <EmptyDescription>当前时间范围内没有请求。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </CardContent>
    </Card>
  )
}

export function LogsTable({ logs }: { logs: RequestLog[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>最近请求</CardTitle>
        <CardDescription>状态、模型、Token 和响应耗时。</CardDescription>
      </CardHeader>
      <CardContent>
        {logs.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>模型</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">耗时</TableHead>
                <TableHead className="text-right">费用</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="text-muted-foreground">{dateTime(log.started_at)}</TableCell>
                  <TableCell>
                    <Badge variant={log.status_code >= 200 && log.status_code < 400 ? "secondary" : "destructive"}>
                      {log.status_code || "中断"}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-52 truncate font-mono text-xs">{log.model || log.path}</TableCell>
                  <TableCell className="text-right tabular-nums">{compact(log.total_tokens)}</TableCell>
                  <TableCell className="text-right tabular-nums">{log.latency_ms} ms</TableCell>
                  <TableCell className="text-right tabular-nums">{money(log.cost_nano_usd)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon"><Clock3Icon /></EmptyMedia>
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
        { label: "请求", value: compact(report.summary.requests), hint: `最近 ${report.days} 天`, icon: ActivityIcon },
        { label: "Tokens", value: compact(report.summary.tokens), hint: "输入与输出合计", icon: CoinsIcon },
        { label: "错误", value: compact(report.summary.errors), hint: "HTTP 错误或中断", icon: TriangleAlertIcon },
        { label: "费用", value: money(report.summary.cost_nano_usd), hint: "仅统计已配置价格模型", icon: CircleDollarSignIcon },
      ]}
    />
  )
}

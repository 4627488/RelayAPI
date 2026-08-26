import type { ReactNode } from "react"
import { Area, AreaChart, CartesianGrid, Tooltip, XAxis } from "recharts"
import { Button } from "@astryxdesign/core/Button"
import { EmptyState } from "@astryxdesign/core/EmptyState"
import { VStack } from "@astryxdesign/core/Layout"
import { Table, pixel, proportional } from "@astryxdesign/core/Table"
import { Text } from "@astryxdesign/core/Text"

import {
  ChartFrame,
  MetricStrip,
  PageSection,
  StatusLabel,
  useChartColors,
} from "@/components/page-kit"
import { CacheHitRateBadge } from "@/components/token-cache-rate"
import type { RequestLog, UsageReport } from "@/lib/api"
import {
  compact,
  compactTokens,
  dateTime,
  money,
  requestLogStatus,
  requestLogSucceeded,
} from "@/lib/format"

export function UsageMetrics({ report }: { report: UsageReport }) {
  const summary = report.summary
  return (
    <MetricStrip
      items={[
        {
          label: "请求",
          value: compact(summary.requests),
          hint: `${summary.errors} 个错误`,
        },
        {
          label: "Tokens",
          value: compactTokens(summary.tokens),
          hint: `${compactTokens(summary.cached_tokens)} 缓存命中`,
        },
        {
          label: "错误",
          value: compact(summary.errors),
          hint: summary.requests
            ? `${((summary.errors / summary.requests) * 100).toFixed(1)}%`
            : "—",
        },
        {
          label: "模型成本",
          value: money(summary.cost_nano_usd),
          hint: `订阅 ${money(summary.subscription_covered_nano_usd)} · 余额 ${money(summary.balance_charged_nano_usd)}`,
        },
      ]}
    />
  )
}

export function MetricGrid({
  items,
}: {
  items: Array<{ label: string; value: ReactNode; hint?: ReactNode }>
}) {
  return <MetricStrip items={items} />
}

export function UsageChart({ report }: { report: UsageReport }) {
  const colors = useChartColors()
  const daily = report.daily ?? []
  return (
    <PageSection title="用量趋势" dividers={["bottom"]}>
      {daily.length ? (
        <ChartFrame>
          <AreaChart data={daily}>
            <CartesianGrid vertical={false} stroke={colors.border} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={10}
              tick={{ fill: colors.text }}
              tickFormatter={(value: string) => value.slice(5)}
            />
            <Tooltip
              contentStyle={{
                background: colors.surface,
                border: `1px solid ${colors.border}`,
              }}
            />
            <Area
              type="monotone"
              dataKey="requests"
              name="请求"
              stroke={colors.accent}
              fill={colors.accent}
              fillOpacity={0.12}
            />
            <Area
              type="monotone"
              dataKey="tokens"
              name="Tokens"
              stroke={colors.muted}
              fill={colors.muted}
              fillOpacity={0.08}
            />
          </AreaChart>
        </ChartFrame>
      ) : (
        <EmptyState isCompact title="暂无用量" />
      )}
    </PageSection>
  )
}

interface LogRow extends Record<string, unknown> {
  id: string
  started_at: string
  status: string
  ok: boolean
  model: string
  client: string
  tokens: number
  latency: number
  cost: number | null
}

export function LogsTable({
  logs,
  action,
}: {
  logs: RequestLog[]
  action?: ReactNode
}) {
  const rows: LogRow[] = logs.map((log) => ({
    id: log.id,
    started_at: log.started_at,
    status: requestLogStatus(log.status_code),
    ok: requestLogSucceeded(log.status_code, log.error_code),
    model: log.actual_model || log.model,
    client: log.client_name || "未知客户端",
    tokens: log.total_tokens,
    latency: log.latency_ms,
    cost: log.cost_nano_usd,
  }))

  return (
    <VStack gap={0}>
      <PageSection
        title="最近请求"
        actions={action}
        padding={5}
        dividers={["bottom"]}
      />
      {rows.length ? (
        <Table
          data={rows}
          idKey="id"
          density="compact"
          hasHover
          textOverflow="truncate"
          columns={[
            {
              key: "started_at",
              header: "时间",
              width: pixel(140),
              renderCell: (row) => (
                <Text type="supporting">{dateTime(row.started_at)}</Text>
              ),
            },
            {
              key: "status",
              header: "状态",
              width: pixel(100),
              renderCell: (row) => (
                <StatusLabel
                  tone={row.ok ? "success" : "error"}
                  label={row.status}
                />
              ),
            },
            { key: "model", header: "模型", width: proportional(1) },
            { key: "client", header: "客户端", width: proportional(1) },
            {
              key: "tokens",
              header: "Tokens",
              width: pixel(100),
              align: "end",
              renderCell: (row) => <Text>{compactTokens(row.tokens)}</Text>,
            },
            {
              key: "latency",
              header: "耗时",
              width: pixel(90),
              align: "end",
              renderCell: (row) => <Text>{row.latency} ms</Text>,
            },
            {
              key: "cost",
              header: "费用",
              width: pixel(100),
              align: "end",
              renderCell: (row) => <Text>{money(row.cost)}</Text>,
            },
          ]}
        />
      ) : (
        <EmptyState isCompact title="暂无请求记录" />
      )}
    </VStack>
  )
}

export function LogsTableAction({ onOpen }: { onOpen: () => void }) {
  return <Button label="全部日志" variant="ghost" size="sm" onClick={onOpen} />
}

export { CacheHitRateBadge }

import { useEffect, useRef, useState, type ReactNode } from "react"
import { Area, AreaChart, CartesianGrid, Tooltip, XAxis } from "recharts"
import { EmptyState } from "@astryxdesign/core/EmptyState"
import { Grid } from "@astryxdesign/core/Grid"
import { HStack, VStack } from "@astryxdesign/core/Layout"
import { ProgressBar } from "@astryxdesign/core/ProgressBar"
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl"
import { Selector } from "@astryxdesign/core/Selector"
import { Table, pixel, proportional } from "@astryxdesign/core/Table"
import { Text } from "@astryxdesign/core/Text"
import { useToast } from "@astryxdesign/core/Toast"

import { LoadErrorView } from "@/components/load-error-view"
import { LoadingView } from "@/components/loading-view"
import {
  ChartFrame,
  MetricStrip,
  PageFrame,
  PageSection,
  useChartColors,
} from "@/components/page-kit"
import { CacheHitRateBadge } from "@/components/token-cache-rate"
import { api, type UsageReport, type User } from "@/lib/api"
import { cacheHitRateLabel, compact, compactTokens, money } from "@/lib/format"

type Period = 7 | 30 | 90 | 365
type TrendMetric = "requests" | "tokens" | "cost"
type Dimension = "users" | "models" | "keys"

const periods: Array<{ value: Period; label: string }> = [
  { value: 7, label: "7 天" },
  { value: 30, label: "30 天" },
  { value: 90, label: "90 天" },
  { value: 365, label: "1 年" },
]

function percent(value: number, total: number) {
  if (!Number.isFinite(total) || total <= 0) return "—"
  return `${((Math.max(0, value) / total) * 100).toFixed(1)}%`
}

function successRate(errors: number, requests: number) {
  if (!requests) return "—"
  return percent(Math.max(0, requests - errors), requests)
}

function averageCost(cost: number, requests: number) {
  return requests > 0 ? money(cost / requests) : "—"
}

function TokenBreakdown({ report }: { report: UsageReport }) {
  const summary = report.summary
  const items = [
    ["输入", summary.prompt_tokens],
    ["输出", summary.completion_tokens],
    ["缓存读取", summary.cached_tokens],
    ["缓存写入", summary.cache_write_tokens],
    ["推理", summary.reasoning_tokens],
  ] as const
  const imageTokens = summary.image_input_tokens + summary.image_output_tokens
  return (
    <PageSection title="Token 结构" dividers={["bottom"]}>
      <VStack gap={3}>
        {items.map(([label, value]) => (
          <ProgressBar
            key={label}
            label={label}
            value={summary.tokens > 0 ? (Math.max(0, value) / summary.tokens) * 100 : 0}
            hasValueLabel
            formatValueLabel={() => compactTokens(value)}
          />
        ))}
        {imageTokens > 0 ? (
          <ProgressBar
            label="图像输入与输出"
            value={
              summary.tokens > 0
                ? (Math.max(0, imageTokens) / summary.tokens) * 100
                : 0
            }
            hasValueLabel
            formatValueLabel={() => compactTokens(imageTokens)}
          />
        ) : null}
      </VStack>
    </PageSection>
  )
}

function CostBreakdown({ report }: { report: UsageReport }) {
  const summary = report.summary
  const total = summary.cost_nano_usd
  const covered = summary.subscription_covered_nano_usd
  const charged = summary.balance_charged_nano_usd
  return (
    <PageSection title="费用来源" dividers={["bottom"]}>
      <VStack gap={4}>
        <ProgressBar
          label="订阅承担"
          value={total > 0 ? (Math.max(0, covered) / total) * 100 : 0}
          hasValueLabel
          formatValueLabel={() => `${money(covered)} · ${percent(covered, total)}`}
        />
        <ProgressBar
          label="余额支付"
          value={total > 0 ? (Math.max(0, charged) / total) * 100 : 0}
          variant="neutral"
          hasValueLabel
          formatValueLabel={() => `${money(charged)} · ${percent(charged, total)}`}
        />
        <HStack hAlign="between" gap={3}>
          <Text color="secondary">单次请求平均成本</Text>
          <Text weight="semibold">{averageCost(total, summary.requests)}</Text>
        </HStack>
      </VStack>
    </PageSection>
  )
}

function UsageTrend({ report }: { report: UsageReport }) {
  const colors = useChartColors()
  const [metric, setMetric] = useState<TrendMetric>("requests")
  const data = report.daily.map((item) => ({
    ...item,
    cost_usd: item.cost_nano_usd / 1_000_000_000,
  }))
  return (
    <PageSection
      title="趋势"
      dividers={["bottom"]}
      actions={
        <SegmentedControl
          label="趋势指标"
          size="sm"
          value={metric}
          onChange={(value) => setMetric(value as TrendMetric)}
        >
          <SegmentedControlItem value="requests" label="请求" />
          <SegmentedControlItem value="tokens" label="Token" />
          <SegmentedControlItem value="cost" label="费用" />
        </SegmentedControl>
      }
    >
      {data.length ? (
        <ChartFrame>
          <AreaChart data={data}>
            <CartesianGrid vertical={false} stroke={colors.border} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={10}
              minTickGap={24}
              tick={{ fill: colors.text }}
              tickFormatter={(value: string) => value.slice(5)}
            />
            <Tooltip
              contentStyle={{
                background: colors.surface,
                border: `1px solid ${colors.border}`,
              }}
            />
            {metric === "requests" ? (
              <>
                <Area
                  dataKey="requests"
                  name="请求"
                  type="monotone"
                  fill={colors.accent}
                  fillOpacity={0.12}
                  stroke={colors.accent}
                />
                <Area
                  dataKey="errors"
                  name="错误"
                  type="monotone"
                  fill={colors.error}
                  fillOpacity={0.08}
                  stroke={colors.error}
                />
              </>
            ) : metric === "tokens" ? (
              <>
                <Area
                  dataKey="tokens"
                  name="Tokens"
                  type="monotone"
                  fill={colors.accent}
                  fillOpacity={0.12}
                  stroke={colors.accent}
                />
                <Area
                  dataKey="cached_tokens"
                  name="缓存命中"
                  type="monotone"
                  fill={colors.muted}
                  fillOpacity={0.08}
                  stroke={colors.muted}
                />
              </>
            ) : (
              <Area
                dataKey="cost_usd"
                name="费用"
                type="monotone"
                fill={colors.accent}
                fillOpacity={0.12}
                stroke={colors.accent}
              />
            )}
          </AreaChart>
        </ChartFrame>
      ) : (
        <EmptyState isCompact title="当前范围内没有用量" />
      )}
    </PageSection>
  )
}

interface AttributionRow extends Record<string, unknown> {
  id: string
  name: string
  detail?: string
  requests: number
  errors: number
  tokens: number
  cached_tokens?: number
  prompt_tokens?: number
  cost: number
}

function DimensionTable({
  report,
  dimension,
}: {
  report: UsageReport
  dimension: Dimension
}) {
  const rows: AttributionRow[] =
    dimension === "users"
      ? report.users.map((item) => ({
          id: item.tenant_id,
          name: item.tenant_name || "未知用户",
          requests: item.requests,
          errors: item.errors,
          tokens: item.tokens,
          cost: item.cost_nano_usd,
        }))
      : dimension === "models"
        ? report.models.map((item) => ({
            id: item.model || "unknown",
            name: item.model || "未识别",
            requests: item.requests,
            errors: item.errors,
            tokens: item.tokens,
            cached_tokens: item.cached_tokens,
            prompt_tokens: item.prompt_tokens,
            cost: item.cost_nano_usd,
          }))
        : report.api_keys.map((item) => ({
            id: `${item.api_key_id}-${item.api_key_prefix}`,
            name: item.api_key_name || "已删除的 Key",
            detail: `${item.api_key_prefix || "未知"}…`,
            requests: item.requests,
            errors: item.errors,
            tokens: item.tokens,
            cost: item.cost_nano_usd,
          }))

  return (
    <Table
      data={rows}
      idKey="id"
      density="compact"
      hasHover
      columns={[
        {
          key: "name",
          header: dimension === "users" ? "用户" : dimension === "models" ? "模型" : "API Key",
          width: proportional(1),
          renderCell: (row) =>
            row.detail ? (
              <VStack gap={0}>
                <Text>{row.name}</Text>
                <Text type="code" color="secondary">
                  {row.detail}
                </Text>
              </VStack>
            ) : (
              <Text type={dimension === "models" ? "code" : undefined}>
                {row.name}
              </Text>
            ),
        },
        ...(dimension === "keys"
          ? [
              {
                key: "tenant",
                header: "用户",
                width: pixel(140),
                renderCell: (row: AttributionRow) => (
                  <Text color="secondary">
                    {report.api_keys.find(
                      (item) => `${item.api_key_id}-${item.api_key_prefix}` === row.id
                    )?.tenant_name || "—"}
                  </Text>
                ),
              },
            ]
          : []),
        {
          key: "requests",
          header: "请求",
          width: pixel(90),
          align: "end" as const,
          renderCell: (row: AttributionRow) => <Text>{compact(row.requests)}</Text>,
        },
        {
          key: "success",
          header: "成功率",
          width: pixel(90),
          align: "end" as const,
          renderCell: (row: AttributionRow) => (
            <Text>{successRate(row.errors, row.requests)}</Text>
          ),
        },
        ...(dimension === "models"
          ? [
              {
                key: "cache",
                header: "缓存率",
                width: pixel(110),
                align: "end" as const,
                renderCell: (row: AttributionRow) => (
                  <CacheHitRateBadge
                    cachedTokens={row.cached_tokens ?? 0}
                    promptTokens={row.prompt_tokens ?? 0}
                  />
                ),
              },
            ]
          : []),
        {
          key: "tokens",
          header: "Token 占比",
          width: pixel(160),
          renderCell: (row: AttributionRow) => (
            <ProgressBar
              label={`${row.name} Token 占比`}
              isLabelHidden
              value={
                report.summary.tokens > 0
                  ? Math.min(100, (row.tokens / report.summary.tokens) * 100)
                  : 0
              }
              hasValueLabel
              formatValueLabel={() =>
                `${compactTokens(row.tokens)} · ${percent(row.tokens, report.summary.tokens)}`
              }
            />
          ),
        },
        {
          key: "cost",
          header: "费用",
          width: pixel(110),
          align: "end" as const,
          renderCell: (row: AttributionRow) => <Text>{money(row.cost)}</Text>,
        },
      ]}
    />
  )
}

export function UsageView({
  initialReport,
  admin = false,
  users: initialUsers = [],
  accessory,
}: {
  initialReport?: UsageReport
  admin?: boolean
  users?: User[]
  accessory?: ReactNode
}) {
  const toast = useToast()
  const [report, setReport] = useState<UsageReport | null>(initialReport ?? null)
  const [users, setUsers] = useState(initialUsers)
  const [days, setDays] = useState<Period>(30)
  const [userID, setUserID] = useState("all")
  const [dimension, setDimension] = useState<Dimension>(admin ? "users" : "models")
  const [loading, setLoading] = useState(!initialReport)
  const requestID = useRef(0)

  async function load(nextDays: Period, nextUserID = userID) {
    const currentRequest = ++requestID.current
    setDays(nextDays)
    setUserID(nextUserID)
    if (nextUserID !== "all" && dimension === "users") setDimension("models")
    setLoading(true)
    try {
      const params = new URLSearchParams({ days: String(nextDays) })
      if (admin && nextUserID !== "all") params.set("user_id", nextUserID)
      const next = await api<UsageReport>(
        `${admin ? "/api/admin/usage" : "/api/usage"}?${params}`
      )
      if (currentRequest === requestID.current) setReport(next)
    } catch (cause) {
      if (currentRequest === requestID.current)
        toast({
          type: "error",
          body: cause instanceof Error ? cause.message : "读取用量失败",
        })
    } finally {
      if (currentRequest === requestID.current) setLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    if (!initialReport) {
      const params = new URLSearchParams({ days: "30" })
      void api<UsageReport>(
        `${admin ? "/api/admin/usage" : "/api/usage"}?${params}`
      )
        .then((next) => {
          if (active) setReport(next)
        })
        .catch((cause) => {
          if (active)
            toast({
              type: "error",
              body: cause instanceof Error ? cause.message : "读取用量失败",
            })
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    }
    if (admin && initialUsers.length === 0) {
      void api<{ items: User[] }>("/api/admin/tenants")
        .then((value) => {
          if (active) setUsers(value.items ?? [])
        })
        .catch(() => {})
    }
    return () => {
      active = false
    }
  }, [admin, initialReport, initialUsers.length, toast])

  if (!report) {
    return loading ? (
      <LoadingView />
    ) : (
      <LoadErrorView
        message="无法读取用量"
        onRetry={() => void load(days, userID)}
      />
    )
  }

  const hasRows =
    dimension === "users"
      ? report.users.length > 0
      : dimension === "models"
        ? report.models.length > 0
        : report.api_keys.length > 0

  return (
    <PageFrame
      title={admin ? "用量" : "用量"}
      accessory={accessory}
      actions={
        <HStack gap={2} wrap="wrap" vAlign="center">
          {admin ? (
            <Selector
              label="用户"
              isLabelHidden
              variant="ghost"
              value={userID}
              onChange={(value) => void load(days, value)}
              options={[
                { value: "all", label: "全部用户" },
                ...users.map((user) => ({
                  value: user.id,
                  label: user.name,
                })),
              ]}
            />
          ) : null}
          <SegmentedControl
            label="统计周期"
            size="sm"
            value={String(days)}
            onChange={(value) => void load(Number(value) as Period)}
          >
            {periods.map((period) => (
              <SegmentedControlItem
                key={period.value}
                value={String(period.value)}
                label={period.label}
              />
            ))}
          </SegmentedControl>
        </HStack>
      }
    >
      <VStack gap={0}>
        <MetricStrip
          items={[
            {
              label: "请求",
              value: compact(report.summary.requests),
              hint: `${successRate(report.summary.errors, report.summary.requests)} · ${compact(report.summary.errors)} 错误`,
            },
            {
              label: "Tokens",
              value: compactTokens(report.summary.tokens),
              hint: `${compactTokens(report.summary.prompt_tokens)} / ${compactTokens(report.summary.completion_tokens)}`,
            },
            {
              label: "缓存",
              value: cacheHitRateLabel(
                report.summary.cached_tokens,
                report.summary.prompt_tokens
              ),
            },
            {
              label: "成本",
              value: money(report.summary.cost_nano_usd),
              hint: averageCost(report.summary.cost_nano_usd, report.summary.requests),
            },
          ]}
        />
        <UsageTrend report={report} />
        <Grid columns={{ minWidth: 280, max: 2 }} gap={0}>
          <TokenBreakdown report={report} />
          <CostBreakdown report={report} />
        </Grid>
        <PageSection
          title="归因"
          actions={
            <SegmentedControl
              label="归因维度"
              size="sm"
              value={dimension}
              onChange={(value) => setDimension(value as Dimension)}
            >
              {admin && userID === "all" ? (
                <SegmentedControlItem value="users" label="用户" />
              ) : null}
              <SegmentedControlItem value="models" label="模型" />
              <SegmentedControlItem value="keys" label="Keys" />
            </SegmentedControl>
          }
        >
          {hasRows ? (
            <DimensionTable report={report} dimension={dimension} />
          ) : (
            <EmptyState isCompact title="没有可归因用量" />
          )}
        </PageSection>
      </VStack>
    </PageFrame>
  )
}

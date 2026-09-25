import { useState } from "react"
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts"
import { ShieldCheckIcon, WalletCardsIcon } from "lucide-react"
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
import { Progress } from "@/components/ui/progress"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"
import type { UsageReport } from "@/lib/api"
import { compactTokens, money } from "@/lib/format"
type TrendMetric = "requests" | "tokens" | "cost"
const trendConfig = {
  requests: { label: "请求", color: "var(--chart-3)" },
  errors: { label: "错误", color: "var(--destructive)" },
  tokens: { label: "Tokens", color: "var(--chart-4)" },
  cached_tokens: { label: "缓存命中", color: "var(--chart-2)" },
  cost_usd: { label: "费用", color: "var(--chart-3)" },
} satisfies ChartConfig

function percent(value: number, total: number) {
  if (!Number.isFinite(total) || total <= 0) return "—"
  return `${((Math.max(0, value) / total) * 100).toFixed(1)}%`
}

function averageCost(cost: number, requests: number) {
  return requests > 0 ? money(cost / requests) : "—"
}

function BreakdownRow({
  label,
  value,
  total,
}: {
  label: string
  value: number
  total: number
}) {
  const width =
    total > 0 ? Math.min(100, (Math.max(0, value) / total) * 100) : 0
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-4 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">{compactTokens(value)}</span>
      </div>
      <Progress value={width} aria-label={`${label}占比`} />
    </div>
  )
}

export function TokenBreakdown({ report }: { report: UsageReport }) {
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
    <Card>
      <CardHeader>
        <CardTitle>Token 结构</CardTitle>
        <CardDescription>
          输入输出为主维度，缓存与推理为其中的细分计数。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {items.map(([label, value]) => (
          <BreakdownRow
            key={label}
            label={label}
            value={value}
            total={summary.tokens}
          />
        ))}
        {imageTokens > 0 ? (
          <BreakdownRow
            label="图像输入与输出"
            value={imageTokens}
            total={summary.tokens}
          />
        ) : null}
      </CardContent>
    </Card>
  )
}

export function CostBreakdown({ report }: { report: UsageReport }) {
  const summary = report.summary
  const total = summary.cost_nano_usd
  const covered = summary.subscription_covered_nano_usd
  const charged = summary.balance_charged_nano_usd
  return (
    <Card>
      <CardHeader>
        <CardTitle>费用来源</CardTitle>
        <CardDescription>区分订阅容量承担与账户余额实际扣费。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex h-2 overflow-hidden bg-muted">
          <div
            className="bg-foreground"
            style={{
              width:
                percent(covered, total) === "—"
                  ? "0%"
                  : percent(covered, total),
            }}
          />
          <div
            className="bg-foreground/35"
            style={{
              width:
                percent(charged, total) === "—"
                  ? "0%"
                  : percent(charged, total),
            }}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="p-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldCheckIcon className="size-3.5" />
              订阅承担
            </div>
            <div className="mt-2 flex items-baseline justify-between gap-2">
              <span className="font-medium tabular-nums">{money(covered)}</span>
              <span className="text-xs text-muted-foreground">
                {percent(covered, total)}
              </span>
            </div>
          </div>
          <div className="p-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <WalletCardsIcon className="size-3.5" />
              余额支付
            </div>
            <div className="mt-2 flex items-baseline justify-between gap-2">
              <span className="font-medium tabular-nums">{money(charged)}</span>
              <span className="text-xs text-muted-foreground">
                {percent(charged, total)}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between pt-4 text-sm">
          <span className="text-muted-foreground">单次请求平均成本</span>
          <span className="font-medium tabular-nums">
            {averageCost(total, summary.requests)}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

export function UsageTrend({ report }: { report: UsageReport }) {
  const [metric, setMetric] = useState<TrendMetric>("requests")
  const data = report.daily.map((item) => ({
    ...item,
    cost_usd: item.cost_nano_usd / 1_000_000_000,
  }))
  const empty = !data.length
  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>趋势</CardTitle>
          <CardDescription>
            按天查看请求质量、Token 与费用变化。
          </CardDescription>
        </div>
        <ToggleGroup
          value={[metric]}
          onValueChange={(value) => {
            const next = value[0] as TrendMetric | undefined
            if (next) setMetric(next)
          }}
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="趋势指标"
        >
          {(["requests", "tokens", "cost"] as TrendMetric[]).map((item) => (
            <ToggleGroupItem key={item} value={item}>
              {item === "requests"
                ? "请求"
                : item === "tokens"
                  ? "Token"
                  : "费用"}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </CardHeader>
      <CardContent>
        {empty ? (
          <Empty className="h-72 p-0">
            <EmptyHeader>
              <EmptyTitle>暂无用量</EmptyTitle>
              <EmptyDescription>当前时间范围内没有请求记录。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ChartContainer config={trendConfig} className="h-72 w-full">
            <AreaChart
              data={data}
              accessibilityLayer
              margin={{ left: 4, right: 4 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={10}
                minTickGap={24}
                tickFormatter={(value: string) => value.slice(5)}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    indicator="line"
                    formatter={(value, name) => (
                      <div className="flex min-w-32 items-center justify-between gap-4">
                        <span className="text-muted-foreground">
                          {
                            trendConfig[
                              String(name) as keyof typeof trendConfig
                            ]?.label
                          }
                        </span>
                        <span className="font-mono font-medium tabular-nums">
                          {name === "cost_usd"
                            ? new Intl.NumberFormat("zh-CN", {
                                style: "currency",
                                currency: "USD",
                                maximumFractionDigits: 4,
                              }).format(Number(value))
                            : compactTokens(Number(value))}
                        </span>
                      </div>
                    )}
                  />
                }
              />
              {metric === "requests" ? (
                <>
                  <Area
                    dataKey="requests"
                    type="monotone"
                    fill="var(--color-requests)"
                    fillOpacity={0.12}
                    stroke="var(--color-requests)"
                    strokeWidth={2}
                  />
                  <Area
                    dataKey="errors"
                    type="monotone"
                    fill="var(--color-errors)"
                    fillOpacity={0.08}
                    stroke="var(--color-errors)"
                    strokeWidth={1.5}
                  />
                </>
              ) : metric === "tokens" ? (
                <>
                  <Area
                    dataKey="tokens"
                    type="monotone"
                    fill="var(--color-tokens)"
                    fillOpacity={0.12}
                    stroke="var(--color-tokens)"
                    strokeWidth={2}
                  />
                  <Area
                    dataKey="cached_tokens"
                    type="monotone"
                    fill="var(--color-cached_tokens)"
                    fillOpacity={0.08}
                    stroke="var(--color-cached_tokens)"
                    strokeWidth={1.5}
                  />
                </>
              ) : (
                <Area
                  dataKey="cost_usd"
                  type="monotone"
                  fill="var(--color-cost_usd)"
                  fillOpacity={0.12}
                  stroke="var(--color-cost_usd)"
                  strokeWidth={2}
                />
              )}
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}

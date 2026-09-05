import { useEffect, useRef, useState } from "react"
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts"
import {
  ActivityIcon,
  BoxesIcon,
  CircleDollarSignIcon,
  CoinsIcon,
  DatabaseIcon,
  KeyRoundIcon,
  ShieldCheckIcon,
  UsersIcon,
  WalletCardsIcon,
} from "lucide-react"
import { toast } from "@/components/ui/toast"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Progress } from "@/components/ui/progress"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { PageHeader, StatStrip } from "@/components/workspace-ui"
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

function successRate(errors: number, requests: number) {
  if (!requests) return "—"
  return percent(Math.max(0, requests - errors), requests)
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

function CostBreakdown({ report }: { report: UsageReport }) {
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

function UsageTrend({ report }: { report: UsageReport }) {
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

function ShareCell({ value, total }: { value: number; total: number }) {
  const share = total > 0 ? Math.min(100, (value / total) * 100) : 0
  return (
    <div className="ml-auto flex w-28 flex-col gap-1">
      <div className="flex justify-between gap-2 text-xs tabular-nums">
        <span>{compactTokens(value)}</span>
        <span className="text-muted-foreground">{percent(value, total)}</span>
      </div>
      <Progress
        value={share}
        className="w-full gap-0 [&_[data-slot=progress-track]]:h-1"
      />
    </div>
  )
}

function DimensionTable({
  report,
  dimension,
}: {
  report: UsageReport
  dimension: Dimension
}) {
  if (dimension === "users") {
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>用户</TableHead>
            <TableHead className="text-right">请求</TableHead>
            <TableHead className="text-right">成功率</TableHead>
            <TableHead className="text-right">Token 占比</TableHead>
            <TableHead className="text-right">费用</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {report.users.map((item) => (
            <TableRow key={item.tenant_id}>
              <TableCell className="font-medium">
                {item.tenant_name || "未知用户"}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {compact(item.requests)}
              </TableCell>
              <TableCell className="text-right">
                <Badge variant={item.errors ? "outline" : "secondary"}>
                  {successRate(item.errors, item.requests)}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <ShareCell value={item.tokens} total={report.summary.tokens} />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {money(item.cost_nano_usd)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    )
  }
  if (dimension === "models") {
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>模型</TableHead>
            <TableHead className="text-right">请求</TableHead>
            <TableHead className="text-right">成功率</TableHead>
            <TableHead className="text-right">缓存率</TableHead>
            <TableHead className="text-right">Token 占比</TableHead>
            <TableHead className="text-right">费用</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {report.models.map((item) => (
            <TableRow key={item.model}>
              <TableCell className="max-w-64 truncate font-mono text-xs">
                {item.model || "未识别"}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {compact(item.requests)}
              </TableCell>
              <TableCell className="text-right">
                <Badge variant={item.errors ? "outline" : "secondary"}>
                  {successRate(item.errors, item.requests)}
                </Badge>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {cacheHitRateLabel(item.cached_tokens, item.prompt_tokens)}
              </TableCell>
              <TableCell className="text-right">
                <ShareCell value={item.tokens} total={report.summary.tokens} />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {money(item.cost_nano_usd)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    )
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>API Key</TableHead>
          <TableHead>用户</TableHead>
          <TableHead className="text-right">请求</TableHead>
          <TableHead className="text-right">成功率</TableHead>
          <TableHead className="text-right">Token 占比</TableHead>
          <TableHead className="text-right">费用</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {report.api_keys.map((item) => (
          <TableRow key={`${item.api_key_id}-${item.api_key_prefix}`}>
            <TableCell>
              <div className="flex flex-col">
                <span className="font-medium">
                  {item.api_key_name || "已删除的 Key"}
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {item.api_key_prefix || "未知"}…
                </span>
              </div>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {item.tenant_name || "—"}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {compact(item.requests)}
            </TableCell>
            <TableCell className="text-right">
              <Badge variant={item.errors ? "outline" : "secondary"}>
                {successRate(item.errors, item.requests)}
              </Badge>
            </TableCell>
            <TableCell className="text-right">
              <ShareCell value={item.tokens} total={report.summary.tokens} />
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {money(item.cost_nano_usd)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function UsageView({
  initialReport,
  admin = false,
  users: initialUsers = [],
}: {
  initialReport?: UsageReport
  admin?: boolean
  users?: User[]
}) {
  const [report, setReport] = useState<UsageReport | null>(
    initialReport ?? null
  )
  const [users, setUsers] = useState(initialUsers)
  const [days, setDays] = useState<Period>(30)
  const [userID, setUserID] = useState("all")
  const [dimension, setDimension] = useState<Dimension>(
    admin ? "users" : "models"
  )
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
        toast.add({
          title: cause instanceof Error ? cause.message : "读取用量失败",
          type: "error",
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
            toast.add({
              title: cause instanceof Error ? cause.message : "读取用量失败",
              type: "error",
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
  }, [admin, initialReport, initialUsers.length])

  if (!report) {
    return (
      <div className="flex min-h-56 flex-col items-center justify-center gap-3">
        {loading ? (
          <Spinner />
        ) : (
          <>
            <p className="text-sm text-muted-foreground">无法读取用量</p>
            <Button variant="outline" onClick={() => void load(days, userID)}>
              重试
            </Button>
          </>
        )}
      </div>
    )
  }

  const hasRows =
    dimension === "users"
      ? report.users.length > 0
      : dimension === "models"
        ? report.models.length > 0
        : report.api_keys.length > 0

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={admin ? "全局用量" : "用量"}
        actions={
          <>
            {admin ? (
              <Select
                items={[
                  { value: "all", label: "全部用户" },
                  ...users.map((user) => ({
                    value: user.id,
                    label: user.name,
                  })),
                ]}
                value={userID}
                onValueChange={(value) => void load(days, value ?? "all")}
              >
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectGroup>
                    <SelectItem value="all">全部用户</SelectItem>
                    {users.map((user) => (
                      <SelectItem key={user.id} value={user.id}>
                        {user.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : null}
            <ToggleGroup
              value={[String(days)]}
              onValueChange={(value) => {
                const next = Number(value[0]) as Period
                if (periods.some((period) => period.value === next))
                  void load(next)
              }}
              variant="outline"
              size="sm"
              spacing={0}
              aria-label="统计周期"
            >
              {periods.map((period) => (
                <ToggleGroupItem
                  key={period.value}
                  value={String(period.value)}
                >
                  {period.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {loading ? <Spinner aria-label="正在更新用量" /> : null}
          </>
        }
      />

      <StatStrip
        items={[
          {
            label: "请求",
            value: compact(report.summary.requests),
            detail: `${successRate(report.summary.errors, report.summary.requests)} 成功 · ${compact(report.summary.errors)} 错误`,
            icon: ActivityIcon,
          },
          {
            label: "Tokens",
            value: compactTokens(report.summary.tokens),
            detail: `${compactTokens(report.summary.prompt_tokens)} 输入 · ${compactTokens(report.summary.completion_tokens)} 输出`,
            icon: CoinsIcon,
          },
          {
            label: "缓存命中",
            value: cacheHitRateLabel(
              report.summary.cached_tokens,
              report.summary.prompt_tokens
            ),
            detail: compactTokens(report.summary.cached_tokens),
            icon: DatabaseIcon,
          },
          {
            label: "成本",
            value: money(report.summary.cost_nano_usd),
            detail: `${averageCost(report.summary.cost_nano_usd, report.summary.requests)} / 请求`,
            icon: CircleDollarSignIcon,
          },
        ]}
      />

      <UsageTrend report={report} />

      <div className="grid gap-4 xl:grid-cols-2">
        <TokenBreakdown report={report} />
        <CostBreakdown report={report} />
      </div>

      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>用量归因</CardTitle>
          <Tabs
            value={dimension}
            onValueChange={(value) => setDimension(value as Dimension)}
          >
            <TabsList>
              {admin && userID === "all" ? (
                <TabsTrigger value="users">
                  <UsersIcon />
                  用户
                </TabsTrigger>
              ) : null}
              <TabsTrigger value="models">
                <BoxesIcon />
                模型
              </TabsTrigger>
              <TabsTrigger value="keys">
                <KeyRoundIcon />
                Keys
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent>
          {hasRows ? (
            <DimensionTable
              key={dimension}
              report={report}
              dimension={dimension}
            />
          ) : (
            <Empty className="h-32 p-0">
              <EmptyHeader>
                <EmptyTitle>暂无归因数据</EmptyTitle>
                <EmptyDescription>
                  当前范围内没有可归因的用量。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

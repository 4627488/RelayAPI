import { useState } from "react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"
import { SearchField, StatStrip } from "@/components/workspace-ui"
import { Badge } from "@/components/ui/badge"
import type { UsageReport } from "@/lib/api"
import {
  cacheHitRateLabel,
  compact,
  compactTokens,
  dateTime,
  money,
} from "@/lib/format"
import { measuredMS } from "@/lib/latency-trace"

const rate = (value: number, total: number) =>
  total > 0
    ? `${((Math.max(0, Math.min(value, total)) / total) * 100).toFixed(1)}%`
    : "—"

export function AnalyticsSummary({ report }: { report: UsageReport }) {
  const s = report.summary
  return (
    <StatStrip
      className="xl:grid-cols-3"
      items={[
        {
          label: "请求",
          value: compact(s.requests),
          detail: `${report.days} 天 · ${compact(s.errors)} 次错误`,
        },
        {
          label: "成功率",
          value: rate(s.requests - s.errors, s.requests),
          detail: s.requests
            ? `${compact(s.requests - s.errors)} 次成功`
            : "尚无请求样本",
        },
        {
          label: "模型成本",
          value: money(s.cost_nano_usd),
          detail: s.requests
            ? `${money(s.cost_nano_usd / s.requests)} / 请求`
            : "尚无计费请求",
        },
        {
          label: "Tokens",
          value: compactTokens(s.tokens),
          detail: `${compactTokens(s.prompt_tokens)} 输入 · ${compactTokens(s.completion_tokens)} 输出`,
        },
        {
          label: "缓存命中率",
          value: cacheHitRateLabel(s.cached_tokens, s.prompt_tokens),
          detail: `${compactTokens(s.cached_tokens)} 缓存读取 / ${compactTokens(s.prompt_tokens)} 输入`,
        },
        {
          label: "余额支付",
          value: money(s.balance_charged_nano_usd),
          detail: `订阅承担 ${money(s.subscription_covered_nano_usd)}`,
        },
      ]}
    />
  )
}

export function ObservationPanels({ report }: { report: UsageReport }) {
  const o = report.observability
  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-2">
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>响应性能</CardTitle>
          <CardDescription>
            仅统计所选周期内仍保留的计费块，历史会话不参与延迟分位数。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {o ? (
            <>
              <Table tabIndex={0} aria-label="响应性能">
                <TableHeader>
                  <TableRow>
                    <TableHead>观测</TableHead>
                    <TableHead className="text-right">P50</TableHead>
                    <TableHead className="text-right">P95</TableHead>
                    <TableHead className="text-right">样本</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(
                    [
                      [
                        "请求耗时",
                        o.latency_p50_ms,
                        o.latency_p95_ms,
                        o.step_samples,
                      ],
                      [
                        "首 Token",
                        o.first_token_p50_ms,
                        o.first_token_p95_ms,
                        o.first_token_samples,
                      ],
                      [
                        "首响应 / 首字节",
                        o.ttft_p50_ms,
                        o.ttft_p95_ms,
                        o.ttft_samples,
                      ],
                    ] as const
                  ).map(([label, p50, p95, n]) => (
                    <TableRow key={label}>
                      <TableCell>{label}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {measuredMS(p50 ?? undefined)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {measuredMS(p95 ?? undefined)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {compact(n)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="text-xs text-muted-foreground">
                保留 {compact(o.retained_requests)} /{" "}
                {compact(report.summary.requests)}{" "}
                条请求记录；已归档的用量仍计入成本与用量，不补算延迟。
              </p>
              <p className="text-xs text-muted-foreground">
                {o.first_observed_at
                  ? `${dateTime(o.first_observed_at)} 至 ${dateTime(o.last_observed_at)}`
                  : "此范围内没有保留的请求记录"}
              </p>
            </>
          ) : (
            <NoData text="性能观测暂不可用" />
          )}
        </CardContent>
      </Card>
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>失败与计费异常</CardTitle>
          <CardDescription>
            保留记录中出现最多的 20 组错误；相同模型、状态码和错误码归为一组。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {o ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Badge variant={o.unpriced_requests ? "outline" : "secondary"}>
                  定价未完成 {compact(o.unpriced_requests)}
                </Badge>
                <Badge variant={o.unsettled_requests ? "outline" : "secondary"}>
                  未结算 {compact(o.unsettled_requests)}
                </Badge>
              </div>
              {o.failures.length ? (
                <div className="max-h-72 overflow-auto">
                  <Table tabIndex={0} aria-label="失败请求">
                    <TableHeader>
                      <TableRow>
                        <TableHead>模型 / 错误</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead className="text-right">次数</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {o.failures.map((f, i) => (
                        <TableRow key={i}>
                          <TableCell className="max-w-60 break-all whitespace-normal">
                            <p>{f.model || "未识别模型"}</p>
                            <p className="text-xs text-muted-foreground">
                              {f.error_code || "未提供错误码"}
                            </p>
                          </TableCell>
                          <TableCell>{f.status_code || "未收到响应"}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {compact(f.requests)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <NoData
                  text="保留记录中未发现失败"
                  detail="不代表已归档或未采集的请求没有错误。"
                />
              )}
            </>
          ) : (
            <NoData text="错误观测暂不可用" />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function NoData({ text, detail }: { text: string; detail?: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{text}</EmptyTitle>
        {detail && <EmptyDescription>{detail}</EmptyDescription>}
      </EmptyHeader>
    </Empty>
  )
}

type Dimension = "models" | "keys" | "users" | "providers"
type Sort = "cost_nano_usd" | "requests" | "errors" | "tokens"
export function AttributionPanel({
  report,
  admin = false,
  compactView = false,
}: {
  report: UsageReport
  admin?: boolean
  compactView?: boolean
}) {
  const [dimension, setDimension] = useState<Dimension>("models")
  const [sort, setSort] = useState<Sort>("cost_nano_usd")
  const [search, setSearch] = useState("")
  const activeDimension =
    !admin && (dimension === "users" || dimension === "providers")
      ? "models"
      : dimension
  const data =
    activeDimension === "models"
      ? (report.models ?? []).map((x) => ({
          ...x,
          id: x.model,
          name: x.model || "未识别",
          detail: `缓存命中 ${cacheHitRateLabel(x.cached_tokens, x.prompt_tokens)}`,
        }))
      : activeDimension === "keys"
        ? (report.api_keys ?? []).map((x) => ({
            ...x,
            id: x.api_key_id,
            name: x.api_key_name || "已删除的 Key",
            detail: [x.api_key_prefix, x.tenant_name]
              .filter(Boolean)
              .join(" · "),
          }))
        : activeDimension === "users"
          ? (report.users ?? []).map((x) => ({
              ...x,
              id: x.tenant_id,
              name: x.tenant_name || "未知用户",
              detail: "",
            }))
          : (report.observability?.providers ?? []).map((x) => ({
              ...x,
              id: x.provider,
              name: x.provider || "未记录提供商",
              detail: "保留记录",
            }))
  const rows = data
    .filter((x) =>
      `${x.name} ${x.detail}`
        .toLowerCase()
        .includes(search.trim().toLowerCase())
    )
    .sort((a, b) => b[sort] - a[sort] || a.name.localeCompare(b.name))
  const totalCost =
    activeDimension === "providers"
      ? data.reduce((sum, x) => sum + x.cost_nano_usd, 0)
      : report.summary.cost_nano_usd
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>{compactView ? "主要消耗与错误来源" : "用量归因"}</CardTitle>
        <CardDescription>
          {activeDimension === "providers"
            ? "提供商归因仅覆盖保留的请求记录，不含已归档用量。"
            : `最近 ${report.days} 天 · 选择维度与排序，定位消耗和失败来源。`}
        </CardDescription>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabs
            value={activeDimension}
            onValueChange={(v) => setDimension(v as Dimension)}
          >
            <TabsList aria-label="归因维度">
              <TabsTrigger value="models">模型</TabsTrigger>
              <TabsTrigger value="keys">密钥</TabsTrigger>
              {admin && (
                <>
                  <TabsTrigger value="users">租户</TabsTrigger>
                  <TabsTrigger value="providers">提供商</TabsTrigger>
                </>
              )}
            </TabsList>
          </Tabs>
          <ToggleGroup
            value={[sort]}
            onValueChange={(v) => v[0] && setSort(v[0] as Sort)}
            variant="outline"
            size="sm"
            aria-label="归因排序"
          >
            {(
              [
                ["cost_nano_usd", "费用"],
                ["requests", "请求"],
                ["errors", "错误"],
                ["tokens", "Tokens"],
              ] as const
            ).map(([v, l]) => (
              <ToggleGroupItem key={v} value={v}>
                {l}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        {!compactView && (
          <SearchField
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onClear={() => setSearch("")}
            placeholder="搜索归因名称"
          />
        )}
      </CardHeader>
      <CardContent>
        {rows.length ? (
          <div
            className={compactView ? undefined : "max-h-[36rem] overflow-auto"}
          >
            <Table tabIndex={0} aria-label="用量归因明细">
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead className="text-right">请求</TableHead>
                  <TableHead className="text-right">错误 / 成功率</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">费用 / 占比</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(compactView ? rows.slice(0, 5) : rows).map((x) => (
                  <TableRow key={x.id}>
                    <TableCell className="max-w-64">
                      <p className="truncate" title={x.name}>
                        {x.name}
                      </p>
                      {x.detail && (
                        <p
                          className="truncate text-xs text-muted-foreground"
                          title={x.detail}
                        >
                          {x.detail}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {compact(x.requests)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <p>{compact(x.errors)}</p>
                      <p className="text-xs text-muted-foreground">
                        {rate(x.requests - x.errors, x.requests)}
                      </p>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {compactTokens(x.tokens)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <p>{money(x.cost_nano_usd)}</p>
                      <p className="text-xs text-muted-foreground">
                        {rate(x.cost_nano_usd, totalCost)}
                      </p>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <NoData text={search ? "没有匹配项" : "暂无归因数据"} />
        )}
        {compactView && rows.length > 5 && (
          <p className="mt-3 text-xs text-muted-foreground">
            显示前 5 项，共 {rows.length} 项；完整数据见用量页面。
          </p>
        )}
      </CardContent>
    </Card>
  )
}

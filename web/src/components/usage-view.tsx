import { useCallback, useEffect, useState } from "react"
import { RefreshCwIcon } from "lucide-react"
import { api, type UsageReport, type User } from "@/lib/api"
import { dateTime } from "@/lib/format"
import { useAsyncResource } from "@/hooks/use-async-resource"
import {
  AnalyticsSummary,
  AttributionPanel,
  ObservationPanels,
} from "@/components/analytics-panels"
import {
  UsageTrend,
  TokenBreakdown,
  CostBreakdown,
  Last24HoursTokenRate,
} from "@/components/usage-charts"
import { PageHeader } from "@/components/workspace-ui"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
} from "@/components/ui/popover"
import { LoadingView } from "@/components/loading-view"
import { LoadErrorView } from "@/components/load-error-view"

function UsageMethodology() {
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" size="sm" />}>
        统计口径
      </PopoverTrigger>
      <PopoverContent align="end">
        <PopoverHeader>
          <PopoverTitle>统计口径</PopoverTitle>
        </PopoverHeader>
        <PopoverDescription render={<div />} className="flex flex-col gap-3">
          <p>
            费用与 Tokens
            包含归档用量。延迟、提供商归因和错误明细仅统计保留的请求记录。
          </p>
          <p>输入、缓存读取和缓存写入独立计量；推理包含在输出中。</p>
          <p>吞吐量按请求完成时间聚合；生成速度按有效流式样本加权。</p>
        </PopoverDescription>
      </PopoverContent>
    </Popover>
  )
}

export function PeriodControl({
  days,
  onChange,
}: {
  days: number
  onChange: (days: number) => void
}) {
  return (
    <ToggleGroup
      value={[String(days)]}
      onValueChange={(v) => v[0] && onChange(Number(v[0]))}
      variant="outline"
      size="sm"
      aria-label="统计周期"
    >
      {[1, 7, 30, 90, 365, 0].map((n) => (
        <ToggleGroupItem key={n} value={String(n)}>
          {n === 0 ? "全部" : n === 1 ? "今天" : n === 365 ? "1 年" : `${n} 天`}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
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
  const [days, setDays] = useState(initialReport?.days ?? 30)
  const [userID, setUserID] = useState("all")
  const [users, setUsers] = useState(initialUsers)
  const load = useCallback(() => {
    const params = new URLSearchParams({
      days: String(days),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    if (days === 0) params.set("period", "all")
    if (admin)
      params.set("timezone_offset", String(-new Date().getTimezoneOffset()))
    if (admin && userID !== "all") params.set("user_id", userID)
    return api<UsageReport>(
      `${admin ? "/api/admin/usage" : "/api/usage"}?${params}`
    )
  }, [admin, days, userID])
  const {
    data: report,
    loading,
    error,
    reload,
  } = useAsyncResource(load, {
    initialData: initialReport ?? null,
    errorMessage: "无法读取用量",
  })
  useEffect(() => {
    let active = true
    if (admin && !initialUsers.length)
      void api<{ items: User[] }>("/api/admin/tenants")
        .then((v) => {
          if (active) setUsers(v.items ?? [])
        })
        .catch(() => {})
    return () => {
      active = false
    }
  }, [admin, initialUsers.length])
  if (!report)
    return loading ? (
      <LoadingView />
    ) : (
      <LoadErrorView message={error} onRetry={() => void reload(true)} />
    )
  return (
    <div className="flex min-w-0 flex-col gap-6" aria-busy={loading}>
      <PageHeader
        title={admin ? "全局用量" : "用量"}
        description={`当前展示${report.days === 0 ? "全部历史" : `最近 ${report.days} 天`}（${report.timezone ?? "UTC"}）${admin && report.user_id ? " · 已筛选租户" : ""}${report.generated_at ? ` · 更新于 ${dateTime(report.generated_at)}` : ""}`}
        actions={
          <>
            <UsageMethodology />
            {admin && (
              <Select
                value={userID}
                onValueChange={(v) => setUserID(v ?? "all")}
                items={[
                  { value: "all", label: "全部用户" },
                  ...users.map((u) => ({ value: u.id, label: u.name })),
                ]}
              >
                <SelectTrigger className="w-44" aria-label="统计用户">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">全部用户</SelectItem>
                    {users.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            )}
            <PeriodControl days={days} onChange={setDays} />
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => void reload(true)}
            >
              <RefreshCwIcon data-icon="inline-start" />
              刷新
            </Button>
          </>
        }
      />
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {error}。当前显示上次成功读取的数据。
          </AlertDescription>
        </Alert>
      )}
      <AnalyticsSummary report={report} />
      {admin && <Last24HoursTokenRate report={report} />}
      <UsageTrend report={report} />
      <ObservationPanels report={report} />
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <TokenBreakdown report={report} />
        <CostBreakdown report={report} />
      </div>
      <AttributionPanel report={report} admin={admin && !report.user_id} />
    </div>
  )
}

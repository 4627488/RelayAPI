import { useCallback, useState } from "react"
import { RefreshCwIcon } from "lucide-react"
import {
  api,
  type AdminOverview,
  type ApiKey,
  type ChildSubscription,
  type ProviderAccount,
  type RequestLog,
  type Session,
  type UsageReport,
} from "@/lib/api"
import { useAsyncResource } from "@/hooks/use-async-resource"
import {
  AnalyticsSummary,
  AttributionPanel,
  ObservationPanels,
} from "@/components/analytics-panels"
import { UsageTrend, CostBreakdown } from "@/components/usage-charts"
import { AccountHealthPanel } from "@/components/account-health-panel"
import { PeriodControl } from "@/components/usage-view"
import { PageHeader } from "@/components/workspace-ui"
import { LogsTable } from "@/components/data-views"
import { LoadingView } from "@/components/loading-view"
import { LoadErrorView } from "@/components/load-error-view"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { dateTime, money } from "@/lib/format"
import { routeHref, type Page } from "@/lib/routes"

export function OverviewPage({
  admin = false,
  session,
  onPageChange,
}: {
  admin?: boolean
  session?: Session
  onPageChange: (page: Page) => void
}) {
  const [days, setDays] = useState(30)
  const load = useCallback(async () => {
    const prefix = admin ? "/api/admin" : "/api"
    const warnings: string[] = []
    async function optional<T>(path: string, label: string): Promise<T | null> {
      try {
        return await api<T>(path)
      } catch {
        warnings.push(`${label}读取失败`)
        return null
      }
    }
    const [
      usage,
      logs,
      overview,
      accounts,
      keys,
      subscriptions,
      currentSession,
    ] = await Promise.all([
      api<UsageReport>(`${prefix}/usage?days=${days}`),
      optional<{ items: RequestLog[] }>(
        `${prefix}/logs?page_size=6`,
        "最近请求"
      ),
      admin ? optional<AdminOverview>("/api/admin/overview", "管理摘要") : null,
      admin
        ? optional<{ files: ProviderAccount[] }>(
            "/api/admin/providers/accounts",
            "账户健康"
          )
        : null,
      admin ? null : optional<{ items: ApiKey[] }>("/api/keys", "密钥"),
      admin
        ? null
        : optional<{ items: ChildSubscription[] }>(
            "/api/subscriptions",
            "订阅"
          ),
      admin ? null : optional<Session>("/api/me", "账户余额"),
    ])
    return {
      usage,
      logs,
      overview,
      accounts,
      keys,
      subscriptions,
      currentSession,
      warnings,
    }
  }, [admin, days])
  const { data, loading, error, reload } = useAsyncResource(load, {
    initialData: null,
    errorMessage: "无法读取总览",
  })
  if (!data)
    return loading ? (
      <LoadingView />
    ) : (
      <LoadErrorView message={error} onRetry={() => void reload(true)} />
    )
  const workspace = admin ? "admin" : "user"
  const action = (page: Page, label: string) => (
    <Button
      variant="outline"
      size="sm"
      nativeButton={false}
      role="link"
      render={<a href={routeHref({ workspace, page })} />}
      onClick={(event) => {
        if (
          event.button === 0 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault()
          onPageChange(page)
        }
      }}
    >
      {label}
    </Button>
  )
  const current = data.currentSession?.tenant
  const subs = data.subscriptions?.items ?? []
  return (
    <div className="flex min-w-0 flex-col gap-6" aria-busy={loading}>
      <PageHeader
        title={admin ? "管理总览" : "总览"}
        description={`最近 ${data.usage.days} 天的请求、费用与性能${data.usage.generated_at ? ` · 更新于 ${dateTime(data.usage.generated_at)}` : ""}`}
        actions={
          <>
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
          <AlertDescription>{error}。保留上次成功读取的数据。</AlertDescription>
        </Alert>
      )}
      {data.warnings.length > 0 && (
        <Alert>
          <AlertDescription>
            {data.warnings.join("；")}。其他统计仍可查看，点击刷新重试。
          </AlertDescription>
        </Alert>
      )}
      <AnalyticsSummary report={data.usage} />
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <UsageTrend report={data.usage} />
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>{admin ? "运营快照" : "我的账户"}</CardTitle>
            <CardDescription>
              {admin
                ? "当前账户状态与今日请求，独立于上方统计周期。"
                : `当前余额与访问凭据${session?.tenant.name ? ` · ${session.tenant.name}` : ""}`}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {admin ? (
              data.overview ? (
                <>
                  <dl className="grid grid-cols-2 gap-4">
                    {[
                      [
                        "用户 / 启用",
                        `${data.overview.users} / ${data.overview.enabled_users}`,
                      ],
                      ["有效密钥", data.overview.active_api_keys],
                      ["今日请求", data.overview.today.requests],
                      ["今日成本", money(data.overview.today.cost_nano_usd)],
                      ["今日错误", data.overview.today.errors],
                      ["待使用邀请", data.overview.pending_invitations],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt className="text-sm text-muted-foreground">
                          {label}
                        </dt>
                        <dd className="font-medium tabular-nums">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="flex flex-wrap gap-2">
                    {action("logs", `今日错误 ${data.overview.today.errors}`)}
                    {action("users", "管理用户")}
                    {action("invitations", "待使用邀请")}
                    {action("providers", "管理模型账户")}
                  </div>
                </>
              ) : (
                <p>管理摘要暂不可用</p>
              )
            ) : (
              <>
                <dl className="grid grid-cols-2 gap-4">
                  <div>
                    <dt className="text-sm text-muted-foreground">账户余额</dt>
                    <dd className="text-xl font-semibold tabular-nums">
                      {current ? money(current.balance_nano_usd) : "未读取"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted-foreground">
                      启用 / 全部密钥
                    </dt>
                    <dd className="font-medium">
                      {data.keys
                        ? `${data.keys.items.filter((k) => k.enabled).length} / ${data.keys.items.length}`
                        : "未读取"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted-foreground">可用订阅</dt>
                    <dd>
                      {data.subscriptions
                        ? `${subs.filter((s) => s.available ?? s.enabled).length} / ${subs.length}`
                        : "未读取"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted-foreground">
                      所选周期余额支付
                    </dt>
                    <dd>
                      {money(data.usage.summary.balance_charged_nano_usd)}
                    </dd>
                  </div>
                </dl>
                {current && current.balance_nano_usd <= 0 && (
                  <Alert>
                    <AlertDescription>
                      账户余额不足；使用按余额结算的模型前请补充余额。订阅额度单独计算。
                    </AlertDescription>
                  </Alert>
                )}
                <div className="flex flex-wrap gap-2">
                  {action("keys", "管理密钥")}
                  {action("subscriptions", "查看订阅")}
                  {action("guide", "接入指南")}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
      <ObservationPanels report={data.usage} />
      <AttributionPanel report={data.usage} admin={admin} compactView />
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <CostBreakdown report={data.usage} />
        {admin ? (
          data.accounts ? (
            <AccountHealthPanel accounts={data.accounts.files ?? []} />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>上游账户健康</CardTitle>
                <CardDescription>
                  账户状态暂不可用，请刷新重试。
                </CardDescription>
              </CardHeader>
            </Card>
          )
        ) : (
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>订阅与额度</CardTitle>
              <CardDescription>
                各窗口独立约束，不将日、周、月额度相加。
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!data.subscriptions ? (
                <p>订阅数据暂不可用</p>
              ) : subs.length ? (
                <Table tabIndex={0} aria-label="订阅额度窗口">
                  <TableHeader>
                    <TableRow>
                      <TableHead>订阅 / 窗口</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead className="text-right">剩余 / 限额</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {subs.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="max-w-56 whitespace-normal">
                          <p>{s.name}</p>
                          {s.expires_at && (
                            <p className="text-xs text-muted-foreground">
                              到期 {dateTime(s.expires_at)}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground">
                            {s.availability_message}
                          </p>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              (s.available ?? s.enabled)
                                ? "secondary"
                                : "outline"
                            }
                          >
                            {(s.available ?? s.enabled) ? "可用" : "不可用"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {s.entitlement_windows?.length
                            ? s.entitlement_windows.map((w, i) => (
                                <div key={i} className="mb-2">
                                  <p className="text-xs">
                                    {w.kind} · {money(w.remaining_nano_usd)} /{" "}
                                    {money(w.limit_nano_usd)}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    重置 {dateTime(w.resets_at)}
                                  </p>
                                </div>
                              ))
                            : s.billing_mode === "balance" ||
                                s.capacity_mode === "unmetered"
                              ? "余额结算"
                              : "尚无额度观测"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>尚未分配订阅</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              )}
            </CardContent>
          </Card>
        )}
      </div>
      {data.logs && (
        <LogsTable
          logs={data.logs.items ?? []}
          workspace={workspace}
          action={action("logs", "全部日志")}
        />
      )}
      <div className="flex justify-end">
        {action("usage", "查看完整用量分析")}
      </div>
    </div>
  )
}

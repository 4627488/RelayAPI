import { lazy, useCallback } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Activity01Icon,
  BanIcon,
  KeyRoundIcon,
  SendIcon,
  TriangleAlertIcon,
  UsersIcon,
} from "@hugeicons/core-free-icons"
import { toast } from "@/components/ui/toast"
import { routeHref, type Page } from "@/lib/routes"
import { LoadingView } from "@/components/loading-view"
import { LoadErrorView } from "@/components/load-error-view"
import { PageHeader } from "@/components/workspace-ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  api,
  type AdminOverview,
  type RequestLog,
  type UsageReport,
} from "@/lib/api"
import { compact, compactTokens, money } from "@/lib/format"
import { useAsyncResource } from "@/hooks/use-async-resource"

const LogsTable = lazy(() =>
  import("@/components/data-views").then((module) => ({
    default: module.LogsTable,
  }))
)
const MetricGrid = lazy(() =>
  import("@/components/data-views").then((module) => ({
    default: module.MetricGrid,
  }))
)
const UsageChart = lazy(() =>
  import("@/components/data-views").then((module) => ({
    default: module.UsageChart,
  }))
)

export function AdminOverviewPage({
  onPageChange,
}: {
  onPageChange: (page: Page) => void
}) {
  const loadOverview = useCallback(async () => {
    const [overview, usage, logs] = await Promise.all([
      api<AdminOverview>("/api/admin/overview"),
      api<UsageReport>("/api/admin/usage?days=30"),
      api<{ items: RequestLog[] }>("/api/admin/logs?limit=8"),
    ])
    return { overview, usage, logs: logs.items ?? [] }
  }, [])
  const {
    data: { overview, usage, logs },
    loading,
    error: loadError,
    reload,
  } = useAsyncResource(loadOverview, {
    initialData: {
      overview: null as AdminOverview | null,
      usage: null as UsageReport | null,
      logs: [] as RequestLog[],
    },
    errorMessage: "无法读取管理数据",
    onBackgroundError: (message) =>
      toast.add({ title: message, type: "error" }),
  })

  if (loading) return <LoadingView />
  if (!overview || !usage) {
    return (
      <LoadErrorView
        message={loadError || "管理数据不完整"}
        onRetry={() => void reload(true)}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="管理总览" />
      <MetricGrid
        items={[
          {
            label: "用户",
            value: compact(overview.users),
            hint: `${overview.enabled_users} 个账户正常`,
            icon: UsersIcon,
          },
          {
            label: "有效 Keys",
            value: compact(overview.active_api_keys),
            hint: "用户创建的访问凭据",
            icon: KeyRoundIcon,
          },
          {
            label: "今日请求",
            value: compact(overview.today.requests),
            hint: `${compactTokens(overview.today.tokens)} tokens`,
            icon: Activity01Icon,
          },
          {
            label: "今日错误",
            value: compact(overview.today.errors),
            hint: `费用 ${money(overview.today.cost_nano_usd)}`,
            icon: TriangleAlertIcon,
          },
        ]}
      />
      <div className="grid items-start gap-4 xl:grid-cols-[1.6fr_1fr]">
        <UsageChart report={usage} />
        <Card>
          <CardHeader>
            <CardTitle>待处理与管理</CardTitle>
          </CardHeader>
          <CardContent>
            <ItemGroup>
              <Item
                size="sm"
                render={
                  <a href={routeHref({ workspace: "admin", page: "logs" })} />
                }
                onClick={(event) => {
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return
                  if (!event.defaultPrevented) {
                    event.preventDefault()
                    onPageChange("logs")
                  }
                }}
              >
                <ItemMedia variant="icon">
                  <HugeiconsIcon strokeWidth={2} icon={TriangleAlertIcon} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>今日错误</ItemTitle>
                  <ItemDescription>请求日志</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Badge
                    variant={
                      overview.today.errors ? "destructive" : "secondary"
                    }
                  >
                    {overview.today.errors}
                  </Badge>
                </ItemActions>
              </Item>
              <Item
                size="sm"
                render={
                  <a href={routeHref({ workspace: "admin", page: "users" })} />
                }
                onClick={(event) => {
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return
                  if (!event.defaultPrevented) {
                    event.preventDefault()
                    onPageChange("users")
                  }
                }}
              >
                <ItemMedia variant="icon">
                  <HugeiconsIcon strokeWidth={2} icon={BanIcon} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>停用用户</ItemTitle>
                  <ItemDescription>账户状态</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Badge
                    variant={
                      overview.users - overview.enabled_users
                        ? "destructive"
                        : "secondary"
                    }
                  >
                    {overview.users - overview.enabled_users}
                  </Badge>
                </ItemActions>
              </Item>
              <Item
                size="sm"
                render={
                  <a
                    href={routeHref({
                      workspace: "admin",
                      page: "invitations",
                    })}
                  />
                }
                onClick={(event) => {
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return
                  if (!event.defaultPrevented) {
                    event.preventDefault()
                    onPageChange("invitations")
                  }
                }}
              >
                <ItemMedia variant="icon">
                  <HugeiconsIcon strokeWidth={2} icon={SendIcon} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>待使用邀请</ItemTitle>
                  <ItemDescription>仍在有效期内</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Badge variant="secondary">
                    {overview.pending_invitations}
                  </Badge>
                </ItemActions>
              </Item>
              <Item
                size="sm"
                render={
                  <a
                    href={routeHref({ workspace: "admin", page: "providers" })}
                  />
                }
                onClick={(event) => {
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return
                  if (!event.defaultPrevented) {
                    event.preventDefault()
                    onPageChange("providers")
                  }
                }}
              >
                <ItemMedia variant="icon">
                  <HugeiconsIcon strokeWidth={2} icon={KeyRoundIcon} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>管理模型账户</ItemTitle>
                </ItemContent>
              </Item>
            </ItemGroup>
          </CardContent>
        </Card>
      </div>
      <LogsTable
        logs={logs}
        workspace="admin"
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onPageChange("logs")}
          >
            全部日志
          </Button>
        }
      />
    </div>
  )
}

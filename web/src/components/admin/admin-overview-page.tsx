import { lazy, useCallback } from "react"
import {
  ActivityIcon,
  BanIcon,
  KeyRoundIcon,
  SendIcon,
  TriangleAlertIcon,
  UsersIcon,
} from "lucide-react"
import { toast } from "@/components/ui/toast"
import type { Page } from "@/lib/routes"
import { LoadingView } from "@/components/loading-view"
import { LoadErrorView } from "@/components/load-error-view"
import { PageHeader } from "@/components/workspace-ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
      <PageHeader
        title="管理总览"
        description="查看系统运行情况，并从待处理项直接进入下一步。"
      />
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
            icon: ActivityIcon,
          },
          {
            label: "今日错误",
            value: compact(overview.today.errors),
            hint: `费用 ${money(overview.today.cost_nano_usd)}`,
            icon: TriangleAlertIcon,
          },
        ]}
      />
      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <UsageChart report={usage} />
        <Card>
          <CardHeader>
            <CardTitle>待处理与管理</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Button
              type="button"
              variant="ghost"
              size="lg"
              className="w-full justify-between text-left whitespace-normal"
              onClick={() => onPageChange("logs")}
            >
              <div className="flex items-center gap-3">
                <TriangleAlertIcon className="text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">今日错误</p>
                  <p className="text-xs text-muted-foreground">
                    查看请求日志定位失败原因
                  </p>
                </div>
              </div>
              <Badge
                variant={overview.today.errors ? "destructive" : "secondary"}
              >
                {overview.today.errors}
              </Badge>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="lg"
              className="w-full justify-between text-left whitespace-normal"
              onClick={() => onPageChange("users")}
            >
              <div className="flex items-center gap-3">
                <BanIcon className="text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">停用用户</p>
                  <p className="text-xs text-muted-foreground">
                    检查登录权限与账户状态
                  </p>
                </div>
              </div>
              <Badge
                variant={
                  overview.users - overview.enabled_users
                    ? "destructive"
                    : "secondary"
                }
              >
                {overview.users - overview.enabled_users}
              </Badge>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="lg"
              className="w-full justify-between text-left whitespace-normal"
              onClick={() => onPageChange("invitations")}
            >
              <div className="flex items-center gap-3">
                <SendIcon className="text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">待使用邀请</p>
                  <p className="text-xs text-muted-foreground">仍在有效期内</p>
                </div>
              </div>
              <Badge variant="secondary">{overview.pending_invitations}</Badge>
            </Button>
            <Button
              type="button"
              variant="outline"
              className="justify-start"
              onClick={() => onPageChange("providers")}
            >
              <KeyRoundIcon data-icon="inline-start" />
              管理模型账户
            </Button>
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

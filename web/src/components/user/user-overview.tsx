import { lazy, useCallback } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  BookOpen01Icon,
  FileClockIcon,
  KeyRoundIcon,
  PlusIcon,
  WalletCardsIcon,
} from "@hugeicons/core-free-icons"
import { toast } from "@/components/ui/toast"

import { LoadErrorView } from "@/components/load-error-view"
import { LoadingView } from "@/components/loading-view"
import { PageHeader, StatStrip } from "@/components/workspace-ui"
import { Button } from "@/components/ui/button"
import {
  api,
  type ApiKey,
  type RequestLog,
  type Session,
  type UsageReport,
} from "@/lib/api"
import { money } from "@/lib/format"
import { useAsyncResource } from "@/hooks/use-async-resource"
import type { Page } from "@/lib/routes"

const LogsTable = lazy(() =>
  import("@/components/data-views").then((module) => ({
    default: module.LogsTable,
  }))
)
const UsageChart = lazy(() =>
  import("@/components/data-views").then((module) => ({
    default: module.UsageChart,
  }))
)
const UsageMetrics = lazy(() =>
  import("@/components/data-views").then((module) => ({
    default: module.UsageMetrics,
  }))
)

export function UserOverview({
  session,
  onPageChange,
}: {
  session: Session
  onPageChange: (page: Page) => void
}) {
  const loadOverview = useCallback(async () => {
    const [usage, logs, keys] = await Promise.all([
      api<UsageReport>("/api/usage?days=30"),
      api<{ items: RequestLog[] }>("/api/logs?limit=8"),
      api<{ items: ApiKey[] }>("/api/keys"),
    ])
    return { usage, logs: logs.items ?? [], keys: keys.items ?? [] }
  }, [])
  const {
    data: { usage, logs, keys },
    loading,
    error: loadError,
    reload,
  } = useAsyncResource(loadOverview, {
    initialData: {
      usage: null as UsageReport | null,
      logs: [] as RequestLog[],
      keys: [] as ApiKey[],
    },
    errorMessage: "无法读取总览数据",
    onBackgroundError: (message) =>
      toast.add({ title: message, type: "error" }),
  })

  if (loading) return <LoadingView />
  if (!usage) {
    return (
      <LoadErrorView
        message={loadError || "账户数据不完整"}
        onRetry={() => void reload(true)}
      />
    )
  }

  const activeKeys = keys.filter((key) => key.enabled).length

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        title="总览"
        description="查看余额、密钥状态和最近 30 天的 API 用量。"
      />
      <StatStrip
        className="sm:grid-cols-2 xl:grid-cols-2"
        items={[
          {
            label: "账户余额",
            value: money(session.tenant?.balance_nano_usd),
            detail: "可用于余额支付的模型调用",
            icon: WalletCardsIcon,
          },
          {
            label: "有效密钥",
            value: activeKeys,
            detail: `${keys.length} 个密钥总计`,
            icon: KeyRoundIcon,
          },
        ]}
      />
      <div className="flex min-w-0 flex-wrap gap-2" aria-label="快捷操作">
        <Button onClick={() => onPageChange("keys")}>
          <HugeiconsIcon
            strokeWidth={2}
            icon={PlusIcon}
            data-icon="inline-start"
          />
          创建或管理密钥
        </Button>
        <Button variant="outline" onClick={() => onPageChange("guide")}>
          <HugeiconsIcon
            strokeWidth={2}
            icon={BookOpen01Icon}
            data-icon="inline-start"
          />
          查看接入指南
        </Button>
        <Button variant="outline" onClick={() => onPageChange("logs")}>
          <HugeiconsIcon
            strokeWidth={2}
            icon={FileClockIcon}
            data-icon="inline-start"
          />
          查看请求日志
        </Button>
      </div>
      <section
        className="flex min-w-0 flex-col gap-3"
        aria-labelledby="overview-usage"
      >
        <div>
          <h2 id="overview-usage" className="text-base font-semibold">
            最近 30 天用量
          </h2>
        </div>
        <UsageMetrics report={usage} />
        <UsageChart report={usage} />
      </section>
      <LogsTable
        logs={logs}
        workspace="user"
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

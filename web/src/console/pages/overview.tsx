import { useCallback } from "react"
import { Button } from "@cloudflare/kumo/components/button"
import { useAsyncResource } from "@/hooks/use-async-resource"
import {
  api,
  type ApiKey,
  type RequestLog,
  type Session,
  type UsageReport,
} from "@/lib/api"
import { dateTime, money, requestLogStatus } from "@/lib/format"
import { toast } from "@/lib/toast"
import {
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  Page,
  StatGrid,
  Surface,
} from "@/console/kit"

export function UserOverviewPage({
  session,
  onOpenLogs,
}: {
  session: Session
  onOpenLogs: () => void
}) {
  const load = useCallback(async () => {
    const [usage, logs, keys] = await Promise.all([
      api<UsageReport>("/api/usage?days=30"),
      api<{ items: RequestLog[] }>("/api/logs?limit=8"),
      api<{ items: ApiKey[] }>("/api/keys"),
    ])
    return {
      usage,
      logs: logs.items ?? [],
      keys: keys.items ?? [],
    }
  }, [])
  const { data, loading, error, reload } = useAsyncResource(load, {
    initialData: {
      usage: null as UsageReport | null,
      logs: [] as RequestLog[],
      keys: [] as ApiKey[],
    },
    errorMessage: "无法读取总览",
    onBackgroundError: (message) => toast.error(message),
  })

  if (loading) return <LoadingState />
  if (!data.usage) {
    return (
      <ErrorState
        message={error || "账户数据不完整"}
        onRetry={() => void reload(true)}
      />
    )
  }

  return (
    <Page title="总览" description="账户余额、近 30 天用量和最近请求。">
      <StatGrid
        items={[
          { label: "余额", value: money(session.tenant.balance_nano_usd) },
          {
            label: "近 30 天费用",
            value: money(data.usage.summary.cost_nano_usd),
          },
          { label: "近 30 天请求", value: data.usage.summary.requests },
          {
            label: "启用的 Key",
            value: data.keys.filter((key) => key.enabled).length,
          },
        ]}
      />
      <Surface
        title={
          <div className="flex items-center justify-between gap-3">
            <span>最近请求</span>
            <Button variant="ghost" size="sm" onClick={onOpenLogs}>
              全部日志
            </Button>
          </div>
        }
      >
        <DataTable
          columns={["时间", "模型", "状态", "费用"]}
          empty={<EmptyState title="还没有请求" />}
          rows={data.logs.map((log) => (
            <tr
              key={log.id}
              className="border-b border-kumo-hairline last:border-0"
            >
              <td className="px-3 py-2 text-kumo-subtle">
                {dateTime(log.started_at)}
              </td>
              <td className="px-3 py-2">{log.requested_model || log.model}</td>
              <td className="px-3 py-2">{requestLogStatus(log.status_code)}</td>
              <td className="px-3 py-2 tabular-nums">
                {money(log.cost_nano_usd)}
              </td>
            </tr>
          ))}
        />
      </Surface>
    </Page>
  )
}

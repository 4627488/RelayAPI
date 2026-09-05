import { useCallback } from "react"
import { useAsyncResource } from "@/hooks/use-async-resource"
import { api, type ChildSubscription } from "@/lib/api"
import { dateTime, money } from "@/lib/format"
import { toast } from "@/lib/toast"
import {
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  Page,
  Surface,
} from "@/console/kit"

export function TenantSubscriptionsPage() {
  const load = useCallback(async () => {
    const value = await api<{ items: ChildSubscription[] }>(
      "/api/subscriptions"
    )
    return value.items ?? []
  }, [])
  const { data, loading, error, reload } = useAsyncResource(load, {
    initialData: [],
    errorMessage: "无法读取订阅",
    onBackgroundError: (message) => toast.error(message),
  })

  if (loading) return <LoadingState />
  if (error && data.length === 0) {
    return <ErrorState message={error} onRetry={() => void reload(true)} />
  }

  return (
    <Page title="我的订阅" description="分配给你的子订阅、已用额度和重置时间。">
      <Surface>
        <DataTable
          columns={["名称", "来源", "状态", "剩余", "重置"]}
          empty={
            <EmptyState
              title="还没有订阅"
              description="管理员分配后会出现在这里。"
            />
          }
          rows={data.map((item) => {
            const window = item.entitlement_windows?.[0]
            return (
              <tr
                key={item.id}
                className="border-b border-kumo-hairline last:border-0"
              >
                <td className="px-3 py-2">{item.name}</td>
                <td className="px-3 py-2 text-kumo-subtle">
                  {item.parent_name || item.parent_plan_type || "—"}
                </td>
                <td className="px-3 py-2">
                  {item.available === false
                    ? item.availability_message || "不可用"
                    : item.enabled
                      ? "生效中"
                      : "已停用"}
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {window ? money(window.remaining_nano_usd) : "—"}
                </td>
                <td className="px-3 py-2 text-kumo-subtle">
                  {dateTime(window?.resets_at)}
                </td>
              </tr>
            )
          })}
        />
      </Surface>
    </Page>
  )
}

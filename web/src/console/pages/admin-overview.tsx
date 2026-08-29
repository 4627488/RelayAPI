import { useCallback } from "react"
import { useAsyncResource } from "@/hooks/use-async-resource"
import { api, type AdminOverview } from "@/lib/api"
import { compactTokens, money } from "@/lib/format"
import { toast } from "@/lib/toast"
import { ErrorState, LoadingState, Page, StatGrid } from "@/console/kit"

export function AdminOverviewPage() {
  const load = useCallback(() => api<AdminOverview>("/api/admin/overview"), [])
  const { data, loading, error, reload } = useAsyncResource(load, {
    initialData: null,
    errorMessage: "无法读取总览",
    onBackgroundError: (message) => toast.error(message),
  })

  if (loading) return <LoadingState />
  if (!data) {
    return (
      <ErrorState
        message={error || "数据不完整"}
        onRetry={() => void reload(true)}
      />
    )
  }

  return (
    <Page title="管理总览" description="用户、Key、邀请和今日用量。">
      <StatGrid
        items={[
          {
            label: "用户",
            value: data.users,
            detail: `${data.enabled_users} 启用`,
          },
          { label: "启用 Key", value: data.active_api_keys },
          { label: "待处理邀请", value: data.pending_invitations },
          { label: "今日请求", value: data.today.requests },
          { label: "今日 Token", value: compactTokens(data.today.tokens) },
          { label: "今日费用", value: money(data.today.cost_nano_usd) },
          { label: "今日错误", value: data.today.errors },
        ]}
      />
    </Page>
  )
}

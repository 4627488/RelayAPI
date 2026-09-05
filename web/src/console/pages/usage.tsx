import { useCallback, useState } from "react"
import { Select } from "@cloudflare/kumo/components/select"
import { useAsyncResource } from "@/hooks/use-async-resource"
import { api, type UsageReport, type User } from "@/lib/api"
import { compactTokens, money } from "@/lib/format"
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

export function UsagePage({ admin = false }: { admin?: boolean }) {
  const [days, setDays] = useState("30")
  const [userId, setUserId] = useState("all")
  const loadTenants = useCallback(async () => {
    if (!admin) return [] as User[]
    const value = await api<{ items: User[] }>("/api/admin/tenants")
    return value.items ?? []
  }, [admin])
  const tenants = useAsyncResource(loadTenants, {
    initialData: [] as User[],
    errorMessage: "无法读取用户",
    onBackgroundError: (message) => toast.error(message),
  })
  const load = useCallback(async () => {
    const query = new URLSearchParams({ days })
    if (admin && userId && userId !== "all") query.set("user_id", userId)
    const path = admin ? `/api/admin/usage?${query}` : `/api/usage?${query}`
    return api<UsageReport>(path)
  }, [admin, days, userId])
  const { data, loading, error, reload } = useAsyncResource(load, {
    initialData: null,
    errorMessage: "无法读取用量",
    onBackgroundError: (message) => toast.error(message),
  })

  return (
    <Page
      title={admin ? "全局用量" : "用量"}
      description={
        admin ? "按用户、模型和 Key 聚合。" : "按天、模型和 API Key 聚合。"
      }
      actions={
        <div className="flex flex-wrap items-end gap-2">
          {admin ? (
            <Select
              aria-label="用户筛选"
              value={userId}
              onValueChange={(value) => setUserId(value ?? "all")}
              items={{
                all: "全部用户",
                ...Object.fromEntries(
                  tenants.data.map((user) => [
                    user.id,
                    user.name || user.owner_email,
                  ])
                ),
              }}
              className="w-40"
            />
          ) : null}
          <Select
            aria-label="天数"
            value={days}
            onValueChange={(value) => setDays(value ?? "30")}
            items={{ "7": "7 天", "30": "30 天", "90": "90 天" }}
            className="w-28"
          />
        </div>
      }
    >
      {loading && !data ? <LoadingState /> : null}
      {error && !data ? (
        <ErrorState message={error} onRetry={() => void reload(true)} />
      ) : null}
      {data ? (
        <>
          <StatGrid
            items={[
              { label: "请求", value: data.summary.requests },
              { label: "错误", value: data.summary.errors },
              { label: "Token", value: compactTokens(data.summary.tokens) },
              { label: "费用", value: money(data.summary.cost_nano_usd) },
            ]}
          />
          <Surface title="按日">
            <DataTable
              columns={["日期", "请求", "Token", "费用"]}
              empty={<EmptyState title="这段时间没有用量" />}
              rows={data.daily.map((row) => (
                <tr
                  key={row.date}
                  className="border-b border-kumo-hairline last:border-0"
                >
                  <td className="px-3 py-2">{row.date}</td>
                  <td className="px-3 py-2 tabular-nums">{row.requests}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {compactTokens(row.tokens)}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {money(row.cost_nano_usd)}
                  </td>
                </tr>
              ))}
            />
          </Surface>
          <Surface title="按模型">
            <DataTable
              columns={["模型", "请求", "Token", "费用"]}
              empty={<EmptyState title="没有模型用量" />}
              rows={data.models.map((row) => (
                <tr
                  key={row.model}
                  className="border-b border-kumo-hairline last:border-0"
                >
                  <td className="px-3 py-2">{row.model}</td>
                  <td className="px-3 py-2 tabular-nums">{row.requests}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {compactTokens(row.tokens)}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {money(row.cost_nano_usd)}
                  </td>
                </tr>
              ))}
            />
          </Surface>
          <Surface title="按 API Key">
            <DataTable
              columns={["Key", "请求", "Token", "费用"]}
              empty={<EmptyState title="没有 Key 用量" />}
              rows={data.api_keys.map((row) => (
                <tr
                  key={row.api_key_id}
                  className="border-b border-kumo-hairline last:border-0"
                >
                  <td className="px-3 py-2">
                    {row.api_key_name || row.api_key_prefix}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{row.requests}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {compactTokens(row.tokens)}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {money(row.cost_nano_usd)}
                  </td>
                </tr>
              ))}
            />
          </Surface>
          {admin ? (
            <Surface title="按用户">
              <DataTable
                columns={["用户", "请求", "Token", "费用"]}
                empty={<EmptyState title="没有用户用量" />}
                rows={data.users.map((row) => (
                  <tr
                    key={row.tenant_id}
                    className="border-b border-kumo-hairline last:border-0"
                  >
                    <td className="px-3 py-2">{row.tenant_name}</td>
                    <td className="px-3 py-2 tabular-nums">{row.requests}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {compactTokens(row.tokens)}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {money(row.cost_nano_usd)}
                    </td>
                  </tr>
                ))}
              />
            </Surface>
          ) : null}
        </>
      ) : null}
    </Page>
  )
}

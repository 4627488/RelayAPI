import { useCallback, useState, type FormEvent } from "react"
import { Button } from "@cloudflare/kumo/components/button"
import { Input } from "@cloudflare/kumo/components/input"
import { useAsyncResource } from "@/hooks/use-async-resource"
import {
  api,
  type RequestLog,
  type RequestLogDetail,
  type RequestLogPage,
} from "@/lib/api"
import {
  dateTime,
  money,
  requestLogStatus,
  requestLogTransport,
} from "@/lib/format"
import { toast } from "@/lib/toast"
import {
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  Page,
  Surface,
} from "@/console/kit"

export function LogsPage({
  admin = false,
  selectedId,
  onSelect,
}: {
  admin?: boolean
  selectedId?: string
  onSelect: (id?: string) => void
}) {
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(1)
  const load = useCallback(async () => {
    const params = new URLSearchParams({
      page: String(page),
      page_size: "50",
    })
    if (query) params.set("query", query)
    const path = admin ? `/api/admin/logs?${params}` : `/api/logs?${params}`
    return api<RequestLogPage>(path)
  }, [admin, page, query])
  const { data, loading, error, reload } = useAsyncResource(load, {
    initialData: null,
    errorMessage: "无法读取日志",
    onBackgroundError: (message) => toast.error(message),
  })

  const detailPath = selectedId
    ? admin
      ? `/api/admin/logs/${encodeURIComponent(selectedId)}`
      : `/api/logs/${encodeURIComponent(selectedId)}`
    : ""
  const loadDetail = useCallback(async () => {
    if (!detailPath) return null
    return api<{ log: RequestLog; detail: RequestLogDetail }>(detailPath)
  }, [detailPath])
  const detail = useAsyncResource(loadDetail, {
    initialData: null,
    errorMessage: "无法读取日志详情",
    onBackgroundError: (message) => toast.error(message),
  })

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = String(new FormData(event.currentTarget).get("query") ?? "")
    setQuery(value)
    setPage(1)
  }

  return (
    <Page
      title="请求日志"
      description={
        admin ? "全站请求，可搜索和分页。" : "当前账户范围内的请求。"
      }
    >
      <form className="flex gap-2" onSubmit={search}>
        <Input
          name="query"
          defaultValue={query}
          placeholder="搜索模型、状态或错误"
          aria-label="搜索日志"
          className="max-w-sm"
        />
        <Button type="submit" variant="secondary">
          搜索
        </Button>
      </form>
      {loading && !data ? <LoadingState /> : null}
      {error && !data ? (
        <ErrorState message={error} onRetry={() => void reload(true)} />
      ) : null}
      {data ? (
        <Surface>
          <DataTable
            columns={["时间", "模型", "传输", "状态", "费用"]}
            empty={<EmptyState title="没有匹配的请求" />}
            rows={data.items.map((log) => (
              <tr
                key={log.id}
                className="cursor-pointer border-b border-kumo-hairline last:border-0 hover:bg-kumo-tint"
                onClick={() => onSelect(log.id)}
              >
                <td className="px-3 py-2 text-kumo-subtle">
                  {dateTime(log.started_at)}
                </td>
                <td className="px-3 py-2">
                  {log.requested_model || log.model}
                </td>
                <td className="px-3 py-2">
                  {requestLogTransport(log.request_type, log.stream)}
                </td>
                <td className="px-3 py-2">
                  {requestLogStatus(log.status_code)}
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {money(log.cost_nano_usd)}
                </td>
              </tr>
            ))}
          />
          <div className="flex items-center justify-between px-3 py-2 text-xs text-kumo-subtle">
            <span>
              第 {data.page} 页 · 共 {data.total} 条
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                上一页
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={data.items.length < data.page_size}
                onClick={() => setPage((value) => value + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        </Surface>
      ) : null}
      {selectedId ? (
        <Surface
          title={
            <div className="flex items-center justify-between gap-3">
              <span>请求详情</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onSelect(undefined)}
              >
                关闭
              </Button>
            </div>
          }
        >
          {detail.loading ? <LoadingState label="读取详情" /> : null}
          {detail.error && !detail.data ? (
            <ErrorState
              message={detail.error}
              onRetry={() => void detail.reload(true)}
            />
          ) : null}
          {detail.data ? (
            <pre className="max-h-[28rem] overflow-auto font-mono text-xs leading-relaxed">
              {JSON.stringify(detail.data, null, 2)}
            </pre>
          ) : null}
        </Surface>
      ) : null}
    </Page>
  )
}

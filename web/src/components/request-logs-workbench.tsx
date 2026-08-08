import { useCallback, useEffect, useMemo, useState } from "react"
import { ActivityIcon, Clock3Icon, CoinsIcon, TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"

import { MetricGrid } from "@/components/data-views"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  api,
  type RequestLog,
  type RequestLogDetail,
  type RequestLogPage,
} from "@/lib/api"
import { compact, compactTokens, dateTime, money, requestLogStatus, requestLogSucceeded } from "@/lib/format"

const emptyPage: RequestLogPage = {
  items: [],
  page: 1,
  page_size: 50,
  total: 0,
  summary: { requests: 0, errors: 0, tokens: 0, cached_tokens: 0, cost_nano_usd: 0, average_latency_ms: 0 },
}

export function RequestLogsWorkbench({ admin = false }: { admin?: boolean }) {
  const [data, setData] = useState<RequestLogPage>(emptyPage)
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState("")
  const [method, setMethod] = useState("")
  const [model, setModel] = useState("")
  const [minLatency, setMinLatency] = useState("")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<{ log: RequestLog; detail: RequestLogDetail | null } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) })
      if (query.trim()) params.set("query", query.trim())
      if (status) params.set("status", status)
      if (method) params.set("method", method)
      if (model.trim()) params.set("model", model.trim())
      if (minLatency) params.set("min_latency_ms", minLatency)
      if (from) params.set("from", new Date(from).toISOString())
      if (to) params.set("to", new Date(to).toISOString())
      const prefix = admin ? "/api/admin/logs" : "/api/logs"
      setData(await api<RequestLogPage>(`${prefix}?${params}`))
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "读取请求日志失败")
    } finally {
      setLoading(false)
    }
  }, [admin, from, method, minLatency, model, page, pageSize, query, status, to])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200)
    return () => window.clearTimeout(timer)
  }, [load])

  async function openDetail(log: RequestLog) {
    try {
      const prefix = admin ? "/api/admin/logs" : "/api/logs"
      setSelected(await api<{ log: RequestLog; detail: RequestLogDetail | null }>(`${prefix}/${log.id}`))
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "读取日志详情失败")
    }
  }

  const totalPages = Math.max(1, Math.ceil(data.total / data.page_size))
  const cacheRate = data.summary.tokens > 0 ? data.summary.cached_tokens / data.summary.tokens : 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">请求日志</h1>
        <p className="text-sm text-muted-foreground">完整请求链路、CPA 执行信息、历史价格与错误诊断。</p>
      </div>
      <MetricGrid
        items={[
          { label: "请求", value: compact(data.summary.requests), hint: `${data.summary.errors} 个错误`, icon: ActivityIcon },
          { label: "Tokens", value: compactTokens(data.summary.tokens), hint: `缓存命中 ${(cacheRate * 100).toFixed(1)}%`, icon: CoinsIcon },
          { label: "平均耗时", value: `${Math.round(data.summary.average_latency_ms)} ms`, hint: "当前筛选范围", icon: Clock3Icon },
          { label: "错误率", value: data.summary.requests ? `${(data.summary.errors / data.summary.requests * 100).toFixed(1)}%` : "0%", hint: money(data.summary.cost_nano_usd), icon: TriangleAlertIcon },
        ]}
      />
      <Card>
        <CardHeader>
          <CardTitle>请求明细</CardTitle>
          <CardDescription>点击任意请求查看请求体、转发内容、上游响应和计费快照。</CardDescription>
          <div className="grid gap-2 pt-2 md:grid-cols-[1fr_10rem_10rem_auto]">
            <Input
              value={query}
              onChange={(event) => { setQuery(event.target.value); setPage(1) }}
              placeholder="搜索模型、路径、用户、Key、Trace ID 或错误"
            />
            <select
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={status}
              onChange={(event) => { setStatus(event.target.value); setPage(1) }}
            >
              <option value="">全部状态</option>
              <option value="success">成功</option>
              <option value="error">错误</option>
              <option value="stream">流式</option>
            </select>
            <select
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={method}
              onChange={(event) => { setMethod(event.target.value); setPage(1) }}
            >
              <option value="">全部方法</option>
              {["POST", "GET", "PUT", "PATCH", "DELETE"].map((value) => <option key={value}>{value}</option>)}
            </select>
            <Button variant="outline" onClick={() => void load()} disabled={loading}>刷新</Button>
          </div>
          <div className="grid gap-2 md:grid-cols-4">
            <Input value={model} onChange={(event) => { setModel(event.target.value); setPage(1) }} placeholder="精确模型" />
            <Input value={minLatency} onChange={(event) => { setMinLatency(event.target.value); setPage(1) }} type="number" min="0" placeholder="最小耗时（ms）" />
            <Input value={from} onChange={(event) => { setFrom(event.target.value); setPage(1) }} type="datetime-local" aria-label="开始时间" />
            <Input value={to} onChange={(event) => { setTo(event.target.value); setPage(1) }} type="datetime-local" aria-label="结束时间" />
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>类型 / 模型</TableHead>
                {admin ? <TableHead>用户 / Key</TableHead> : null}
                <TableHead>CPA</TableHead>
                <TableHead className="text-right">Token</TableHead>
                <TableHead className="text-right">TTFT / 总耗时</TableHead>
                <TableHead className="text-right">费用</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((log) => (
                <TableRow key={log.id} className="cursor-pointer" onClick={() => void openDetail(log)}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{dateTime(log.started_at)}</TableCell>
                  <TableCell>
                    <Badge variant={requestLogSucceeded(log.status_code, log.error_code) ? "secondary" : "destructive"}>
                      {requestLogStatus(log.status_code)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <p className="text-xs text-muted-foreground">{log.request_type || `${log.method} ${log.path}`}</p>
                    <p className="max-w-64 truncate font-mono text-xs">{log.actual_model || log.requested_model || log.model}</p>
                  </TableCell>
                  {admin ? (
                    <TableCell>
                      <p className="text-sm">{log.tenant_name || log.tenant_id}</p>
                      <p className="text-xs text-muted-foreground">{log.api_key_name || log.api_key_prefix}</p>
                    </TableCell>
                  ) : null}
                  <TableCell>
                    <p className="text-xs">{log.provider || "—"} {log.auth_index ? `· ${log.auth_index}` : ""}</p>
                    <p className="max-w-44 truncate font-mono text-[11px] text-muted-foreground">{log.cpa_trace_id || log.cpa_execution_id || "—"}</p>
                  </TableCell>
                  <TableCell className="text-right">
                    <p className="tabular-nums">{compactTokens(log.total_tokens)}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {compactTokens(log.prompt_tokens)} / {compactTokens(log.completion_tokens)} · C {compactTokens(log.cached_tokens)}
                    </p>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular-nums">
                    {log.ttft_ms ?? "—"} / {log.latency_ms} ms
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(log.cost_nano_usd)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!data.items.length ? <p className="py-10 text-center text-sm text-muted-foreground">没有符合条件的请求。</p> : null}
          <div className="flex items-center justify-between pt-4">
            <div className="flex items-center gap-2">
              <p className="text-xs text-muted-foreground">第 {data.page} / {totalPages} 页，共 {data.total} 条</p>
              <select
                className="h-8 rounded-md border bg-background px-2 text-xs"
                value={pageSize}
                onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1) }}
              >
                {[25, 50, 100, 200].map((value) => <option key={value} value={value}>{value} / 页</option>)}
              </select>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>下一页</Button>
            </div>
          </div>
        </CardContent>
      </Card>
      <LogDetailDialog value={selected} onOpenChange={(open) => { if (!open) setSelected(null) }} />
    </div>
  )
}

function LogDetailDialog({
  value,
  onOpenChange,
}: {
  value: { log: RequestLog; detail: RequestLogDetail | null } | null
  onOpenChange: (open: boolean) => void
}) {
  const log = value?.log
  const detail = value?.detail
  const costRows = useMemo(() => {
    if (!log) return []
    const uncached = Math.max(0, log.prompt_tokens - log.cached_tokens)
    return [
      ["普通输入", uncached, log.input_price_nano_usd_per_token ?? 0],
      ["缓存读取", log.cached_tokens, log.cached_input_price_nano_usd_per_token ?? 0],
      ["缓存写入", log.cache_write_tokens, log.cache_write_price_nano_usd_per_token ?? 0],
      ["输出", log.completion_tokens, log.output_price_nano_usd_per_token ?? 0],
      ["推理", log.reasoning_tokens, log.reasoning_price_nano_usd_per_token ?? 0],
    ] as Array<[string, number, number]>
  }, [log])
  return (
    <Dialog open={Boolean(value)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>请求详情</DialogTitle>
          <DialogDescription className="font-mono">{log?.id}</DialogDescription>
        </DialogHeader>
        {log ? (
          <Tabs defaultValue="summary">
            <TabsList>
              <TabsTrigger value="summary">摘要与计费</TabsTrigger>
              <TabsTrigger value="request">客户端请求</TabsTrigger>
              <TabsTrigger value="forwarded">CPA 转发</TabsTrigger>
              <TabsTrigger value="response">上游响应</TabsTrigger>
              <TabsTrigger value="error">错误与耗时</TabsTrigger>
            </TabsList>
            <TabsContent value="summary" className="space-y-4 pt-4">
              <div className="grid gap-3 rounded-lg border p-4 text-sm sm:grid-cols-3">
                <Detail label="请求" value={`${log.method} ${log.path}`} />
                <Detail label="模型" value={`${log.requested_model || log.model}${log.actual_model ? ` → ${log.actual_model}` : ""}`} />
                <Detail label="CPA" value={`${log.provider || "—"} / ${log.credential_email || log.credential_name || log.auth_index || "—"}`} />
                <Detail label="状态" value={`${log.status_code || "中断"} · ${log.stream ? "流式" : "非流式"}`} />
                <Detail label="耗时" value={`TTFT ${log.ttft_ms ?? "—"} ms · 总计 ${log.latency_ms} ms`} />
                <Detail label="价格" value={`${log.price_source || "未定价"} · ${log.price_version || "—"}`} />
                <Detail label="订阅" value={`${log.parent_subscription_name || log.channel_name || "—"} / ${log.child_subscription_name || "—"}`} />
              </div>
              <Table>
                <TableHeader><TableRow><TableHead>成本项</TableHead><TableHead className="text-right">Tokens</TableHead><TableHead className="text-right">nanoUSD/token</TableHead><TableHead className="text-right">成本</TableHead></TableRow></TableHeader>
                <TableBody>
                  {costRows.map(([label, tokens, rate]) => (
                    <TableRow key={label}><TableCell>{label}</TableCell><TableCell className="text-right">{tokens}</TableCell><TableCell className="text-right">{rate}</TableCell><TableCell className="text-right">{money(tokens * rate)}</TableCell></TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="text-right font-medium">合计：{money(log.cost_nano_usd)}</p>
            </TabsContent>
            <TabsContent value="request" className="space-y-4 pt-4">
              <Payload title="Headers（敏感字段已脱敏）" value={prettyJSON(detail?.request_headers)} />
              <Payload title={`Body · ${detail?.request_body_bytes ?? 0} bytes${detail?.request_body_truncated ? " · 已截断" : ""}`} value={prettyJSON(detail?.request_body)} />
            </TabsContent>
            <TabsContent value="forwarded" className="space-y-4 pt-4">
              <Payload title="Headers（敏感字段已脱敏）" value={prettyJSON(detail?.forwarded_headers)} />
              <Payload title={`转换后 Body · ${detail?.forwarded_body_bytes ?? 0} bytes${detail?.forwarded_body_truncated ? " · 已截断" : ""}`} value={prettyJSON(detail?.forwarded_body)} />
            </TabsContent>
            <TabsContent value="response" className="space-y-4 pt-4">
              <Payload title={`HTTP ${detail?.upstream_status || log.status_code} Headers`} value={prettyJSON(detail?.upstream_headers)} />
              <Payload title={`Body · ${detail?.upstream_body_bytes ?? 0} bytes${detail?.upstream_body_truncated ? " · 已截断" : ""}`} value={prettyJSON(detail?.upstream_body)} />
            </TabsContent>
            <TabsContent value="error" className="space-y-4 pt-4">
              <Payload title="阶段耗时" value={prettyJSON(detail?.stage_timings)} />
              <Payload title={`${log.error_code || detail?.error_name || "无错误"}`} value={detail?.error_detail || detail?.error_message || log.error_message || "请求成功完成"} />
            </TabsContent>
          </Tabs>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><p className="text-xs text-muted-foreground">{label}</p><p className="break-all">{value}</p></div>
}

function Payload({ title, value }: { title: string; value: string }) {
  return <section><h3 className="mb-2 text-sm font-medium">{title}</h3><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-4 text-xs">{value || "—"}</pre></section>
}

function prettyJSON(value?: string) {
  if (!value) return ""
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

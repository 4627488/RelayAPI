import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  RefreshCwIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { SearchField, StatStrip } from "@/components/workspace-ui"
import {
  api,
  type RequestLog,
  type RequestLogDetail,
  type RequestLogPage,
} from "@/lib/api"
import {
  bytes,
  cacheHitRateLabel,
  compact,
  compactTokens,
  dateTime,
  money,
  requestLogStatus,
  requestLogSucceeded,
} from "@/lib/format"
import { cn } from "@/lib/utils"
import { RequestLatencyTimeline } from "@/components/request-latency-timeline"
import { CacheHitRateBadge } from "@/components/token-cache-rate"

const emptyPage: RequestLogPage = {
  items: [],
  page: 1,
  page_size: 50,
  total: 0,
  summary: {
    requests: 0,
    errors: 0,
    tokens: 0,
    prompt_tokens: 0,
    cached_tokens: 0,
    cost_nano_usd: 0,
    average_latency_ms: 0,
    latency_p50_ms: 0,
    latency_p95_ms: 0,
    ttft_p50_ms: 0,
    ttft_p95_ms: 0,
    ttft_samples: 0,
    request_bytes: 0,
    response_bytes: 0,
  },
}

type SelectedLog = {
  log: RequestLog
  detail: RequestLogDetail | null
}

export function RequestLogsWorkbench({ admin = false }: { admin?: boolean }) {
  const [data, setData] = useState<RequestLogPage>(emptyPage)
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState("all")
  const [method, setMethod] = useState("all")
  const [model, setModel] = useState("")
  const [minLatency, setMinLatency] = useState("")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [selected, setSelected] = useState<SelectedLog | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        page: String(page),
        page_size: String(pageSize),
      })
      if (query.trim()) params.set("query", query.trim())
      if (status !== "all") params.set("status", status)
      if (method !== "all") params.set("method", method)
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
  }, [
    admin,
    from,
    method,
    minLatency,
    model,
    page,
    pageSize,
    query,
    status,
    to,
  ])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200)
    return () => window.clearTimeout(timer)
  }, [load])

  async function openDetail(log: RequestLog) {
    setSelected({ log, detail: null })
    setDetailLoading(true)
    try {
      const prefix = admin ? "/api/admin/logs" : "/api/logs"
      setSelected(await api<SelectedLog>(`${prefix}/${log.id}`))
    } catch (cause) {
      setSelected(null)
      toast.error(cause instanceof Error ? cause.message : "读取日志详情失败")
    } finally {
      setDetailLoading(false)
    }
  }

  function resetFilters() {
    setQuery("")
    setStatus("all")
    setMethod("all")
    setModel("")
    setMinLatency("")
    setFrom("")
    setTo("")
    setPage(1)
  }

  const totalPages = Math.max(1, Math.ceil(data.total / data.page_size))
  const cacheRate = cacheHitRateLabel(
    data.summary.cached_tokens,
    data.summary.prompt_tokens
  )
  const advancedFilterCount = [
    method !== "all",
    model,
    minLatency,
    from,
    to,
  ].filter(Boolean).length
  const hasFilters = Boolean(query || status !== "all" || advancedFilterCount)

  return (
    <div className="flex flex-col gap-4">
      <StatStrip
        className="sm:grid-cols-3 xl:grid-cols-6"
        items={[
          {
            label: "请求",
            value: compact(data.summary.requests),
            detail: `${data.summary.errors} 个错误`,
          },
          {
            label: "错误率",
            value: data.summary.requests
              ? `${((data.summary.errors / data.summary.requests) * 100).toFixed(1)}%`
              : "0%",
            detail: "HTTP 错误或中断",
          },
          {
            label: "Tokens",
            value: compactTokens(data.summary.tokens),
            detail: `缓存命中 ${cacheRate}`,
          },
          {
            label: "负载",
            value: bytes(
              data.summary.request_bytes + data.summary.response_bytes
            ),
            detail: `${bytes(data.summary.request_bytes)} ↑ · ${bytes(data.summary.response_bytes)} ↓`,
          },
          {
            label: "总耗时",
            value: data.summary.requests
              ? `P50 ${formatMS(data.summary.latency_p50_ms)}`
              : "无数据",
            detail: data.summary.requests
              ? `P95 ${formatMS(data.summary.latency_p95_ms)}`
              : "当前筛选范围",
          },
          { label: "费用", value: money(data.summary.cost_nano_usd) },
        ]}
      />

      <Card>
        <CardHeader className="border-b">
          <CardTitle>请求明细</CardTitle>
          <CardDescription>
            点击一行打开详情；负载大小不依赖正文采样，会随日志摘要保留。
          </CardDescription>
          <FieldGroup className="grid gap-2 pt-2 md:grid-cols-[minmax(16rem,1fr)_9rem_auto_auto]">
            <Field>
              <FieldLabel htmlFor="log-search" className="sr-only">
                搜索日志
              </FieldLabel>
              <SearchField
                id="log-search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setPage(1)
                }}
                onClear={() => setQuery("")}
                placeholder="搜索模型、路径、用户、Key、Trace ID 或错误"
              />
            </Field>
            <Field>
              <FieldLabel className="sr-only">状态</FieldLabel>
              <Select
                items={{
                  all: "全部状态",
                  success: "成功",
                  error: "错误",
                  stream: "流式",
                }}
                value={status}
                onValueChange={(value) => {
                  if (value) {
                    setStatus(value)
                    setPage(1)
                  }
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">全部状态</SelectItem>
                    <SelectItem value="success">成功</SelectItem>
                    <SelectItem value="error">错误</SelectItem>
                    <SelectItem value="stream">流式</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Collapsible
              open={filtersOpen}
              onOpenChange={setFiltersOpen}
              className="contents"
            >
              <CollapsibleTrigger render={<Button variant="outline" />}>
                <SlidersHorizontalIcon data-icon="inline-start" />
                筛选{advancedFilterCount ? ` ${advancedFilterCount}` : ""}
                <ChevronDownIcon
                  data-icon="inline-end"
                  className={cn(
                    "transition-transform",
                    filtersOpen && "rotate-180"
                  )}
                />
              </CollapsibleTrigger>
              <Button
                variant="outline"
                onClick={() => void load()}
                disabled={loading}
              >
                {loading ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <RefreshCwIcon data-icon="inline-start" />
                )}
                刷新
              </Button>
              <CollapsibleContent className="col-span-full pt-2">
                <FieldGroup className="grid gap-3 md:grid-cols-5">
                  <Field>
                    <FieldLabel>方法</FieldLabel>
                    <Select
                      items={[
                        { value: "all", label: "全部方法" },
                        ...["POST", "GET", "PUT", "PATCH", "DELETE"].map(
                          (value) => ({ value, label: value })
                        ),
                      ]}
                      value={method}
                      onValueChange={(value) => {
                        if (value) {
                          setMethod(value)
                          setPage(1)
                        }
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="all">全部方法</SelectItem>
                          {["POST", "GET", "PUT", "PATCH", "DELETE"].map(
                            (value) => (
                              <SelectItem key={value} value={value}>
                                {value}
                              </SelectItem>
                            )
                          )}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="log-model">精确模型</FieldLabel>
                    <Input
                      id="log-model"
                      value={model}
                      onChange={(event) => {
                        setModel(event.target.value)
                        setPage(1)
                      }}
                      placeholder="例如 gpt-5.6"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="log-latency">最小耗时</FieldLabel>
                    <Input
                      id="log-latency"
                      value={minLatency}
                      onChange={(event) => {
                        setMinLatency(event.target.value)
                        setPage(1)
                      }}
                      type="number"
                      min="0"
                      placeholder="毫秒"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="log-from">开始时间</FieldLabel>
                    <Input
                      id="log-from"
                      value={from}
                      onChange={(event) => {
                        setFrom(event.target.value)
                        setPage(1)
                      }}
                      type="datetime-local"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="log-to">结束时间</FieldLabel>
                    <Input
                      id="log-to"
                      value={to}
                      onChange={(event) => {
                        setTo(event.target.value)
                        setPage(1)
                      }}
                      type="datetime-local"
                    />
                  </Field>
                </FieldGroup>
                {hasFilters ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-3"
                    onClick={resetFilters}
                  >
                    <XIcon data-icon="inline-start" />
                    清除全部筛选
                  </Button>
                ) : null}
              </CollapsibleContent>
            </Collapsible>
          </FieldGroup>
        </CardHeader>

        <CardContent className="px-0">
          {data.items.length ? (
            <Table className={cn(loading && "opacity-60")}>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">时间</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>请求</TableHead>
                  <TableHead>客户端</TableHead>
                  {admin ? <TableHead>用户</TableHead> : null}
                  <TableHead className="text-right">Token</TableHead>
                  <TableHead className="text-right">负载</TableHead>
                  <TableHead className="text-right">耗时</TableHead>
                  <TableHead className="pr-4 text-right">费用</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((log) => (
                  <TableRow
                    key={log.id}
                    role="button"
                    tabIndex={0}
                    className="cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
                    onClick={() => void openDetail(log)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault()
                        void openDetail(log)
                      }
                    }}
                  >
                    <TableCell className="pl-4 whitespace-nowrap text-muted-foreground">
                      {dateTime(log.started_at)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Badge
                          variant={
                            requestLogSucceeded(log.status_code, log.error_code)
                              ? "secondary"
                              : "destructive"
                          }
                        >
                          {requestLogStatus(log.status_code)}
                        </Badge>
                        {log.stream && log.status_code !== 101 ? (
                          <span className="text-xs text-muted-foreground">
                            流式
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <p className="max-w-72 truncate font-mono text-xs">
                        {log.actual_model ||
                          log.requested_model ||
                          log.model ||
                          log.path}
                      </p>
                      <p className="max-w-72 truncate text-xs text-muted-foreground">
                        {log.request_type || `${log.method} ${log.path}`}
                        {log.provider
                          ? ` · ${log.provider}${log.auth_index ? ` / ${log.auth_index}` : ""}`
                          : ""}
                      </p>
                    </TableCell>
                    <TableCell title={log.user_agent || undefined}>
                      <p className="max-w-44 truncate text-sm">
                        {log.client_name || "未知客户端"}
                      </p>
                      <p className="max-w-44 truncate font-mono text-xs text-muted-foreground">
                        {log.client_version || "—"}
                      </p>
                    </TableCell>
                    {admin ? (
                      <TableCell>
                        <p className="max-w-40 truncate text-sm">
                          {log.tenant_name || log.tenant_id}
                        </p>
                        <p className="max-w-40 truncate text-xs text-muted-foreground">
                          {log.api_key_name || log.api_key_prefix || "—"}
                        </p>
                      </TableCell>
                    ) : null}
                    <TableCell className="text-right tabular-nums">
                      <span className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap">
                        <span>{compactTokens(log.total_tokens)}</span>
                        <CacheHitRateBadge
                          cachedTokens={log.cached_tokens}
                          promptTokens={log.prompt_tokens}
                        />
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap tabular-nums">
                      <span>{bytes(log.request_body_bytes)}</span>
                      <ArrowRightIcon className="mx-1 inline size-3 text-muted-foreground" />
                      <span>{bytes(log.response_body_bytes)}</span>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap tabular-nums">
                      <p>{log.latency_ms} ms</p>
                      {log.ttft_ms != null ? (
                        <p className="text-xs text-muted-foreground">
                          首字节 {log.ttft_ms} ms
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="pr-4 text-right tabular-nums">
                      {money(log.cost_nano_usd)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty className="min-h-72 rounded-none border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchIcon />
                </EmptyMedia>
                <EmptyTitle>
                  {hasFilters ? "没有匹配的请求" : "暂无请求记录"}
                </EmptyTitle>
                <EmptyDescription>
                  {hasFilters
                    ? "调整或清除筛选条件后再试。"
                    : "API 调用记录会显示在这里。"}
                </EmptyDescription>
              </EmptyHeader>
              {hasFilters ? (
                <Button variant="outline" size="sm" onClick={resetFilters}>
                  清除筛选
                </Button>
              ) : null}
            </Empty>
          )}
        </CardContent>

        <CardFooter className="justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {data.total} 条 · 第 {data.page}/{totalPages} 页
            </span>
            <Select
              items={[25, 50, 100, 200].map((value) => ({
                value: String(value),
                label: `${value} / 页`,
              }))}
              value={String(pageSize)}
              onValueChange={(value) => {
                if (value) {
                  setPageSize(Number(value))
                  setPage(1)
                }
              }}
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {[25, 50, 100, 200].map((value) => (
                    <SelectItem key={value} value={String(value)}>
                      {value} / 页
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={page <= 1}
              onClick={() => setPage((value) => value - 1)}
              aria-label="上一页"
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={page >= totalPages}
              onClick={() => setPage((value) => value + 1)}
              aria-label="下一页"
            >
              <ChevronRightIcon />
            </Button>
          </div>
        </CardFooter>
      </Card>

      <LogDetailSheet
        value={selected}
        loading={detailLoading}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
      />
    </div>
  )
}

function LogDetailSheet({
  value,
  loading,
  onOpenChange,
}: {
  value: SelectedLog | null
  loading: boolean
  onOpenChange: (open: boolean) => void
}) {
  const log = value?.log
  const detail = value?.detail ?? null
  const requestVisible = Boolean(
    detail &&
    (hasJSONObject(detail.request_headers) ||
      detail.request_body ||
      detail.request_body_bytes)
  )
  const forwardedVisible = Boolean(
    detail &&
    (hasJSONObject(detail.forwarded_headers) ||
      detail.forwarded_body ||
      detail.forwarded_body_bytes)
  )
  const responseVisible = Boolean(
    detail &&
    (detail.upstream_status ||
      hasJSONObject(detail.upstream_headers) ||
      detail.upstream_body ||
      detail.upstream_body_bytes)
  )
  const detailSections =
    Number(requestVisible) + Number(forwardedVisible) + Number(responseVisible)

  return (
    <Sheet open={Boolean(value)} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-3xl">
        <SheetHeader className="border-b pr-14">
          <div className="flex flex-wrap items-center gap-2">
            {log ? (
              <Badge
                variant={
                  requestLogSucceeded(log.status_code, log.error_code)
                    ? "secondary"
                    : "destructive"
                }
              >
                {requestLogStatus(log.status_code)}
              </Badge>
            ) : null}
            <SheetTitle>请求详情</SheetTitle>
          </div>
          <SheetDescription className="flex min-w-0 items-center gap-1 font-mono text-xs">
            <span className="truncate">{log?.id}</span>
            {log ? <CopyButton value={log.id} label="复制请求 ID" /> : null}
          </SheetDescription>
        </SheetHeader>

        {log ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {detailSections ? (
              <Tabs defaultValue="overview" className="gap-0">
                <div className="sticky top-0 bg-popover px-4 pt-2">
                  <TabsList
                    variant="line"
                    className="w-full justify-start overflow-x-auto"
                  >
                    <TabsTrigger value="overview">概览</TabsTrigger>
                    {requestVisible ? (
                      <TabsTrigger value="request">客户端请求</TabsTrigger>
                    ) : null}
                    {forwardedVisible ? (
                      <TabsTrigger value="forwarded">上游转发</TabsTrigger>
                    ) : null}
                    {responseVisible ? (
                      <TabsTrigger value="response">上游响应</TabsTrigger>
                    ) : null}
                  </TabsList>
                </div>
                <TabsContent value="overview">
                  <LogOverview log={log} detail={detail} loading={loading} />
                </TabsContent>
                {requestVisible && detail ? (
                  <TabsContent value="request">
                    <RequestSection detail={detail} />
                  </TabsContent>
                ) : null}
                {forwardedVisible && detail ? (
                  <TabsContent value="forwarded">
                    <ForwardedSection detail={detail} />
                  </TabsContent>
                ) : null}
                {responseVisible && detail ? (
                  <TabsContent value="response">
                    <ResponseSection detail={detail} />
                  </TabsContent>
                ) : null}
              </Tabs>
            ) : (
              <LogOverview log={log} detail={detail} loading={loading} />
            )}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function LogOverview({
  log,
  detail,
  loading,
}: {
  log: RequestLog
  detail: RequestLogDetail | null
  loading: boolean
}) {
  const costRows = useMemo(() => {
    const imageInput = Math.min(
      Math.max(0, log.image_input_tokens ?? 0),
      Math.max(0, log.prompt_tokens)
    )
    const cachedInput = Math.min(
      Math.max(0, log.cached_tokens),
      Math.max(0, log.prompt_tokens)
    )
    const cachedImage = Math.min(
      Math.max(0, log.cached_image_input_tokens ?? 0),
      imageInput,
      cachedInput
    )
    const textInput = Math.max(0, log.prompt_tokens - imageInput)
    const cachedText = Math.min(
      textInput,
      Math.max(0, cachedInput - cachedImage)
    )
    const imageOutput = Math.min(
      Math.max(0, log.image_output_tokens ?? 0),
      Math.max(0, log.completion_tokens)
    )
    let textOutput = Math.max(0, log.completion_tokens - imageOutput)
    const reasoningIncluded =
      log.total_tokens <= log.prompt_tokens ||
      log.total_tokens - log.prompt_tokens <= log.completion_tokens
    if (reasoningIncluded)
      textOutput = Math.max(0, textOutput - log.reasoning_tokens)
    return [
      [
        "文本输入",
        Math.max(0, textInput - cachedText),
        log.input_price_nano_usd_per_token ?? 0,
      ],
      [
        "文本缓存读取",
        cachedText,
        log.cached_input_price_nano_usd_per_token ?? 0,
      ],
      [
        "图片输入",
        Math.max(0, imageInput - cachedImage),
        log.image_input_price_nano_usd_per_token ?? 0,
      ],
      [
        "图片缓存读取",
        cachedImage,
        log.cached_image_input_price_nano_usd_per_token ?? 0,
      ],
      [
        "缓存写入",
        log.cache_write_tokens,
        log.cache_write_price_nano_usd_per_token ?? 0,
      ],
      ["文本输出", textOutput, log.output_price_nano_usd_per_token ?? 0],
      ["图片输出", imageOutput, log.image_output_price_nano_usd_per_token ?? 0],
      [
        "推理",
        log.reasoning_tokens,
        log.reasoning_price_nano_usd_per_token ?? 0,
      ],
    ].filter(([, tokens]) => Number(tokens) > 0) as Array<
      [string, number, number]
    >
  }, [log])
  const timings = parseNumberRecord(detail?.stage_timings)
  const latencyTrace =
    log.stage_timings && log.stage_timings !== "{}"
      ? log.stage_timings
      : detail?.stage_timings
  const errorTitle = log.error_code || detail?.error_name
  const errorMessage =
    detail?.error_detail || detail?.error_message || log.error_message
  const hasBilling = Boolean(
    costRows.length || log.cost_nano_usd != null || log.price_source
  )

  return (
    <div className="flex flex-col gap-5 p-4 sm:p-5">
      {errorTitle || errorMessage ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>{errorTitle || "请求失败"}</AlertTitle>
          {errorMessage ? (
            <AlertDescription className="break-words">
              {errorMessage}
            </AlertDescription>
          ) : null}
        </Alert>
      ) : null}

      <DetailGroup title="请求">
        <Facts
          items={[
            ["入口", `${log.method} ${log.path}`],
            ["类型", log.request_type],
            ["模型", modelRoute(log)],
            [
              "客户端",
              [log.client_name, log.client_version].filter(Boolean).join(" "),
            ],
            ["User-Agent", log.user_agent],
            ["时间", dateTime(log.started_at)],
          ]}
        />
      </DetailGroup>

      <DetailGroup title="链路">
        <Facts
          items={[
            ["提供商", log.provider],
            [
              "凭据",
              log.credential_email || log.credential_name || log.auth_index,
            ],
            [
              "订阅",
              [
                log.parent_subscription_name || log.channel_name,
                log.child_subscription_name,
              ]
                .filter(Boolean)
                .join(" / "),
            ],
            ["Upstream Trace", log.upstream_trace_id],
            ["Upstream Execution", log.upstream_execution_id],
          ]}
        />
      </DetailGroup>

      <DetailGroup title="用量与性能">
        <Facts
          items={[
            [
              "Token",
              `${compactTokens(log.total_tokens)}（输入 ${compactTokens(log.prompt_tokens)} · 输出 ${compactTokens(log.completion_tokens)}） · 缓存命中 ${cacheHitRateLabel(log.cached_tokens, log.prompt_tokens)}`,
            ],
            ["客户端请求体", bytes(log.request_body_bytes)],
            ["上游转发体", bytes(log.forwarded_body_bytes)],
            ["上游响应体", bytes(log.response_body_bytes)],
            ["首字节", log.ttft_ms != null ? `${log.ttft_ms} ms` : ""],
            ["总耗时", `${log.latency_ms} ms`],
          ]}
        />
      </DetailGroup>

      <RequestLatencyTimeline
        value={latencyTrace}
        totalMS={log.latency_ms}
        ttftMS={log.ttft_ms}
        stream={log.stream}
      />

      {Object.keys(timings).length ? (
        <DetailGroup title="阶段耗时">
          <div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-3">
            {Object.entries(timings).map(([key, value]) => (
              <Detail
                key={key}
                label={timingLabel(key)}
                value={`${value} ms`}
              />
            ))}
          </div>
        </DetailGroup>
      ) : null}

      {hasBilling ? (
        <DetailGroup title="计费">
          <Facts
            items={[
              [
                "价格来源",
                [log.price_source, log.price_version]
                  .filter(Boolean)
                  .join(" · "),
              ],
              ["计价模型", log.price_model],
              [
                "倍率",
                log.price_multiplier != null ? `${log.price_multiplier}×` : "",
              ],
              ["合计", money(log.cost_nano_usd)],
            ]}
          />
          {costRows.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>成本项</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">单价</TableHead>
                  <TableHead className="text-right">成本</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {costRows.map(([label, tokens, rate]) => (
                  <TableRow key={label}>
                    <TableCell>{label}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {tokens}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {rate} nanoUSD
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(tokens * rate)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </DetailGroup>
      ) : null}

      {detail?.error_cause || detail?.error_stack ? (
        <DetailGroup title="错误诊断">
          {detail.error_cause ? (
            <Payload title="Cause" value={detail.error_cause} />
          ) : null}
          {detail.error_stack ? (
            <Payload title="Stack" value={detail.error_stack} />
          ) : null}
        </DetailGroup>
      ) : null}

      {loading ? (
        <div className="flex flex-col gap-2" aria-label="正在读取原始详情">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : !detail ? (
        <p className="text-xs text-muted-foreground">
          原始 Headers 与正文未采样或已过保留期；上面的摘要、大小、Token
          和计费数据仍然完整。
        </p>
      ) : null}
    </div>
  )
}

function RequestSection({ detail }: { detail: RequestLogDetail }) {
  const headers = hasJSONObject(detail.request_headers)
    ? prettyJSON(detail.request_headers)
    : ""
  return (
    <div className="flex flex-col gap-5 p-4 sm:p-5">
      {headers ? <Payload title="Headers" value={headers} /> : null}
      {detail.request_body || detail.request_body_bytes ? (
        <Payload
          title="Body"
          value={prettyJSON(detail.request_body)}
          bytes={detail.request_body_bytes}
          truncated={detail.request_body_truncated}
        />
      ) : null}
    </div>
  )
}

function ForwardedSection({ detail }: { detail: RequestLogDetail }) {
  const headers = hasJSONObject(detail.forwarded_headers)
    ? prettyJSON(detail.forwarded_headers)
    : ""
  return (
    <div className="flex flex-col gap-5 p-4 sm:p-5">
      {headers ? <Payload title="Headers" value={headers} /> : null}
      {detail.forwarded_body ? (
        <Payload
          title="转换后 Body"
          value={prettyJSON(detail.forwarded_body)}
          bytes={detail.forwarded_body_bytes}
          truncated={detail.forwarded_body_truncated}
        />
      ) : detail.forwarded_body_bytes ? (
        <p className="text-sm text-muted-foreground">
          转发正文与客户端请求相同，未重复存储（
          {bytes(detail.forwarded_body_bytes)}）。
        </p>
      ) : null}
    </div>
  )
}

function ResponseSection({ detail }: { detail: RequestLogDetail }) {
  const headers = hasJSONObject(detail.upstream_headers)
    ? prettyJSON(detail.upstream_headers)
    : ""
  return (
    <div className="flex flex-col gap-5 p-4 sm:p-5">
      {detail.upstream_status ? (
        <Badge variant="outline">HTTP {detail.upstream_status}</Badge>
      ) : null}
      {headers ? <Payload title="Headers" value={headers} /> : null}
      {detail.upstream_body || detail.upstream_body_bytes ? (
        <Payload
          title="Body"
          value={prettyJSON(detail.upstream_body)}
          bytes={detail.upstream_body_bytes}
          truncated={detail.upstream_body_truncated}
        />
      ) : null}
    </div>
  )
}

function DetailGroup({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h3 className="text-sm font-medium">{title}</h3>
        <Separator className="flex-1" />
      </div>
      {children}
    </section>
  )
}

function Facts({ items }: { items: Array<[string, string | undefined]> }) {
  const visible = items.filter(([, value]) => Boolean(value))
  return (
    <dl className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
      {visible.map(([label, value]) => (
        <Detail key={label} label={label} value={value ?? ""} />
      ))}
    </dl>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm break-words">{value}</dd>
    </div>
  )
}

function Payload({
  title,
  value,
  bytes: byteCount,
  truncated = false,
}: {
  title: string
  value: string
  bytes?: number
  truncated?: boolean
}) {
  if (!value) return null
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {byteCount != null ? (
          <span className="text-xs text-muted-foreground">
            {bytes(byteCount)}
          </span>
        ) : null}
        {truncated ? <Badge variant="outline">已截断</Badge> : null}
        <CopyButton value={value} label={`复制 ${title}`} className="ml-auto" />
      </div>
      <pre className="max-h-[32rem] overflow-auto rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed break-all whitespace-pre-wrap">
        {value}
      </pre>
    </section>
  )
}

function CopyButton({
  value,
  label,
  className,
}: {
  value: string
  label: string
  className?: string
}) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      toast.success("已复制")
    } catch {
      toast.error("复制失败")
    }
  }
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={className}
      onClick={() => void copy()}
      aria-label={label}
    >
      <CopyIcon />
    </Button>
  )
}

function formatMS(value: number) {
  if (!Number.isFinite(value)) return "—"
  if (value >= 1000)
    return `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)} s`
  if (value >= 10) return `${value.toFixed(0)} ms`
  if (value >= 1) return `${value.toFixed(1)} ms`
  return `${Math.max(0, value).toFixed(3)} ms`
}

function prettyJSON(value?: string) {
  if (!value) return ""
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function hasJSONObject(value?: string) {
  if (!value) return false
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed)) return parsed.length > 0
    return typeof parsed === "object" && parsed !== null
      ? Object.keys(parsed).length > 0
      : Boolean(parsed)
  } catch {
    return Boolean(value.trim())
  }
}

function parseNumberRecord(value?: string) {
  if (!value) return {} as Record<string, number>
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (
      (parsed.version === 2 || parsed.version === 3) &&
      Array.isArray(parsed.segments)
    )
      return {} as Record<string, number>
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number"
      )
    )
  } catch {
    return {} as Record<string, number>
  }
}

function modelRoute(log: RequestLog) {
  const requested = log.requested_model || log.model
  const actual = log.actual_model || log.model
  if (requested && actual && requested !== actual)
    return `${requested} → ${actual}`
  return actual || requested
}

function timingLabel(value: string) {
  const labels: Record<string, string> = {
    resolve_key_ms: "解析 Key",
    read_body_ms: "读取正文",
    limits_ms: "限额检查",
    admission_ms: "订阅准入",
    upstream_start_ms: "开始上游",
    upstream_wait_ms: "等待上游",
    upstream_headers_ms: "上游响应头",
    first_byte_ms: "首字节",
    websocket_duration_ms: "WebSocket 会话",
    total_ms: "总计",
  }
  return labels[value] || value.replaceAll("_", " ")
}

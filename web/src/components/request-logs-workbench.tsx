import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { CodeBlock } from "@astryxdesign/core/CodeBlock"
import { Collapsible } from "@astryxdesign/core/Collapsible"
import { EmptyState } from "@astryxdesign/core/EmptyState"
import { FormLayout } from "@astryxdesign/core/FormLayout"
import { Grid } from "@astryxdesign/core/Grid"
import {
  HStack,
  Layout,
  LayoutContent,
  LayoutFooter,
  LayoutHeader,
  LayoutPanel,
  StackItem,
  VStack,
} from "@astryxdesign/core/Layout"
import { NumberInput } from "@astryxdesign/core/NumberInput"
import { Pagination } from "@astryxdesign/core/Pagination"
import { Section } from "@astryxdesign/core/Section"
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl"
import { Selector } from "@astryxdesign/core/Selector"
import { Tab, TabList } from "@astryxdesign/core/TabList"
import { Table, pixel, proportional, type TablePlugin } from "@astryxdesign/core/Table"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useToast } from "@astryxdesign/core/Toast"
import { Token } from "@astryxdesign/core/Token"
import {
  ActivityIcon,
  CircleDollarSignIcon,
  Clock3Icon,
  CoinsIcon,
  DatabaseIcon,
  RefreshCwIcon,
  SearchIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"

import { LoadingView } from "@/components/loading-view"
import {
  CopyField,
  CountBadge,
  MetricGrid,
  PageHeader,
  SearchField,
  StatusLabel,
} from "@/components/page-kit"
import { RequestLatencyTimeline } from "@/components/request-latency-timeline"
import { CacheHitRateBadge } from "@/components/token-cache-rate"
import {
  api,
  type RequestLog,
  type RequestLogDetail,
  type RequestLogPage,
  type WebSocketTurn,
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
  requestLogTransport,
} from "@/lib/format"

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

const methodOptions = [
  { value: "all", label: "全部方法" },
  { value: "POST", label: "POST" },
  { value: "GET", label: "GET" },
  { value: "PUT", label: "PUT" },
  { value: "PATCH", label: "PATCH" },
  { value: "DELETE", label: "DELETE" },
]

const pageSizeOptions = [25, 50, 100, 200]

type SelectedLog = {
  log: RequestLog
  detail: RequestLogDetail | null
  turns?: WebSocketTurn[]
}

type InspectorTab = "payload" | "headers" | "latency"

interface LogRow extends Record<string, unknown> {
  id: string
  started_at: string
  status: string
  ok: boolean
  transport: string
  model: string
  route: string
  client: string
  client_version: string
  tenant: string
  key_label: string
  tokens: number
  cached_tokens: number
  prompt_tokens: number
  request_bytes: number
  response_bytes: number
  latency_ms: number
  ttft_ms?: number
  cost: number | null
  log: RequestLog
}

interface TurnRow extends Record<string, unknown> {
  id: string
  model: string
  tokens: number
  latency_ms: number
  cost: number
}

interface CostRow extends Record<string, unknown> {
  id: string
  label: string
  tokens: number
  rate: number
  cost: number
}

interface TimingRow extends Record<string, unknown> {
  id: string
  label: string
  value: string
}

export function RequestLogsWorkbench({ admin = false }: { admin?: boolean }) {
  const toast = useToast()
  const [data, setData] = useState<RequestLogPage>(emptyPage)
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState("all")
  const [method, setMethod] = useState("all")
  const [model, setModel] = useState("")
  const [minLatency, setMinLatency] = useState<number | undefined>(undefined)
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [selected, setSelected] = useState<SelectedLog | null>(null)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("payload")
  const detailRequest = useRef(0)

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
      if (minLatency != null) params.set("min_latency_ms", String(minLatency))
      if (from) params.set("from", new Date(from).toISOString())
      if (to) params.set("to", new Date(to).toISOString())
      const prefix = admin ? "/api/admin/logs" : "/api/logs"
      setData(await api<RequestLogPage>(`${prefix}?${params}`))
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "读取请求日志失败",
      })
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
    toast,
  ])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200)
    return () => window.clearTimeout(timer)
  }, [load])

  const fetchDetail = useCallback(
    async (id: string, placeholder?: RequestLog) => {
      const token = ++detailRequest.current
      if (placeholder) setSelected({ log: placeholder, detail: null })
      else setSelected((current) => (current?.log.id === id ? current : null))
      setDetailLoading(true)
      try {
        const prefix = admin ? "/api/admin/logs" : "/api/logs"
        const next = await api<SelectedLog>(`${prefix}/${id}`)
        if (detailRequest.current !== token) return
        setSelected(next)
      } catch (cause) {
        if (detailRequest.current !== token) return
        setSelected(null)
        toast({
          type: "error",
          body: cause instanceof Error ? cause.message : "读取日志详情失败",
        })
        if (logIdFromHash() === id) writeLogHash(null, "replace")
      } finally {
        if (detailRequest.current === token) setDetailLoading(false)
      }
    },
    [admin, toast]
  )

  const openDetail = useCallback(
    (log: RequestLog) => {
      writeLogHash(log.id, "push")
      void fetchDetail(log.id, log)
    },
    [fetchDetail]
  )

  const closeDetail = useCallback(() => {
    detailRequest.current += 1
    setSelected(null)
    setDetailLoading(false)
    writeLogHash(null, "push")
  }, [])

  useEffect(() => {
    function syncFromLocation() {
      const id = logIdFromHash()
      if (!id) {
        detailRequest.current += 1
        setSelected(null)
        setDetailLoading(false)
        return
      }
      void fetchDetail(id)
    }
    window.addEventListener("hashchange", syncFromLocation)
    if (logIdFromHash()) void fetchDetail(logIdFromHash())
    return () => {
      window.removeEventListener("hashchange", syncFromLocation)
    }
  }, [fetchDetail])

  useEffect(() => {
    if (!selected && !detailLoading) return
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      event.preventDefault()
      closeDetail()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [closeDetail, detailLoading, selected])

  function resetFilters() {
    setQuery("")
    setStatus("all")
    setMethod("all")
    setModel("")
    setMinLatency(undefined)
    setFrom("")
    setTo("")
    setPage(1)
  }

  const cacheRate = cacheHitRateLabel(
    data.summary.cached_tokens,
    data.summary.prompt_tokens
  )
  const advancedFilterCount = [
    method !== "all",
    model,
    minLatency != null,
    from,
    to,
  ].filter(Boolean).length
  const hasFilters = Boolean(query || status !== "all" || advancedFilterCount)
  const hashId = logIdFromHash()
  const selectedId = selected?.log.id ?? ""
  const showInspector = Boolean(selected || (detailLoading && hashId))

  const rows: LogRow[] = data.items.map((log) => ({
    id: log.id,
    started_at: log.started_at,
    status: requestLogStatus(log.status_code),
    ok: requestLogSucceeded(log.status_code, log.error_code),
    transport: requestLogTransport(log.request_type, log.stream),
    model:
      log.actual_model || log.requested_model || log.model || log.path,
    route: [
      requestLogTransport(log.request_type, log.stream),
      log.request_type || `${log.method} ${log.path}`,
      log.provider
        ? `${log.provider}${log.auth_index ? ` / ${log.auth_index}` : ""}`
        : "",
    ]
      .filter(Boolean)
      .join(" · "),
    client: log.client_name || "未知客户端",
    client_version: log.client_version || "—",
    tenant: log.tenant_name || log.tenant_id,
    key_label: log.api_key_name || log.api_key_prefix || "—",
    tokens: log.total_tokens,
    cached_tokens: log.cached_tokens,
    prompt_tokens: log.prompt_tokens,
    request_bytes: log.request_body_bytes,
    response_bytes: log.response_body_bytes,
    latency_ms: log.latency_ms,
    ttft_ms: log.ttft_ms,
    cost: log.cost_nano_usd,
    log,
  }))

  const rowPlugin = useMemo<TablePlugin<LogRow>>(
    () => ({
      transformBodyRow: (props, item) => ({
        ...props,
        htmlProps: {
          ...props.htmlProps,
          role: "button",
          tabIndex: 0,
          "aria-selected": item.id === selectedId,
          onClick: () => openDetail(item.log),
          onKeyDown: (event: ReactKeyboardEvent<HTMLTableRowElement>) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault()
              openDetail(item.log)
            }
          },
        },
      }),
    }),
    [openDetail, selectedId]
  )

  return (
    <Layout
      height="fill"
      defaultHasDividers
      end={
        showInspector ? (
          <LayoutPanel width={420} label="日志详情" padding={4}>
            {selected ? (
              <LogInspector
                value={selected}
                loading={detailLoading}
                tab={inspectorTab}
                onTabChange={setInspectorTab}
                onClose={closeDetail}
              />
            ) : (
              <LoadingView />
            )}
          </LayoutPanel>
        ) : undefined
      }
      header={
        <LayoutHeader>
          <VStack gap={4}>
            <MetricGrid
              items={[
                {
                  label: "请求",
                  value: compact(data.summary.requests),
                  hint: `${data.summary.errors} 个错误`,
                  icon: ActivityIcon,
                },
                {
                  label: "错误率",
                  value: data.summary.requests
                    ? `${((data.summary.errors / data.summary.requests) * 100).toFixed(1)}%`
                    : "0%",
                  hint: "HTTP 错误或中断",
                  icon: TriangleAlertIcon,
                },
                {
                  label: "Tokens",
                  value: compactTokens(data.summary.tokens),
                  hint: `缓存命中 ${cacheRate}`,
                  icon: CoinsIcon,
                },
                {
                  label: "负载",
                  value: bytes(
                    data.summary.request_bytes + data.summary.response_bytes
                  ),
                  hint: `${bytes(data.summary.request_bytes)} ↑ · ${bytes(data.summary.response_bytes)} ↓`,
                  icon: DatabaseIcon,
                },
                {
                  label: "总耗时",
                  value: data.summary.requests
                    ? `P50 ${formatMS(data.summary.latency_p50_ms)}`
                    : "无数据",
                  hint: data.summary.requests
                    ? `P95 ${formatMS(data.summary.latency_p95_ms)}`
                    : "当前筛选范围",
                  icon: Clock3Icon,
                },
                {
                  label: "费用",
                  value: money(data.summary.cost_nano_usd),
                  icon: CircleDollarSignIcon,
                },
              ]}
            />
            <PageHeader
              title="请求明细"
              actions={
                <Button
                  label="刷新"
                  variant="secondary"
                  size="sm"
                  icon={<RefreshCwIcon />}
                  isLoading={loading}
                  onClick={() => void load()}
                />
              }
            />
            <Text color="secondary">
              一条日志是一次对 Relay 的调用。SSE 仍是一条 HTTP 请求；WebSocket
              按会话一行，轮次在详情里。
            </Text>
            <HStack gap={3} wrap="wrap" vAlign="end">
              <StackItem size="fill">
                <SearchField
                  label="搜索日志"
                  value={query}
                  onChange={(value) => {
                    setQuery(value)
                    setPage(1)
                  }}
                  placeholder="搜索模型、路径、用户、Key、Trace ID 或错误"
                />
              </StackItem>
              <SegmentedControl
                label="状态"
                size="sm"
                value={status}
                onChange={(value) => {
                  setStatus(value)
                  setPage(1)
                }}
              >
                <SegmentedControlItem value="all" label="全部状态" />
                <SegmentedControlItem value="success" label="成功" />
                <SegmentedControlItem value="error" label="错误" />
                <SegmentedControlItem value="stream" label="SSE" />
                <SegmentedControlItem value="websocket" label="WebSocket" />
              </SegmentedControl>
            </HStack>
            <Collapsible
              trigger={
                advancedFilterCount ? (
                  <HStack gap={2} vAlign="center">
                    <Text>筛选</Text>
                    <CountBadge value={advancedFilterCount} />
                  </HStack>
                ) : (
                  "筛选"
                )
              }
              isOpen={filtersOpen}
              onOpenChange={setFiltersOpen}
            >
              <FormLayout>
                <FormLayout direction="horizontal">
                  <Selector
                    label="方法"
                    value={method}
                    onChange={(value) => {
                      setMethod(value)
                      setPage(1)
                    }}
                    options={methodOptions}
                  />
                  <TextInput
                    label="精确模型"
                    value={model}
                    onChange={(value) => {
                      setModel(value)
                      setPage(1)
                    }}
                    placeholder="例如 gpt-5.6"
                  />
                  <NumberInput
                    label="最小耗时"
                    value={minLatency}
                    onChange={(value) => {
                      setMinLatency(value ?? undefined)
                      setPage(1)
                    }}
                    min={0}
                    isIntegerOnly
                    hasClear
                    units="ms"
                    placeholder="毫秒"
                    isOptional
                  />
                  <TextInput
                    label="开始时间"
                    value={from}
                    onChange={(value) => {
                      setFrom(value)
                      setPage(1)
                    }}
                    placeholder="2026-08-25T12:00"
                    isOptional
                  />
                  <TextInput
                    label="结束时间"
                    value={to}
                    onChange={(value) => {
                      setTo(value)
                      setPage(1)
                    }}
                    placeholder="2026-08-25T13:00"
                    isOptional
                  />
                </FormLayout>
                {hasFilters ? (
                  <Button
                    label="清除全部筛选"
                    variant="ghost"
                    size="sm"
                    icon={<XIcon />}
                    onClick={resetFilters}
                  />
                ) : null}
              </FormLayout>
            </Collapsible>
          </VStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0}>
          <Table
            data={rows}
            idKey="id"
            density="compact"
            hasHover
            textOverflow="truncate"
            rowIndexStart={(page - 1) * pageSize + 1}
            rowCount={data.total}
            plugins={{ inspect: rowPlugin }}
            emptyState={
              <EmptyState
                title={hasFilters ? "没有匹配的请求" : "暂无请求记录"}
                description={
                  hasFilters
                    ? "调整或清除筛选条件后再试。"
                    : "API 调用记录会显示在这里。"
                }
                icon={<SearchIcon />}
                actions={
                  hasFilters ? (
                    <Button
                      label="清除筛选"
                      variant="secondary"
                      size="sm"
                      onClick={resetFilters}
                    />
                  ) : undefined
                }
              />
            }
            columns={[
              {
                key: "started_at",
                header: "时间",
                width: pixel(140),
                renderCell: (row) => (
                  <Text type="supporting">{dateTime(row.started_at)}</Text>
                ),
              },
              {
                key: "status",
                header: "状态",
                width: pixel(120),
                renderCell: (row) => (
                  <HStack gap={1} vAlign="center">
                    <StatusLabel
                      tone={row.ok ? "success" : "error"}
                      label={row.status}
                    />
                    {row.transport !== "HTTP" ? (
                      <Token label={row.transport} color="gray" size="sm" />
                    ) : null}
                  </HStack>
                ),
              },
              {
                key: "model",
                header: "请求",
                width: proportional(2),
                renderCell: (row) => (
                  <VStack gap={0}>
                    <Text type="code">{row.model}</Text>
                    <Text color="secondary" type="supporting">
                      {row.route}
                    </Text>
                  </VStack>
                ),
              },
              {
                key: "client",
                header: "客户端",
                width: proportional(1),
                renderCell: (row) => (
                  <VStack gap={0}>
                    <Text>{row.client}</Text>
                    <Text type="code" color="secondary">
                      {row.client_version}
                    </Text>
                  </VStack>
                ),
              },
              ...(admin
                ? [
                    {
                      key: "tenant",
                      header: "用户",
                      width: proportional(1),
                      renderCell: (row: LogRow) => (
                        <VStack gap={0}>
                          <Text>{row.tenant}</Text>
                          <Text color="secondary" type="supporting">
                            {row.key_label}
                          </Text>
                        </VStack>
                      ),
                    },
                  ]
                : []),
              {
                key: "tokens",
                header: "Token",
                width: pixel(140),
                align: "end",
                renderCell: (row) => (
                  <HStack gap={1} vAlign="center" hAlign="end">
                    <Text>{compactTokens(row.tokens)}</Text>
                    <CacheHitRateBadge
                      cachedTokens={row.cached_tokens}
                      promptTokens={row.prompt_tokens}
                    />
                  </HStack>
                ),
              },
              {
                key: "request_bytes",
                header: "负载",
                width: pixel(140),
                align: "end",
                renderCell: (row) => (
                  <Text type="supporting">
                    {bytes(row.request_bytes)} → {bytes(row.response_bytes)}
                  </Text>
                ),
              },
              {
                key: "latency_ms",
                header: "耗时",
                width: pixel(110),
                align: "end",
                renderCell: (row) => (
                  <VStack gap={0}>
                    <Text>{row.latency_ms} ms</Text>
                    {row.ttft_ms != null ? (
                      <Text color="secondary" type="supporting">
                        首字节 {row.ttft_ms} ms
                      </Text>
                    ) : null}
                  </VStack>
                ),
              },
              {
                key: "cost",
                header: "费用",
                width: pixel(100),
                align: "end",
                renderCell: (row) => <Text>{money(row.cost)}</Text>,
              },
            ]}
          />
        </LayoutContent>
      }
      footer={
        <LayoutFooter>
          <Pagination
            page={page}
            onChange={setPage}
            totalItems={data.total}
            pageSize={pageSize}
            pageSizeOptions={pageSizeOptions}
            onPageSizeChange={(size) => {
              setPageSize(size)
              setPage(1)
            }}
            variant="count"
            size="sm"
          />
        </LayoutFooter>
      }
    />
  )
}

function LogInspector({
  value,
  loading,
  tab,
  onTabChange,
  onClose,
}: {
  value: SelectedLog
  loading: boolean
  tab: InspectorTab
  onTabChange: (value: InspectorTab) => void
  onClose: () => void
}) {
  const log = value.log
  const detail = value.detail ?? null
  const turns = value.turns ?? []
  const requestHeaders = hasJSONObject(detail?.request_headers)
    ? prettyJSON(detail?.request_headers)
    : ""
  const forwardedHeaders = hasJSONObject(detail?.forwarded_headers)
    ? prettyJSON(detail?.forwarded_headers)
    : ""
  const upstreamHeaders = hasJSONObject(detail?.upstream_headers)
    ? prettyJSON(detail?.upstream_headers)
    : ""
  const requestBody =
    detail && (detail.request_body || detail.request_body_bytes)
      ? prettyJSON(detail.request_body)
      : ""
  const forwardedBody = detail?.forwarded_body
    ? prettyJSON(detail.forwarded_body)
    : ""
  const upstreamBody =
    detail && (detail.upstream_body || detail.upstream_body_bytes)
      ? prettyJSON(detail.upstream_body)
      : ""

  return (
    <VStack gap={4}>
      <HStack hAlign="between" vAlign="start" gap={2}>
        <VStack gap={1}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <StatusLabel
              tone={
                requestLogSucceeded(log.status_code, log.error_code)
                  ? "success"
                  : "error"
              }
              label={requestLogStatus(log.status_code)}
            />
            <Heading level={3}>{modelRoute(log) || "请求详情"}</Heading>
          </HStack>
          <Text color="secondary" type="supporting">
            {requestLogTransport(log.request_type, log.stream)}
            {` · ${dateTime(log.started_at)}`}
          </Text>
        </VStack>
        <Button
          label="关闭"
          variant="ghost"
          size="sm"
          icon={<XIcon />}
          onClick={onClose}
        />
      </HStack>
      <CopyField id="request-log-id" label="请求 ID" value={log.id} />
      <LogOverview log={log} detail={detail} turns={turns} loading={loading} />
      <TabList
        value={tab}
        onChange={(value) => onTabChange(value as InspectorTab)}
        role="tablist"
        size="sm"
        hasDivider
      >
        <Tab value="payload" label="正文" panelId="log-panel-payload" />
        <Tab value="headers" label="Headers" panelId="log-panel-headers" />
        <Tab value="latency" label="耗时" panelId="log-panel-latency" />
      </TabList>
      {tab === "payload" ? (
        <Section id="log-panel-payload" variant="transparent" padding={0}>
          <PayloadSection
            requestBody={requestBody}
            requestBytes={detail?.request_body_bytes}
            requestTruncated={detail?.request_body_truncated}
            forwardedBody={forwardedBody}
            forwardedBytes={detail?.forwarded_body_bytes}
            forwardedTruncated={detail?.forwarded_body_truncated}
            upstreamBody={upstreamBody}
            upstreamBytes={detail?.upstream_body_bytes}
            upstreamTruncated={detail?.upstream_body_truncated}
            errorCause={detail?.error_cause}
            errorStack={detail?.error_stack}
            loading={loading}
            hasDetail={Boolean(detail)}
          />
        </Section>
      ) : null}
      {tab === "headers" ? (
        <Section id="log-panel-headers" variant="transparent" padding={0}>
          <HeadersSection
            requestHeaders={requestHeaders}
            forwardedHeaders={forwardedHeaders}
            upstreamHeaders={upstreamHeaders}
            upstreamStatus={detail?.upstream_status}
            loading={loading}
            hasDetail={Boolean(detail)}
          />
        </Section>
      ) : null}
      {tab === "latency" ? (
        <Section id="log-panel-latency" variant="transparent" padding={0}>
          <LatencySection log={log} detail={detail} />
        </Section>
      ) : null}
    </VStack>
  )
}

function LogOverview({
  log,
  detail,
  turns,
  loading,
}: {
  log: RequestLog
  detail: RequestLogDetail | null
  turns: WebSocketTurn[]
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
  const errorTitle = log.error_code || detail?.error_name
  const errorMessage =
    detail?.error_detail || detail?.error_message || log.error_message
  const hasBilling = Boolean(
    costRows.length || log.cost_nano_usd != null || log.price_source
  )
  const turnRows: TurnRow[] = turns.map((turn) => ({
    id: turn.turn_id,
    model: turn.model || "—",
    tokens: turn.total_tokens,
    latency_ms: turn.latency_ms,
    cost: turn.cost_nano_usd,
  }))
  const billingRows: CostRow[] = costRows.map(([label, tokens, rate]) => ({
    id: label,
    label,
    tokens,
    rate,
    cost: tokens * rate,
  }))

  return (
    <VStack gap={4}>
      {errorTitle || errorMessage ? (
        <Banner
          status="error"
          title={errorTitle || "请求失败"}
          description={errorMessage}
          collapsible={false}
        />
      ) : null}

      <FactGroup
        title="请求"
        items={[
          ["入口", `${log.method} ${log.path}`],
          ["传输", requestLogTransport(log.request_type, log.stream)],
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

      <FactGroup
        title="链路"
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

      <FactGroup
        title="用量与性能"
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

      {turnRows.length ? (
        <VStack gap={2}>
          <HStack hAlign="between" vAlign="center" gap={2}>
            <Heading level={3}>会话轮次</Heading>
            <CountBadge value={turnRows.length} />
          </HStack>
          <Table
            data={turnRows}
            idKey="id"
            density="compact"
            columns={[
              {
                key: "id",
                header: "轮次",
                width: proportional(1),
                renderCell: (row) => <Text type="code">{row.id}</Text>,
              },
              { key: "model", header: "模型", width: proportional(1) },
              {
                key: "tokens",
                header: "Token",
                width: pixel(80),
                align: "end",
                renderCell: (row) => <Text>{compactTokens(row.tokens)}</Text>,
              },
              {
                key: "latency_ms",
                header: "耗时",
                width: pixel(80),
                align: "end",
                renderCell: (row) => <Text>{row.latency_ms} ms</Text>,
              },
              {
                key: "cost",
                header: "费用",
                width: pixel(80),
                align: "end",
                renderCell: (row) => <Text>{money(row.cost)}</Text>,
              },
            ]}
          />
        </VStack>
      ) : null}

      {hasBilling ? (
        <VStack gap={2}>
          <Heading level={3}>计费</Heading>
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
          {billingRows.length ? (
            <Table
              data={billingRows}
              idKey="id"
              density="compact"
              columns={[
                { key: "label", header: "成本项", width: proportional(1) },
                {
                  key: "tokens",
                  header: "Tokens",
                  width: pixel(80),
                  align: "end",
                },
                {
                  key: "rate",
                  header: "单价",
                  width: pixel(110),
                  align: "end",
                  renderCell: (row) => <Text>{row.rate} nanoUSD</Text>,
                },
                {
                  key: "cost",
                  header: "成本",
                  width: pixel(90),
                  align: "end",
                  renderCell: (row) => <Text>{money(row.cost)}</Text>,
                },
              ]}
            />
          ) : null}
        </VStack>
      ) : null}

      {loading ? (
        <Text color="secondary" type="supporting">
          正在读取原始详情
        </Text>
      ) : !detail ? (
        <Text color="secondary" type="supporting">
          原始 Headers 与正文未采样或已过保留期；上面的摘要、大小、Token
          和计费数据仍然完整。
        </Text>
      ) : null}
    </VStack>
  )
}

function PayloadSection({
  requestBody,
  requestBytes,
  requestTruncated,
  forwardedBody,
  forwardedBytes,
  forwardedTruncated,
  upstreamBody,
  upstreamBytes,
  upstreamTruncated,
  errorCause,
  errorStack,
  loading,
  hasDetail,
}: {
  requestBody: string
  requestBytes?: number
  requestTruncated?: boolean
  forwardedBody: string
  forwardedBytes?: number
  forwardedTruncated?: boolean
  upstreamBody: string
  upstreamBytes?: number
  upstreamTruncated?: boolean
  errorCause?: string
  errorStack?: string
  loading: boolean
  hasDetail: boolean
}) {
  if (loading && !hasDetail) return <LoadingView />
  const hasPayload = Boolean(
    requestBody || forwardedBody || upstreamBody || errorCause || errorStack
  )
  return (
    <VStack gap={4}>
      <PayloadBlock
        title="客户端请求"
        code={requestBody}
        bytes={requestBytes}
        truncated={requestTruncated}
      />
      {forwardedBody ? (
        <PayloadBlock
          title="转换后 Body"
          code={forwardedBody}
          bytes={forwardedBytes}
          truncated={forwardedTruncated}
        />
      ) : forwardedBytes ? (
        <Text color="secondary">
          转发正文与客户端请求相同，未重复存储（{bytes(forwardedBytes)}）。
        </Text>
      ) : null}
      <PayloadBlock
        title="上游响应"
        code={upstreamBody}
        bytes={upstreamBytes}
        truncated={upstreamTruncated}
      />
      {errorCause ? (
        <CodeBlock
          title="Cause"
          language="plaintext"
          code={errorCause}
          width="100%"
        />
      ) : null}
      {errorStack ? (
        <CodeBlock
          title="Stack"
          language="plaintext"
          code={errorStack}
          width="100%"
        />
      ) : null}
      {!hasPayload && hasDetail ? (
        <EmptyState isCompact title="没有可展示的正文" />
      ) : null}
    </VStack>
  )
}

function HeadersSection({
  requestHeaders,
  forwardedHeaders,
  upstreamHeaders,
  upstreamStatus,
  loading,
  hasDetail,
}: {
  requestHeaders: string
  forwardedHeaders: string
  upstreamHeaders: string
  upstreamStatus?: number
  loading: boolean
  hasDetail: boolean
}) {
  if (loading && !hasDetail) return <LoadingView />
  const hasHeaders = Boolean(
    requestHeaders || forwardedHeaders || upstreamHeaders || upstreamStatus
  )
  return (
    <VStack gap={4}>
      {upstreamStatus ? (
        <StatusLabel
          tone={
            upstreamStatus >= 200 && upstreamStatus < 400 ? "success" : "error"
          }
          label={`HTTP ${upstreamStatus}`}
        />
      ) : null}
      {requestHeaders ? (
        <CodeBlock
          title="客户端 Headers"
          language="json"
          code={requestHeaders}
          width="100%"
        />
      ) : null}
      {forwardedHeaders ? (
        <CodeBlock
          title="上游转发 Headers"
          language="json"
          code={forwardedHeaders}
          width="100%"
        />
      ) : null}
      {upstreamHeaders ? (
        <CodeBlock
          title="上游响应 Headers"
          language="json"
          code={upstreamHeaders}
          width="100%"
        />
      ) : null}
      {!hasHeaders && hasDetail ? (
        <EmptyState isCompact title="没有可展示的 Headers" />
      ) : null}
    </VStack>
  )
}

function LatencySection({
  log,
  detail,
}: {
  log: RequestLog
  detail: RequestLogDetail | null
}) {
  const timings = parseNumberRecord(detail?.stage_timings)
  const latencyTrace =
    log.stage_timings && log.stage_timings !== "{}"
      ? log.stage_timings
      : detail?.stage_timings
  const timingRows: TimingRow[] = Object.entries(timings).map(
    ([key, value]) => ({
      id: key,
      label: timingLabel(key),
      value: `${value} ms`,
    })
  )
  return (
    <VStack gap={4}>
      <RequestLatencyTimeline
        value={latencyTrace}
        totalMS={log.latency_ms}
        ttftMS={log.ttft_ms}
        stream={log.stream}
      />
      {timingRows.length ? (
        <VStack gap={2}>
          <Heading level={3}>阶段耗时</Heading>
          <Table
            data={timingRows}
            idKey="id"
            density="compact"
            columns={[
              { key: "label", header: "阶段", width: proportional(1) },
              { key: "value", header: "耗时", width: pixel(90), align: "end" },
            ]}
          />
        </VStack>
      ) : null}
    </VStack>
  )
}

function PayloadBlock({
  title,
  code,
  bytes: byteCount,
  truncated = false,
}: {
  title: string
  code: string
  bytes?: number
  truncated?: boolean
}) {
  if (!code) return null
  return (
    <VStack gap={2}>
      <HStack gap={2} vAlign="center" wrap="wrap">
        {byteCount != null ? (
          <Text color="secondary" type="supporting">
            {bytes(byteCount)}
          </Text>
        ) : null}
        {truncated ? <Token label="已截断" color="orange" size="sm" /> : null}
      </HStack>
      <CodeBlock title={title} language="json" code={code} width="100%" />
    </VStack>
  )
}

function FactGroup({
  title,
  items,
}: {
  title: string
  items: Array<[string, string | undefined]>
}) {
  return (
    <VStack gap={2}>
      <Heading level={3}>{title}</Heading>
      <Facts items={items} />
    </VStack>
  )
}

function Facts({ items }: { items: Array<[string, string | undefined]> }) {
  const visible = items.filter(([, value]) => Boolean(value))
  if (!visible.length) return null
  return (
    <Grid columns={{ minWidth: 140, max: 2 }} gap={3}>
      {visible.map(([label, value]) => (
        <VStack key={label} gap={0}>
          <Text color="secondary" type="supporting">
            {label}
          </Text>
          <Text>{value}</Text>
        </VStack>
      ))}
    </Grid>
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
    if (typeof parsed.version === "number" && Array.isArray(parsed.segments))
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

const logHashPrefix = "#log="

function logIdFromHash(hash = window.location.hash) {
  if (!hash.startsWith(logHashPrefix)) return ""
  try {
    return decodeURIComponent(hash.slice(logHashPrefix.length)).trim()
  } catch {
    return ""
  }
}

function writeLogHash(id: string | null, mode: "push" | "replace") {
  const url = new URL(window.location.href)
  url.hash = id ? `log=${encodeURIComponent(id)}` : ""
  const next = `${url.pathname}${url.search}${url.hash}`
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (next === current) return
  if (mode === "replace") window.history.replaceState(null, "", next)
  else window.history.pushState(null, "", next)
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

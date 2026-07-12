"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  CopyIcon,
  FileTextIcon,
  FilterIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DataPanel } from "@/components/workspace/data-panel";
import {
  formatDateTime,
  formatDuration,
  formatNullableDuration,
  formatNumber,
  formatPercent,
  formatTokenNumber,
} from "@/components/workspace/format";
import { MetricStrip, MetricStripItem } from "@/components/workspace/metric-strip";
import { SectionToolbar } from "@/components/workspace/section-toolbar";
import { WorkspaceStatusBadge } from "@/components/workspace/status-badge";
import type {
  RequestLogDetail,
  RequestLogsPage,
  RequestLogStatusFilter,
  RequestLogFilters,
} from "@/lib/admin-api";
import { cn } from "@/lib/utils";

type StatusFilter = Extract<
  RequestLogStatusFilter,
  "all" | "success" | "error" | "stream"
>;

const STATUS_FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "success", label: "成功" },
  { id: "error", label: "错误" },
  { id: "stream", label: "流式" },
];

export function RequestLogsWorkbench({
  detailTenantColumn = true,
  errorMessage,
  initialPage,
  loadDetail,
  loadPage,
  onLoaded,
}: {
  detailTenantColumn?: boolean;
  errorMessage: (error: unknown) => string;
  initialPage: RequestLogsPage;
  loadDetail: (id: string) => Promise<RequestLogDetail>;
  loadPage: (options?: RequestLogFilters) => Promise<RequestLogsPage>;
  onLoaded?: (page: RequestLogsPage) => void;
}) {
  const [logsPage, setLogsPage] = React.useState(initialPage);
  const [queryInput, setQueryInput] = React.useState("");
  const [activeQuery, setActiveQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [pageSize, setPageSize] = React.useState(initialPage.limit);
  const [methodFilter, setMethodFilter] = React.useState("all");
  const [modelFilter, setModelFilter] = React.useState("");
  const [latencyFilter, setLatencyFilter] = React.useState("0");
  const [rangeFilter, setRangeFilter] = React.useState("24h");
  const [loading, setLoading] = React.useState(false);
  const [detailOpen, setDetailOpen] = React.useState(false);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [selectedDetail, setSelectedDetail] =
    React.useState<RequestLogDetail | null>(null);
  const didAutoLoadRef = React.useRef(false);
  const requestIdRef = React.useRef(0);

  const totalPages = Math.max(1, logsPage.totalPages);
  const pageStart = logsPage.total > 0 ? logsPage.offset + 1 : 0;
  const pageEnd = Math.min(
    logsPage.offset + logsPage.data.length,
    logsPage.total,
  );

  const updatePage = React.useCallback(
    (page: RequestLogsPage) => {
      setLogsPage(page);
      onLoaded?.(page);
    },
    [onLoaded],
  );

  async function loadLogs(
    input: {
      page?: number;
      limit?: number;
      query?: string;
      status?: StatusFilter;
      method?: string;
      model?: string;
      minLatencyMs?: number;
      range?: string;
      successMessage?: string;
    } = {},
  ) {
    const nextPage = input.page ?? logsPage.page;
    const nextLimit = input.limit ?? pageSize;
    const nextQuery = input.query ?? activeQuery;
    const nextStatus = input.status ?? statusFilter;
    const nextMethod = input.method ?? methodFilter;
    const nextModel = input.model ?? modelFilter;
    const nextLatency = input.minLatencyMs ?? Number(latencyFilter);
    const nextRange = input.range ?? rangeFilter;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const result = await loadPage({
        limit: nextLimit,
        page: nextPage,
        query: nextQuery,
        status: nextStatus,
        method: nextMethod === "all" ? undefined : nextMethod,
        model: nextModel.trim() || undefined,
        minLatencyMs: nextLatency || undefined,
        from: rangeStart(nextRange),
      });
      if (requestId !== requestIdRef.current) return null;
      updatePage(result);
      setActiveQuery(nextQuery);
      setQueryInput(nextQuery);
      setStatusFilter(nextStatus);
      setPageSize(nextLimit);
      setMethodFilter(nextMethod);
      setModelFilter(nextModel);
      setLatencyFilter(String(nextLatency));
      setRangeFilter(nextRange);
      if (input.successMessage) {
        toast.success(input.successMessage);
      }
      return result;
    } catch (error) {
      toast.error(errorMessage(error));
      return null;
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }

  React.useEffect(() => {
    if (didAutoLoadRef.current) {
      return;
    }
    if (initialPage.data.length > 0 || initialPage.total > 0) {
      return;
    }
    didAutoLoadRef.current = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      loadPage({ limit: initialPage.limit, page: 1 })
        .then(updatePage)
        .catch((error) => {
          toast.error(errorMessage(error));
        })
        .finally(() => {
          setLoading(false);
        });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [
    errorMessage,
    initialPage.data.length,
    initialPage.limit,
    initialPage.total,
    loadPage,
    updatePage,
  ]);

  function search(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void loadLogs({ page: 1, query: queryInput });
  }

  const filtered = Boolean(
    activeQuery || statusFilter !== "all" || methodFilter !== "all" ||
    modelFilter || Number(latencyFilter) > 0 || rangeFilter !== "all",
  );

  function resetFilters() {
    setQueryInput("");
    void loadLogs({ page: 1, query: "", status: "all", method: "all", model: "", minLatencyMs: 0, range: "all" });
  }

  async function openLogDetail(id: string) {
    setDetailOpen(true);
    setDetailLoading(true);
    setSelectedDetail(null);
    try {
      setSelectedDetail(await loadDetail(id));
    } catch (error) {
      toast.error(errorMessage(error));
      setDetailOpen(false);
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div className="grid gap-3">
      <MetricStrip>
        <MetricStripItem
          label="日志"
          value={formatNumber(logsPage.total)}
          detail={
            logsPage.total > 0
              ? `${formatNumber(pageStart)}-${formatNumber(pageEnd)} / ${formatNumber(totalPages)} 页`
              : "无匹配"
          }
        />
        <MetricStripItem
          label="错误"
          value={formatNumber(logsPage.summary.errorCount)}
          detail={`错误率 ${formatPercent(ratio(logsPage.summary.errorCount, logsPage.total))}`}
        />
        <MetricStripItem
          label="Token"
          value={formatTokenNumber(logsPage.summary.totalTokens)}
          detail={`缓存 ${formatTokenNumber(logsPage.summary.cachedTokens)} · ${formatPercent(logsPage.summary.cacheHitRate)}`}
        />
        <MetricStripItem
          label="平均延迟"
          value={formatDuration(logsPage.summary.avgLatencyMs)}
          detail={activeQuery || statusFilter !== "all" ? "过滤结果" : "当前范围"}
        />
      </MetricStrip>

      <DataPanel
        flush
        title="请求日志"
        action={
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() =>
              void loadLogs({
                page: logsPage.page,
                successMessage: "日志已刷新",
              })
            }
          >
            {loading ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RefreshCwIcon data-icon="inline-start" />
            )}
            刷新
          </Button>
        }
      >
        <div className="grid gap-3 p-3">
          <SectionToolbar
            right={
              <>
                {STATUS_FILTERS.map((item) => (
                  <Button
                    key={item.id}
                    type="button"
                    size="sm"
                    variant={statusFilter === item.id ? "secondary" : "outline"}
                    disabled={loading}
                    onClick={() => void loadLogs({ page: 1, status: item.id })}
                  >
                    {item.label}
                  </Button>
                ))}
              </>
            }
          >
            <form
              className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row"
              onSubmit={search}
            >
              <div className="relative min-w-0 flex-1">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={queryInput}
                  onChange={(event) => setQueryInput(event.target.value)}
                  placeholder="路径、模型、密钥、通道、凭据、错误、状态码"
                  className="pl-8"
                />
              </div>
              <Button type="submit" disabled={loading}>
                <SearchIcon data-icon="inline-start" />
                搜索
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={loading || (!activeQuery && !queryInput)}
                onClick={() => void loadLogs({ page: 1, query: "" })}
              >
                清空
              </Button>
            </form>
          </SectionToolbar>

          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 p-2">
            <FilterIcon className="text-muted-foreground" />
            <LogFilterSelect value={rangeFilter} onChange={(value) => void loadLogs({ page: 1, range: value })} items={[["1h", "最近 1 小时"], ["24h", "最近 24 小时"], ["7d", "最近 7 天"], ["30d", "最近 30 天"], ["all", "全部时间"]]} />
            <LogFilterSelect value={methodFilter} onChange={(value) => void loadLogs({ page: 1, method: value })} items={[["all", "全部方法"], ["POST", "POST"], ["GET", "GET"], ["PUT", "PUT"], ["PATCH", "PATCH"], ["DELETE", "DELETE"]]} />
            <LogFilterSelect value={latencyFilter} onChange={(value) => void loadLogs({ page: 1, minLatencyMs: Number(value) })} items={[["0", "全部延迟"], ["1000", "≥ 1 秒"], ["3000", "≥ 3 秒"], ["10000", "≥ 10 秒"]]} />
            <Input className="h-7 w-44" value={modelFilter} onChange={(event) => setModelFilter(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void loadLogs({ page: 1, model: modelFilter }); }} placeholder="精确模型名称" />
            <Button type="button" size="sm" variant="outline" onClick={() => void loadLogs({ page: 1, model: modelFilter })} disabled={loading}>应用</Button>
            {filtered && <Button type="button" size="sm" variant="ghost" onClick={resetFilters} disabled={loading}><XIcon data-icon="inline-start" />重置筛选</Button>}
          </div>

          {loading && logsPage.data.length === 0 ? (
            <div className="flex min-h-64 items-center justify-center gap-2 rounded-lg border bg-muted/20 text-sm text-muted-foreground">
              <Spinner />
              加载日志
            </div>
          ) : logsPage.total === 0 ? (
            <LogsEmptyState
              filtered={filtered}
            />
          ) : (
            <div className="grid gap-3">
              <div className="overflow-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>时间</TableHead>
                      <TableHead>请求</TableHead>
                      <TableHead>模型</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>首字</TableHead>
                      <TableHead>
                        {detailTenantColumn ? "租户 / 通道" : "密钥 / 通道"}
                      </TableHead>
                      <TableHead>Token</TableHead>
                      <TableHead>价格</TableHead>
                      <TableHead className="w-20">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {logsPage.data.map((log) => (
                      <TableRow key={log.id} className="cursor-pointer" tabIndex={0} onClick={() => void openLogDetail(log.id)} onKeyDown={(event) => { if (event.key === "Enter") void openLogDetail(log.id); }}>
                        <TableCell className="whitespace-nowrap font-mono text-xs">
                          <LocalDateTime value={log.started_at} />
                        </TableCell>
                        <TableCell>
                          <div className="font-medium">
                            {log.method} {log.path}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {log.request_type}
                            {log.stream ? " · stream" : ""}
                          </div>
                        </TableCell>
                        <TableCell>{log.model || "-"}</TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            {renderStatusCodeBadge(log.status_code)}
                            {log.error_code && (
                              <span className="text-xs text-destructive">
                                {log.error_code}
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {formatNullableDuration(log.first_token_latency_ms)}
                        </TableCell>
                        <TableCell>
                          {detailTenantColumn ? (
                            <>
                              <div>{formatTenantName(log)}</div>
                              <div className="text-xs text-muted-foreground">
                                {log.channel_name || "-"} ·{" "}
                                {log.credential_email || "-"}
                              </div>
                              <div className="font-mono text-xs text-muted-foreground">
                                {log.api_key_prefix || "-"}
                              </div>
                            </>
                          ) : (
                            <>
                              <div>{log.api_key_name || "未知密钥"}</div>
                              <div className="font-mono text-xs text-muted-foreground">
                                {log.api_key_prefix || "-"}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {log.channel_name || "-"} ·{" "}
                                {log.credential_email || "-"}
                              </div>
                            </>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="font-mono font-medium">
                            {formatTokenNumber(log.total_tokens)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            P {formatTokenNumber(log.prompt_tokens)} / C{" "}
                            {formatTokenNumber(log.completion_tokens)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            cache {formatTokenNumber(log.cached_tokens)} ·{" "}
                            {formatPercent(log.cache_hit_rate)}
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-mono">
                          {log.cost_nano_usd ? formatCost(log.cost_nano_usd) : <span className="text-muted-foreground">未定价</span>}
                        </TableCell>
                        <TableCell>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={(event) => { event.stopPropagation(); void openLogDetail(log.id); }}
                          >
                            <FileTextIcon data-icon="inline-start" />
                            详情
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                <div className="text-xs text-muted-foreground">
                  {formatNumber(pageStart)}-{formatNumber(pageEnd)} /{" "}
                  {formatNumber(logsPage.total)}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <LogFilterSelect value={String(pageSize)} onChange={(value) => void loadLogs({ page: 1, limit: Number(value) })} items={[25, 50, 100, 200].map((size) => [String(size), `${size}/页`])} />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={loading || logsPage.page <= 1}
                    onClick={() => void loadLogs({ page: logsPage.page - 1 })}
                  >
                    上一页
                  </Button>
                  <WorkspaceStatusBadge tone="muted">
                    {formatNumber(logsPage.page)} / {formatNumber(totalPages)}
                  </WorkspaceStatusBadge>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={loading || logsPage.page >= totalPages}
                    onClick={() => void loadLogs({ page: logsPage.page + 1 })}
                  >
                    下一页
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </DataPanel>

      <RequestLogDetailDialog
        detail={selectedDetail}
        loading={detailLoading}
        onOpenChange={setDetailOpen}
        open={detailOpen}
      />
    </div>
  );
}

function LogFilterSelect({ value, onChange, items }: { value: string; onChange: (value: string) => void; items: string[][] }) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next || value)}>
      <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
      <SelectContent><SelectGroup>{items.map(([itemValue, label]) => <SelectItem key={itemValue} value={itemValue}>{label}</SelectItem>)}</SelectGroup></SelectContent>
    </Select>
  );
}

function rangeStart(range: string) {
  if (range === "all") return undefined;
  const duration = range.endsWith("h") ? Number(range.slice(0, -1)) * 3_600_000 : Number(range.slice(0, -1)) * 86_400_000;
  return new Date(Date.now() - duration).toISOString();
}

function RequestLogDetailDialog({
  detail,
  loading,
  onOpenChange,
  open,
}: {
  detail: RequestLogDetail | null;
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const log = detail?.log;
  const body = detail?.detail;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(90vh,calc(100dvh-2rem))] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>请求详情</DialogTitle>
          {log && <DialogDescription>{log.method} {log.path}</DialogDescription>}
        </DialogHeader>
        <div className="min-h-0 overscroll-contain overflow-y-auto pr-1">
      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Spinner /> 加载详情
        </div>
      ) : !log ? (
        <LogsEmptyState filtered />
      ) : (
        <div className="grid gap-3">
          <DataPanel title="概要">
            <div className="grid gap-3 text-sm md:grid-cols-3">
              <DetailKV label="开始" value={formatDateTime(log.started_at)} />
              <DetailKV label="完成" value={formatDateTime(log.completed_at)} />
              <DetailKV
                label="状态"
                value={
                  <span className="flex items-center gap-2">
                    {renderStatusCodeBadge(log.status_code)}
                    {formatDuration(log.latency_ms)}
                  </span>
                }
              />
              <DetailKV label="模型" value={log.model || "-"} />
              <DetailKV label="租户" value={formatTenantName(log)} />
              <DetailKV
                label="Token"
                value={`${formatTokenNumber(log.total_tokens)} · cache ${formatTokenNumber(log.cached_tokens)} (${formatPercent(log.cache_hit_rate)})`}
              />
              <DetailKV label="价格" value={log.cost_nano_usd ? formatCost(log.cost_nano_usd) : "未定价"} />
              <DetailKV label="密钥" value={log.api_key_name || "未知密钥"} />
              <DetailKV
                label="通道"
                value={`${log.channel_name || "-"} · ${log.credential_email || "-"}`}
              />
            </div>
          </DataPanel>

          <CostCalculationBlock log={log} />

          {!body ? (
            <LogsEmptyState filtered />
          ) : (
            <>
              <StageTimingsBlock timings={body.stage_timings} />
              <DetailBlock
                title="请求 Headers"
                value={formatDetailValue(body.request_headers)}
              />
              <DetailBlock
                title="请求 Body"
                value={body.request_body_text}
                truncated={body.request_body_truncated}
                bytes={body.request_body_bytes}
              />
              <DetailBlock
                title="转发 Body"
                value={body.forwarded_body_text}
                truncated={body.forwarded_body_truncated}
                bytes={body.forwarded_body_bytes}
              />
              <DetailBlock
                title={`上游响应${body.upstream_status_code ? ` · ${body.upstream_status_code}` : ""}`}
                value={body.upstream_body_text}
                truncated={body.upstream_body_truncated}
                bytes={body.upstream_body_bytes}
              />
              <DetailBlock
                title="上游 Headers"
                value={formatDetailValue(body.upstream_headers)}
              />
              {(body.error_message || body.error_stack || log.error_message) && (
                <DetailBlock
                  title={`错误${body.error_name ? ` · ${body.error_name}` : ""}`}
                  value={[
                    body.error_message || log.error_message || "",
                    body.error_stack || "",
                    formatDetailValue(body.error_cause),
                    formatDetailValue(body.detail),
                  ]
                    .filter(Boolean)
                    .join("\n\n")}
                />
              )}
            </>
          )}
        </div>
      )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CostCalculationBlock({ log }: { log: RequestLogDetail["log"] }) {
  if (!log.pricing || !log.cost_nano_usd) {
    return <DataPanel title="价格计算"><p className="text-sm text-muted-foreground">此请求没有完整的历史单价快照，无法还原逐项计算。</p></DataPanel>;
  }
  const uncachedInput = Math.max(0, log.prompt_tokens - log.cached_tokens);
  const rows = [
    ["普通输入", uncachedInput, log.pricing.inputNanoUsdPerToken],
    ["缓存输入", log.cached_tokens, log.pricing.cachedInputNanoUsdPerToken],
    ["缓存写入", log.cache_write_tokens, log.pricing.cacheWriteNanoUsdPerToken],
    ["输出", log.completion_tokens, log.pricing.outputNanoUsdPerToken],
    ["推理", log.reasoning_tokens, log.pricing.reasoningNanoUsdPerToken],
  ] as const;
  return <DataPanel title="价格计算">
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground"><span>计价模型 {log.price_model || log.model}</span><span>价格版本 {log.price_version || "-"}</span><span>单价单位 USD / 1M Token</span></div>
      <Table><TableHeader><TableRow><TableHead>项目</TableHead><TableHead className="text-right">Token</TableHead><TableHead className="text-right">单价</TableHead><TableHead className="text-right">小计</TableHead></TableRow></TableHeader><TableBody>{rows.map(([label, tokens, price]) => <TableRow key={label}><TableCell>{label}</TableCell><TableCell className="text-right font-mono">{formatTokenNumber(tokens)}</TableCell><TableCell className="text-right font-mono">{formatUnitPrice(price)}</TableCell><TableCell className="text-right font-mono">{formatCost(String(BigInt(tokens) * BigInt(price)))}</TableCell></TableRow>)}</TableBody></Table>
      <div className="text-right font-medium">合计 {formatCost(log.cost_nano_usd)}</div>
      <p className="text-xs text-muted-foreground">普通输入 = 输入 Token − 缓存输入 Token；总成本为五项小计之和。</p>
    </div>
  </DataPanel>;
}

function formatCost(value: string) { return `$${(Number(value) / 1_000_000_000).toFixed(6)}`; }
function formatUnitPrice(value: string) { return `$${(Number(value) / 1_000).toFixed(4)}`; }

function DetailKV({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 min-w-0 truncate">{value}</div>
    </div>
  );
}

function StageTimingsBlock({
  timings,
}: {
  timings: NonNullable<RequestLogDetail["detail"]>["stage_timings"];
}) {
  if (!timings.length) {
    return null;
  }
  const total = Math.max(
    ...timings.map((item) => item.endedAtMs),
    ...timings.map((item) => item.durationMs),
    1,
  );
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const colors = [
    "bg-chart-1",
    "bg-chart-2",
    "bg-chart-3",
    "bg-chart-4",
    "bg-chart-5",
  ];
  const longestDuration = Math.max(...timings.map((item) => item.durationMs), 0);
  const longestStage = timings.find((item) => item.durationMs === longestDuration);
  return (
    <DataPanel title="阶段耗时">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary">总耗时 {formatDuration(total)}</Badge>
          <span>{timings.length} 个阶段</span>
          {longestStage ? (
            <span className="truncate">
              主要耗时：{longestStage.label || longestStage.name}（{formatDuration(longestDuration)}）
            </span>
          ) : null}
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-[42rem]">
            <div className="grid grid-cols-[minmax(10rem,0.85fr)_minmax(22rem,2fr)_6.5rem] items-end gap-4 border-b bg-muted/20 px-2 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              <span>阶段</span>
              <div className="flex justify-between font-mono font-normal normal-case tracking-normal">
                {ticks.map((tick) => (
                  <span key={tick}>{formatDuration(total * tick)}</span>
                ))}
              </div>
              <span className="text-right">耗时</span>
            </div>

            <div className="divide-y divide-border/60">
              {timings.map((item, index) => {
                const left = Math.min(100, (item.startedAtMs / total) * 100);
                const availableWidth = Math.max(0, 100 - left);
                const width = Math.min(availableWidth, (item.durationMs / total) * 100);
                const isInstant = width < 1;

                return (
                  <div
                    key={`${item.name}:${index}`}
                    className="grid grid-cols-[minmax(10rem,0.85fr)_minmax(22rem,2fr)_6.5rem] items-center gap-4 rounded-md px-2 py-2.5 text-xs transition-colors hover:bg-muted/40"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium" title={item.label || item.name}>
                        {item.label || item.name}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                        {formatNumber(item.startedAtMs)} → {formatNumber(item.endedAtMs)} ms
                      </div>
                    </div>
                    <div className="relative h-7 overflow-hidden rounded-md border bg-muted/70 shadow-inner">
                      <div className="absolute inset-y-0 left-1/4 border-l border-border" />
                      <div className="absolute inset-y-0 left-1/2 border-l border-border" />
                      <div className="absolute inset-y-0 left-3/4 border-l border-border" />
                      <div
                        className={cn(
                          "absolute inset-y-1 rounded-sm shadow-sm ring-1 ring-background/80",
                          colors[index % colors.length],
                          isInstant && "min-w-1.5",
                        )}
                        style={{ left: `${left}%`, width: `${width}%` }}
                        title={`${formatDuration(item.durationMs)} · ${formatNumber(item.startedAtMs)}-${formatNumber(item.endedAtMs)}ms`}
                      />
                    </div>
                    <div className="text-right font-mono font-semibold tabular-nums">
                      {formatDuration(item.durationMs)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </DataPanel>
  );
}

function DetailBlock({
  bytes,
  title,
  truncated,
  value,
}: {
  bytes?: number;
  title: string;
  truncated?: boolean;
  value: string | null | undefined;
}) {
  const displayValue = value || "-";
  return (
    <DataPanel
      title={
        <span className="flex flex-wrap items-center gap-2">
          {title}
          {truncated && (
            <WorkspaceStatusBadge tone="warning">截断</WorkspaceStatusBadge>
          )}
          {bytes ? (
            <span className="font-mono text-xs font-normal text-muted-foreground">
              {formatNumber(bytes)} bytes
            </span>
          ) : null}
        </span>
      }
      action={
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!value}
          onClick={() => value && void copyText(value)}
        >
          <CopyIcon data-icon="inline-start" />
          复制
        </Button>
      }
    >
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md bg-muted/40 p-3 text-xs leading-relaxed">
        {displayValue}
      </pre>
    </DataPanel>
  );
}

function LogsEmptyState({ filtered }: { filtered: boolean }) {
  return (
    <Empty className="min-h-52">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {filtered ? <SearchIcon /> : <FileTextIcon />}
        </EmptyMedia>
        <EmptyTitle>{filtered ? "无匹配日志" : "暂无日志"}</EmptyTitle>
        <EmptyDescription>
          {filtered ? "调整过滤条件。" : "等待请求。"}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function LocalDateTime({ value }: { value: string }) {
  const isClient = React.useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
  return (
    <time dateTime={value} suppressHydrationWarning>
      {isClient ? formatDateTime(value) : "-"}
    </time>
  );
}

function subscribeNoop() {
  return () => undefined;
}

function renderStatusCodeBadge(statusCode: number) {
  if (statusCode >= 200 && statusCode < 400) {
    return <WorkspaceStatusBadge tone="success">{statusCode}</WorkspaceStatusBadge>;
  }
  if (statusCode >= 400) {
    return <WorkspaceStatusBadge tone="danger">{statusCode}</WorkspaceStatusBadge>;
  }
  return (
    <WorkspaceStatusBadge tone="muted">
      {statusCode || "pending"}
    </WorkspaceStatusBadge>
  );
}

function formatTenantName(
  log: Pick<RequestLogDetail["log"], "tenant_id" | "tenant_name">,
) {
  return log.tenant_name || log.tenant_id || "未归属";
}

function formatDetailValue(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success("已复制");
  } catch {
    toast.error("复制失败");
  }
}

function ratio(numerator: number, denominator: number) {
  if (!denominator) {
    return null;
  }
  return (numerator / denominator) * 100;
}

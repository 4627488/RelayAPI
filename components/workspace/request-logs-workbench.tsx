"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  CopyIcon,
  FileTextIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DataPanel } from "@/components/workspace/data-panel";
import { WorkbenchDetailSheet } from "@/components/workspace/detail-sheet";
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
} from "@/lib/admin-api";

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
  loadPage: (options?: {
    limit?: number;
    page?: number;
    query?: string;
    status?: RequestLogStatusFilter;
  }) => Promise<RequestLogsPage>;
  onLoaded?: (page: RequestLogsPage) => void;
}) {
  const [logsPage, setLogsPage] = React.useState(initialPage);
  const [queryInput, setQueryInput] = React.useState("");
  const [activeQuery, setActiveQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [pageSize, setPageSize] = React.useState(initialPage.limit);
  const [loading, setLoading] = React.useState(false);
  const [detailOpen, setDetailOpen] = React.useState(false);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [selectedDetail, setSelectedDetail] =
    React.useState<RequestLogDetail | null>(null);
  const didAutoLoadRef = React.useRef(false);

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
      successMessage?: string;
    } = {},
  ) {
    const nextPage = input.page ?? logsPage.page;
    const nextLimit = input.limit ?? pageSize;
    const nextQuery = input.query ?? activeQuery;
    const nextStatus = input.status ?? statusFilter;
    setLoading(true);
    try {
      const result = await loadPage({
        limit: nextLimit,
        page: nextPage,
        query: nextQuery,
        status: nextStatus,
      });
      updatePage(result);
      setActiveQuery(nextQuery);
      setQueryInput(nextQuery);
      setStatusFilter(nextStatus);
      setPageSize(nextLimit);
      if (input.successMessage) {
        toast.success(input.successMessage);
      }
      return result;
    } catch (error) {
      toast.error(errorMessage(error));
      return null;
    } finally {
      setLoading(false);
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

          {loading && logsPage.data.length === 0 ? (
            <div className="flex min-h-64 items-center justify-center gap-2 rounded-lg border bg-muted/20 text-sm text-muted-foreground">
              <Spinner />
              加载日志
            </div>
          ) : logsPage.total === 0 ? (
            <LogsEmptyState
              filtered={Boolean(activeQuery || statusFilter !== "all")}
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
                      <TableHead className="w-20">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {logsPage.data.map((log) => (
                      <TableRow key={log.id}>
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
                        <TableCell>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void openLogDetail(log.id)}
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
                  <select
                    value={pageSize}
                    className="h-8 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                    onChange={(event) =>
                      void loadLogs({
                        page: 1,
                        limit: Number.parseInt(event.target.value, 10),
                      })
                    }
                  >
                    {[25, 50, 100, 200].map((size) => (
                      <option key={size} value={size}>
                        {size}/页
                      </option>
                    ))}
                  </select>
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

      <RequestLogDetailSheet
        detail={selectedDetail}
        loading={detailLoading}
        onOpenChange={setDetailOpen}
        open={detailOpen}
      />
    </div>
  );
}

function RequestLogDetailSheet({
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
    <WorkbenchDetailSheet
      className="sm:max-w-4xl"
      description={log ? `${log.method} ${log.path}` : undefined}
      onOpenChange={onOpenChange}
      open={open}
      title="请求详情"
    >
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
              <DetailKV label="密钥" value={log.api_key_name || "未知密钥"} />
              <DetailKV
                label="通道"
                value={`${log.channel_name || "-"} · ${log.credential_email || "-"}`}
              />
            </div>
          </DataPanel>

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
    </WorkbenchDetailSheet>
  );
}

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
  return (
    <DataPanel title="阶段耗时">
      <div className="grid gap-2">
        {timings.map((item, index) => (
          <div
            key={`${item.name}:${index}`}
            className="grid gap-1 rounded-md bg-muted/25 p-2 text-xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{item.label || item.name}</span>
              <span className="font-mono text-muted-foreground">
                {formatDuration(item.durationMs)} ·{" "}
                {formatNumber(item.startedAtMs)}-{formatNumber(item.endedAtMs)}
                ms
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{
                  width: `${Math.max(2, Math.min(100, (item.durationMs / total) * 100))}%`,
                }}
              />
            </div>
          </div>
        ))}
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

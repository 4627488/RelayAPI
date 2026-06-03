"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  AlertTriangleIcon,
  CopyIcon,
  DatabaseIcon,
  FileTextIcon,
  RefreshCwIcon,
  SearchIcon,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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
import type {
  RequestLogDetail,
  RequestLogsPage,
  RequestLogStatusFilter,
} from "@/lib/admin-api";
import {
  getTenantRequestLogDetail,
  getTenantRequestLogsPage,
  tenantErrorMessage,
} from "@/lib/tenant-api";

type LogStatusFilter = Extract<
  RequestLogStatusFilter,
  "all" | "success" | "error"
>;

const LOG_STATUS_FILTERS: Array<{ id: LogStatusFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "success", label: "成功" },
  { id: "error", label: "错误" },
];

export function TenantLogsSection({
  initialPage,
  onLoaded,
}: {
  initialPage: RequestLogsPage;
  onLoaded: (page: RequestLogsPage) => void;
}) {
  const [logsPage, setLogsPage] = React.useState(initialPage);
  const [queryInput, setQueryInput] = React.useState("");
  const [activeQuery, setActiveQuery] = React.useState("");
  const [statusFilter, setStatusFilter] =
    React.useState<LogStatusFilter>("all");
  const [pageSize, setPageSize] = React.useState(initialPage.limit);
  const [loading, setLoading] = React.useState(false);
  const [detailOpen, setDetailOpen] = React.useState(false);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [selectedDetail, setSelectedDetail] =
    React.useState<RequestLogDetail | null>(null);
  const didAutoLoadRef = React.useRef(false);

  const totalPages = Math.max(1, logsPage.totalPages);
  const pageStart = logsPage.total > 0 ? logsPage.offset + 1 : 0;
  const pageEnd = Math.min(logsPage.offset + logsPage.data.length, logsPage.total);

  async function loadLogs(
    input: {
      page?: number;
      limit?: number;
      query?: string;
      status?: LogStatusFilter;
      successMessage?: string;
    } = {},
  ) {
    const nextPage = input.page ?? logsPage.page;
    const nextLimit = input.limit ?? pageSize;
    const nextQuery = input.query ?? activeQuery;
    const nextStatus = input.status ?? statusFilter;
    setLoading(true);
    try {
      const result = await getTenantRequestLogsPage({
        limit: nextLimit,
        page: nextPage,
        query: nextQuery,
        status: nextStatus,
      });
      setLogsPage(result);
      setActiveQuery(nextQuery);
      setQueryInput(nextQuery);
      setStatusFilter(nextStatus);
      setPageSize(nextLimit);
      onLoaded(result);
      if (input.successMessage) {
        toast.success(input.successMessage);
      }
      return result;
    } catch (error) {
      toast.error(tenantErrorMessage(error));
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
      getTenantRequestLogsPage({
        limit: initialPage.limit,
        page: 1,
      })
        .then((result) => {
          setLogsPage(result);
          onLoaded(result);
        })
        .catch((error) => {
          toast.error(tenantErrorMessage(error));
        })
        .finally(() => {
          setLoading(false);
        });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [initialPage.data.length, initialPage.limit, initialPage.total, onLoaded]);

  function search(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void loadLogs({ page: 1, query: queryInput });
  }

  async function openLogDetail(id: string) {
    setDetailOpen(true);
    setDetailLoading(true);
    setSelectedDetail(null);
    try {
      setSelectedDetail(await getTenantRequestLogDetail(id));
    } catch (error) {
      toast.error(tenantErrorMessage(error));
      setDetailOpen(false);
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <LogMetricCard
          title="匹配日志"
          value={formatNumber(logsPage.total)}
          description={
            logsPage.total > 0
              ? `第 ${formatNumber(logsPage.page)}/${formatNumber(totalPages)} 页 · ${formatNumber(pageStart)}-${formatNumber(pageEnd)}`
              : "没有匹配结果"
          }
          icon={FileTextIcon}
        />
        <LogMetricCard
          title="匹配错误"
          value={formatNumber(logsPage.summary.errorCount)}
          description={`错误率 ${formatPercent(ratio(logsPage.summary.errorCount, logsPage.total))}`}
          icon={AlertTriangleIcon}
          tone={logsPage.summary.errorCount > 0 ? "warning" : "success"}
        />
        <LogMetricCard
          title="匹配 Token"
          value={formatTokenNumber(logsPage.summary.totalTokens)}
          description={`缓存 ${formatTokenNumber(logsPage.summary.cachedTokens)} · 命中率 ${formatPercent(logsPage.summary.cacheHitRate)} · 平均延迟 ${formatDuration(logsPage.summary.avgLatencyMs)}`}
          icon={DatabaseIcon}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>请求日志</CardTitle>
          <CardDescription>
            服务端分页查询当前租户请求日志，支持按状态和关键字搜索。
          </CardDescription>
          <CardAction>
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() =>
                void loadLogs({
                  page: logsPage.page,
                  successMessage: "请求日志已刷新",
                })
              }
            >
              {loading ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RefreshCwIcon data-icon="inline-start" />
              )}
              刷新日志
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <form
              className="flex w-full flex-col gap-2 sm:flex-row xl:max-w-2xl"
              onSubmit={search}
            >
              <div className="relative min-w-0 flex-1">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={queryInput}
                  onChange={(event) => setQueryInput(event.target.value)}
                  placeholder="搜索路径、模型、密钥、通道、凭据、错误、状态码..."
                  className="pl-8"
                />
              </div>
              <div className="flex gap-2">
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
              </div>
            </form>
            <div className="flex flex-wrap gap-2">
              {LOG_STATUS_FILTERS.map((item) => (
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
            </div>
          </div>

          {activeQuery && (
            <div className="text-sm text-muted-foreground">
              当前搜索：
              <span className="font-medium text-foreground">{activeQuery}</span>
            </div>
          )}

          {loading && logsPage.data.length === 0 ? (
            <div className="flex min-h-64 items-center justify-center gap-2 rounded-lg border bg-muted/20 text-sm text-muted-foreground">
              <Spinner />
              正在加载请求日志
            </div>
          ) : logsPage.total === 0 ? (
            <EmptyState
              icon={activeQuery ? SearchIcon : FileTextIcon}
              title={
                activeQuery || statusFilter !== "all"
                  ? "没有匹配的日志"
                  : "还没有请求日志"
              }
              description={
                activeQuery || statusFilter !== "all"
                  ? "调整关键字或状态筛选条件后再试。"
                  : "创建 API 密钥并调用 Relay 接口后，这里会展示当前租户的请求日志。"
              }
            />
          ) : (
            <div className="grid gap-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>时间</TableHead>
                    <TableHead>请求</TableHead>
                    <TableHead>模型</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>首字延迟</TableHead>
                    <TableHead>密钥 / 通道</TableHead>
                    <TableHead>Token</TableHead>
                    <TableHead>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logsPage.data.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell>
                        <LocalDateTime value={log.started_at} />
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">
                          {log.method} {log.path}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {log.request_type}
                          {log.stream ? " · 流式" : ""}
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
                        <div>{log.api_key_name || "未知密钥"}</div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {log.api_key_prefix || "-"}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {log.channel_name || "-"} ·{" "}
                          {log.credential_email || "-"}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">
                          {formatTokenNumber(log.total_tokens)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          输入 {formatTokenNumber(log.prompt_tokens)} / 输出{" "}
                          {formatTokenNumber(log.completion_tokens)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          缓存 {formatTokenNumber(log.cached_tokens)} ·{" "}
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
                          详细
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="text-sm text-muted-foreground">
                  显示 {formatNumber(pageStart)}-{formatNumber(pageEnd)} / 共{" "}
                  {formatNumber(logsPage.total)} 条
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
                        每页 {size}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={loading || logsPage.page <= 1}
                    onClick={() => void loadLogs({ page: 1 })}
                  >
                    首页
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={loading || logsPage.page <= 1}
                    onClick={() => void loadLogs({ page: logsPage.page - 1 })}
                  >
                    上一页
                  </Button>
                  <Badge variant="outline">
                    {formatNumber(logsPage.page)} / {formatNumber(totalPages)}
                  </Badge>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={loading || logsPage.page >= totalPages}
                    onClick={() => void loadLogs({ page: logsPage.page + 1 })}
                  >
                    下一页
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={loading || logsPage.page >= totalPages}
                    onClick={() => void loadLogs({ page: totalPages })}
                  >
                    末页
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <RequestLogDetailDialog
        open={detailOpen}
        loading={detailLoading}
        detail={selectedDetail}
        onOpenChange={setDetailOpen}
      />
    </div>
  );
}

function RequestLogDetailDialog({
  open,
  loading,
  detail,
  onOpenChange,
}: {
  open: boolean;
  loading: boolean;
  detail: RequestLogDetail | null;
  onOpenChange: (open: boolean) => void;
}) {
  const log = detail?.log;
  const body = detail?.detail;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>请求日志详情</DialogTitle>
          <DialogDescription>
            {log
              ? `${log.method} ${log.path} · ${log.request_type}`
              : "加载详细日志中..."}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner /> 正在加载详情...
          </div>
        ) : !log ? (
          <EmptyState
            icon={FileTextIcon}
            title="没有详情"
            description="未找到该请求日志的详情数据。"
            compact
          />
        ) : (
          <div className="grid gap-4">
            <div className="grid gap-3 rounded-lg border border-border/60 p-3 text-sm md:grid-cols-3">
              <div>
                <div className="text-xs text-muted-foreground">开始时间</div>
                <LocalDateTime value={log.started_at} />
              </div>
              <div>
                <div className="text-xs text-muted-foreground">完成时间</div>
                <LocalDateTime value={log.completed_at} />
              </div>
              <div>
                <div className="text-xs text-muted-foreground">状态 / 延迟</div>
                <div className="flex items-center gap-2">
                  {renderStatusCodeBadge(log.status_code)}
                  <span>{formatDuration(log.latency_ms)}</span>
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">模型</div>
                <div>{log.model || "-"}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">
                  Token / 缓存
                </div>
                <div>
                  {formatTokenNumber(log.total_tokens)} · 缓存{" "}
                  {formatTokenNumber(log.cached_tokens)} (
                  {formatPercent(log.cache_hit_rate)})
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">密钥</div>
                <div>{log.api_key_name || "未知密钥"}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">通道 / 凭据</div>
                <div>
                  {log.channel_name || "-"} · {log.credential_email || "-"}
                </div>
              </div>
            </div>

            {!body ? (
              <EmptyState
                icon={FileTextIcon}
                title="暂无详细内容"
                description="旧日志或关闭完整日志时的成功请求可能只有概要数据；报错请求会保留错误详情。"
                compact
              />
            ) : (
              <div className="grid gap-4">
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
                  title="转发到上游的 Body"
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
                {(body.error_message ||
                  body.error_stack ||
                  log.error_message) && (
                  <DetailBlock
                    title={`错误详情${body.error_name ? ` · ${body.error_name}` : ""}`}
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
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
    <div className="grid gap-3 rounded-lg border border-border/60 p-3">
      <div>
        <div className="font-medium">阶段耗时</div>
        <div className="text-xs text-muted-foreground">
          记录每个转发阶段的相对开始、结束和耗时；不受完整日志开关影响。
        </div>
      </div>
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
    </div>
  );
}

function DetailBlock({
  title,
  value,
  truncated,
  bytes,
}: {
  title: string;
  value: string | null | undefined;
  truncated?: boolean;
  bytes?: number;
}) {
  const displayValue = value || "-";
  return (
    <div className="grid gap-2 rounded-lg border border-border/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-medium">
          {title}
          {truncated && (
            <Badge className="ml-2" variant="secondary">
              已截断
            </Badge>
          )}
          {bytes ? (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {formatNumber(bytes)} bytes
            </span>
          ) : null}
        </div>
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
      </div>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md bg-muted/40 p-3 text-xs leading-relaxed">
        {displayValue}
      </pre>
    </div>
  );
}

function LogMetricCard({
  title,
  value,
  description,
  icon: Icon,
  tone = "default",
}: {
  title: string;
  value: string;
  description: string;
  icon: LucideIcon;
  tone?: "default" | "success" | "warning";
}) {
  const toneClasses = {
    default: "bg-primary/10 text-primary",
    success: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    warning: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  };

  return (
    <Card>
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardAction>
          <div className={`rounded-lg p-2 ${toneClasses[tone]}`}>
            <Icon />
          </div>
        </CardAction>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

function EmptyState({
  compact = false,
  description,
  icon: Icon,
  title,
}: {
  compact?: boolean;
  description: string;
  icon: LucideIcon;
  title: string;
}) {
  return (
    <Empty className={compact ? "min-h-36" : "min-h-64"}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function renderStatusCodeBadge(statusCode: number) {
  if (statusCode >= 200 && statusCode < 400) {
    return <Badge variant="secondary">{statusCode}</Badge>;
  }
  if (statusCode >= 400) {
    return <Badge variant="destructive">{statusCode}</Badge>;
  }
  return <Badge variant="outline">{statusCode || "待处理"}</Badge>;
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
    toast.success("已复制到剪贴板");
  } catch {
    toast.error("复制失败，请手动复制");
  }
}

function LocalDateTime({ value }: { value: string }) {
  const isClient = React.useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
  const date = parseUtcDate(value);
  return (
    <time dateTime={date?.toISOString()} suppressHydrationWarning>
      {isClient ? formatDateTime(value) : "-"}
    </time>
  );
}

function subscribeNoop() {
  return () => undefined;
}

function formatDateTime(value: string) {
  const date = parseUtcDate(value);
  if (!date) {
    return "-";
  }

  const parts = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value || "";

  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

function parseUtcDate(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.includes(" ") ? trimmed.replace(" ", "T") : trimmed;
  const normalizedWithTime = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? `${normalized}T00:00:00`
    : normalized;
  const hasTimeZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(normalizedWithTime);
  const timestamp = Date.parse(
    hasTimeZone ? normalizedWithTime : `${normalizedWithTime}Z`,
  );
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return new Date(timestamp);
}

function formatNullableDuration(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? formatDuration(value)
    : "-";
}

function formatDuration(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 ms";
  }
  if (value < 1000) {
    return `${Math.round(value)} ms`;
  }
  return `${(value / 1000).toFixed(2)} s`;
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatTokenNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  const absValue = Math.abs(value);
  if (absValue >= 1_000_000_000) {
    return `${formatScaledNumber(value / 1_000_000_000)}B`;
  }
  if (absValue >= 1_000_000) {
    return `${formatScaledNumber(value / 1_000_000)}M`;
  }
  if (absValue >= 1_000) {
    return `${formatScaledNumber(value / 1_000)}K`;
  }
  return formatNumber(value);
}

function formatScaledNumber(value: number) {
  const absValue = Math.abs(value);
  const maximumFractionDigits = absValue >= 100 ? 0 : absValue >= 10 ? 1 : 2;
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value);
}

function formatPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "-";
  }
  return `${value.toFixed(1)}%`;
}

function ratio(numerator: number, denominator: number) {
  if (!denominator) {
    return null;
  }
  return (numerator / denominator) * 100;
}

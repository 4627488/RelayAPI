import { RequestLogInsight } from "@/components/request-log-insight"
import type { MouseEvent } from "react"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { RequestLog } from "@/lib/api"
import {
  cacheHitRateLabel,
  compactTokens,
  dateTime,
  money,
  requestLogStatus,
  requestLogSucceeded,
  requestLogTransport,
} from "@/lib/format"
import { routeHref, type Workspace } from "@/lib/routes"

export function RequestLogKey({ log }: { log: RequestLog }) {
  return (
    <div className="min-w-0">
      <p className="truncate font-medium" title={log.api_key_name}>
        {log.api_key_name || (log.api_key_id ? "未命名 Key" : "未记录 Key")}
      </p>
      {log.api_key_prefix ? (
        <p
          className="truncate font-mono text-xs text-muted-foreground"
          title={`${log.api_key_prefix}…`}
        >
          {log.api_key_prefix}…
        </p>
      ) : null}
    </div>
  )
}

function Result({ log }: { log: RequestLog }) {
  const routedModel = log.actual_model || log.model
  const tier = (
    log.response_service_tier?.trim() ||
    log.service_tier?.trim() ||
    ""
  ).toLowerCase()
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge
        variant={
          requestLogSucceeded(log.status_code, log.error_code)
            ? "secondary"
            : "destructive"
        }
      >
        {requestLogStatus(log.status_code)}
      </Badge>
      <span className="text-xs text-muted-foreground">
        {requestLogTransport(log.request_type, log.stream)}
      </span>
      {tier === "priority" ? (
        <Badge
          variant="outline"
          title="Priority 优先处理；默认按普通价格的 2 倍计费，管理员档位规则优先"
        >
          Fast
        </Badge>
      ) : null}
      {log.upstream_model &&
      routedModel &&
      log.upstream_model !== routedModel ? (
        <Badge
          variant="outline"
          title={`${routedModel} → ${log.upstream_model}`}
        >
          上游模型不同
        </Badge>
      ) : null}
    </div>
  )
}

function duration(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`
}

function displayedModel(log: RequestLog) {
  const routed =
    log.actual_model || log.model || log.requested_model || log.path
  return log.upstream_model && log.upstream_model !== routed
    ? `${routed} → ${log.upstream_model}`
    : routed
}

export function RequestLogList({
  logs,
  workspace = "user",
  onOpen,
}: {
  logs: RequestLog[]
  workspace?: Workspace
  onOpen?: (log: RequestLog) => void
}) {
  const admin = workspace === "admin"
  function link(log: RequestLog) {
    return {
      href: routeHref({ workspace, page: "logs", logId: log.id }),
      "aria-label": `查看日志 ${log.model || log.path} ${dateTime(log.started_at)}${log.log_unit === "legacy_session" ? " · 历史会话" : ""}`,
      onClick: (event: MouseEvent<HTMLAnchorElement>) => {
        if (
          !onOpen ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return
        event.preventDefault()
        onOpen(log)
      },
    }
  }
  return (
    <div className="@container min-w-0">
      <div className="hidden @4xl:block">
        <Table className="w-full table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[13%] pl-4">时间</TableHead>
              <TableHead className="w-[26%]">模型 / 入口</TableHead>
              <TableHead className="w-[20%]">
                {admin ? "用户 / Key" : "Key"}
              </TableHead>
              <TableHead className="w-[10%]">结果</TableHead>
              <TableHead className="w-[11%] text-right">Tokens</TableHead>
              <TableHead className="w-[11%] text-right">耗时</TableHead>
              <TableHead className="w-[9%] pr-4 text-right">费用</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.map((log) => (
              <TableRow key={log.id}>
                <TableCell className="py-2 pl-4 text-xs text-muted-foreground">
                  <time dateTime={log.started_at}>
                    {dateTime(log.started_at)}
                  </time>
                  {log.log_unit === "legacy_session" ? (
                    <span className="block">历史会话</span>
                  ) : null}
                </TableCell>
                <TableCell className="min-w-0 py-2">
                  <a
                    {...link(log)}
                    className="block truncate font-medium underline-offset-4 hover:underline focus-visible:underline"
                    title={displayedModel(log)}
                  >
                    {displayedModel(log)}
                  </a>
                  <p
                    className="truncate text-xs text-muted-foreground"
                    title={`${log.method} ${log.path} · ${log.client_name || "未知客户端"}`}
                  >
                    {log.client_name || "未知客户端"} · {log.path}
                  </p>
                </TableCell>
                <TableCell className="min-w-0 py-2">
                  <p className="truncate font-medium" title={log.api_key_name}>
                    {log.api_key_name ||
                      (log.api_key_id ? "未命名 Key" : "未记录 Key")}
                  </p>
                  <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    {admin ? (
                      <span
                        className="min-w-0 truncate"
                        title={log.tenant_name || log.tenant_id}
                      >
                        {log.tenant_name || log.tenant_id || "未知用户"}
                      </span>
                    ) : null}
                    {log.api_key_prefix ? (
                      <span
                        className="shrink-0 font-mono"
                        title={`${log.api_key_prefix}…`}
                      >
                        {log.api_key_prefix}…
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="py-2 whitespace-normal">
                  <Result log={log} />
                  {log.error_code && (
                    <p
                      className="mt-1 truncate text-xs text-destructive"
                      title={log.error_code}
                    >
                      {log.error_code}
                    </p>
                  )}
                </TableCell>
                <TableCell className="py-2 text-right tabular-nums">
                  <RequestLogInsight
                    log={log}
                    section="usage"
                    workspace={workspace}
                  >
                    {compactTokens(log.total_tokens)}
                  </RequestLogInsight>
                  <p className="text-xs text-muted-foreground">
                    缓存率{" "}
                    {cacheHitRateLabel(log.cached_tokens, log.prompt_tokens)}
                  </p>
                </TableCell>
                <TableCell className="py-2 text-right tabular-nums">
                  <RequestLogInsight
                    log={log}
                    section="latency"
                    workspace={workspace}
                  >
                    {duration(log.latency_ms)}
                  </RequestLogInsight>
                  <p
                    className="text-xs text-muted-foreground"
                    title="请求开始至 Relay 观测到首个非空生成内容（含推理或工具参数）；未观测时显示 —"
                  >
                    首 Token{" "}
                    {log.first_token_ms != null
                      ? duration(log.first_token_ms)
                      : "—"}
                  </p>
                </TableCell>
                <TableCell className="py-2 pr-4 text-right tabular-nums">
                  <RequestLogInsight
                    log={log}
                    section="billing"
                    workspace={workspace}
                  >
                    {money(log.cost_nano_usd)}
                  </RequestLogInsight>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="divide-y @4xl:hidden" aria-label="请求记录">
        {logs.map((log) => (
          <li key={log.id}>
            <div className="flex min-w-0 flex-col gap-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <time className="text-xs text-muted-foreground">
                  {dateTime(log.started_at)}
                  {log.log_unit === "legacy_session" ? " · 历史会话" : ""}
                </time>
                <Result log={log} />
              </div>
              <div className="min-w-0">
                <a
                  {...link(log)}
                  className="block truncate font-medium underline-offset-4 hover:underline focus-visible:underline"
                >
                  {displayedModel(log)}
                </a>
                <p className="truncate text-xs text-muted-foreground">
                  {log.client_name || "未知客户端"} · {log.path}
                </p>
              </div>
              <div className="flex min-w-0 gap-3 text-sm">
                <span className="shrink-0 text-muted-foreground">Key</span>
                <div className="min-w-0 flex-1">
                  <RequestLogKey log={log} />
                  {admin && (
                    <p className="truncate text-xs text-muted-foreground">
                      用户：{log.tenant_name || log.tenant_id || "未知用户"}
                    </p>
                  )}
                </div>
              </div>
              {log.error_code && (
                <p className="truncate text-xs text-destructive">
                  {log.error_code}
                </p>
              )}
              <dl className="grid grid-cols-3 gap-2 text-sm tabular-nums">
                <div>
                  <dt className="text-xs text-muted-foreground">Tokens</dt>
                  <dd>
                    <RequestLogInsight
                      log={log}
                      section="usage"
                      workspace={workspace}
                    >
                      {compactTokens(log.total_tokens)}
                    </RequestLogInsight>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">耗时</dt>
                  <dd>
                    <RequestLogInsight
                      log={log}
                      section="latency"
                      workspace={workspace}
                    >
                      {duration(log.latency_ms)}
                    </RequestLogInsight>
                  </dd>
                </div>
                <div className="text-right">
                  <dt className="text-xs text-muted-foreground">费用</dt>
                  <dd>
                    <RequestLogInsight
                      log={log}
                      section="billing"
                      workspace={workspace}
                    >
                      {money(log.cost_nano_usd)}
                    </RequestLogInsight>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">缓存率</dt>
                  <dd>
                    {cacheHitRateLabel(log.cached_tokens, log.prompt_tokens)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">首 Token</dt>
                  <dd>
                    {log.first_token_ms != null
                      ? duration(log.first_token_ms)
                      : "—"}
                  </dd>
                </div>
              </dl>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

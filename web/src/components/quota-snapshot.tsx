import { Badge } from "@/components/ui/badge"
import { Progress, ProgressLabel } from "@/components/ui/progress"
import {
  type ParentQuotaWindow,
  type UpstreamQuotaReport,
  type UpstreamQuotaWindow,
} from "@/lib/api"
import { dateTime, money } from "@/lib/format"

type Props = {
  snapshot?: UpstreamQuotaReport | Record<string, never> | null
  status?: "unknown" | "supported" | "unsupported" | "error"
  error?: string
  observedAt?: string | null
  configuredWindows?: ParentQuotaWindow[]
  compact?: boolean
}

type DisplayWindow = {
  upstream: UpstreamQuotaWindow
  configured?: ParentQuotaWindow
}

export function QuotaSnapshot({
  snapshot,
  status = "unknown",
  error,
  observedAt,
  configuredWindows = [],
  compact = false,
}: Props) {
  const report = isQuotaReport(snapshot) ? snapshot : null
  const windows = displayWindows(report?.windows ?? [], configuredWindows)
  if (!windows.length) {
    const message =
      status === "unsupported"
        ? "上游未提供自动额度"
        : status === "error"
          ? error || "额度探测失败"
          : status === "supported"
            ? "已连接，等待额度窗口"
            : "尚未探测"
    return (
      <span className="text-xs text-muted-foreground" title={error}>
        {message}
      </span>
    )
  }

  const shown = compact ? windows.slice(0, 3) : windows
  return (
    <div
      className={
        compact ? "flex min-w-48 flex-col gap-1.5" : "flex flex-col gap-3"
      }
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {report?.plan_type ? (
          <Badge variant="secondary">{report.plan_type}</Badge>
        ) : null}
        {status === "error" ? (
          <Badge variant="destructive" title={error}>
            {report ? "快照可用" : "已有额度可用"} · 刷新失败
          </Badge>
        ) : null}
        {!compact && report?.source ? (
          <Badge variant="outline">{report.source}</Badge>
        ) : null}
        {!compact && (report?.observed_at || observedAt) ? (
          <span className="text-xs text-muted-foreground">
            观测于 {dateTime(report?.observed_at || observedAt || undefined)}
          </span>
        ) : null}
      </div>
      {shown.map((window, index) =>
        compact ? (
          <CompactWindow
            key={`${window.upstream.kind}:${index}`}
            item={window}
          />
        ) : (
          <DetailedWindow
            key={`${window.upstream.kind}:${index}`}
            item={window}
          />
        )
      )}
      {compact && windows.length > shown.length ? (
        <span className="text-xs text-muted-foreground">
          另有 {windows.length - shown.length} 个窗口
        </span>
      ) : null}
    </div>
  )
}

function CompactWindow({ item }: { item: DisplayWindow }) {
  const { upstream: window, configured } = item
  const used = usedPercent(window)
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="truncate">{window.label || window.kind}</span>
        <span className="text-muted-foreground tabular-nums">
          {compactValue(window, configured, used)}
        </span>
      </div>
      {used == null ? null : (
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary"
            style={{ width: `${Math.min(100, Math.max(0, used))}%` }}
          />
        </div>
      )}
      {window.resets_at || configured?.resets_at ? (
        <span className="text-[11px] text-muted-foreground">
          {dateTime(window.resets_at || configured?.resets_at)} 重置
        </span>
      ) : null}
    </div>
  )
}

function DetailedWindow({ item }: { item: DisplayWindow }) {
  const { upstream: window, configured } = item
  const used = usedPercent(window)
  if (used == null) {
    return (
      <div className="rounded-md border bg-muted/30 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">{window.label || window.kind}</span>
          {configured ? (
            <CapacityBadge window={configured} />
          ) : (
            <span className="text-sm text-muted-foreground tabular-nums">
              {amount(window)}
            </span>
          )}
        </div>
        <WindowMeta window={window} configured={configured} />
      </div>
    )
  }
  return (
    <Progress
      value={Math.min(100, Math.max(0, used))}
      className="rounded-md border bg-muted/20 p-3"
    >
      <ProgressLabel>{window.label || window.kind}</ProgressLabel>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        {configured ? <CapacityBadge window={configured} /> : null}
        <span className="text-sm text-muted-foreground tabular-nums">
          已用 {formatNumber(used)}%
        </span>
      </div>
      <WindowMeta window={window} configured={configured} />
    </Progress>
  )
}

function CapacityBadge({ window }: { window: ParentQuotaWindow }) {
  const label = window.source === "manual_conversion" ? "手工容量" : "推测容量"
  return (
    <Badge variant="secondary">
      {label} {money(window.limit_nano_usd)}
    </Badge>
  )
}

function WindowMeta({
  window,
  configured,
}: {
  window: UpstreamQuotaWindow
  configured?: ParentQuotaWindow
}) {
  const resetsAt = window.resets_at || configured?.resets_at
  return (
    <p className="w-full text-xs text-muted-foreground">
      {window.enforceable ? "参与父订阅校准" : "仅展示，不参与总容量校准"}
      {resetsAt ? ` · ${dateTime(resetsAt)} 重置` : ""}
      {window.remaining != null || window.limit != null
        ? ` · ${amount(window)}`
        : ""}
    </p>
  )
}

function displayWindows(
  upstream: UpstreamQuotaWindow[],
  configured: ParentQuotaWindow[]
): DisplayWindow[] {
  const configuredByKind = new Map(
    configured.map((window) => [window.kind, window])
  )
  const seen = new Set<string>()
  const result = upstream.map((window) => {
    seen.add(window.kind)
    return { upstream: window, configured: configuredByKind.get(window.kind) }
  })
  for (const window of configured) {
    if (seen.has(window.kind)) continue
    result.push({
      upstream: {
        kind: window.kind,
        label: window.kind,
        used_percent: window.observed_used_percent,
        resets_at: window.resets_at,
        enforceable: true,
      },
      configured: window,
    })
  }
  return result
}

function compactValue(
  window: UpstreamQuotaWindow,
  configured: ParentQuotaWindow | undefined,
  used: number | null
) {
  const values = []
  if (used != null) values.push(`${formatNumber(used)}%`)
  if (configured) {
    const source = configured.source === "manual_conversion" ? "手工" : "推测"
    values.push(`${source} ${money(configured.limit_nano_usd)}`)
  }
  return values.join(" · ") || amount(window)
}

function usedPercent(window: UpstreamQuotaWindow) {
  if (
    typeof window.used_percent === "number" &&
    Number.isFinite(window.used_percent)
  )
    return window.used_percent
  if (
    typeof window.remaining_percent === "number" &&
    Number.isFinite(window.remaining_percent)
  )
    return 100 - window.remaining_percent
  return null
}

function amount(window: UpstreamQuotaWindow) {
  const unit = window.unit || "units"
  if (window.remaining != null && window.limit != null)
    return `剩余 ${formatNumber(window.remaining)} / ${formatNumber(window.limit)} ${unit}`
  if (window.remaining != null)
    return `剩余 ${formatNumber(window.remaining)} ${unit}`
  if (window.limit != null) return `总额 ${formatNumber(window.limit)} ${unit}`
  return "额度值未提供"
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(
    value
  )
}

function isQuotaReport(value: Props["snapshot"]): value is UpstreamQuotaReport {
  return Boolean(
    value &&
    typeof value === "object" &&
    "supported" in value &&
    Array.isArray((value as UpstreamQuotaReport).windows)
  )
}

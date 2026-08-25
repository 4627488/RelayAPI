import { HStack, VStack } from "@astryxdesign/core/Layout"
import { ProgressBar } from "@astryxdesign/core/ProgressBar"
import { Text } from "@astryxdesign/core/Text"
import { Token } from "@astryxdesign/core/Token"

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
      <Text color="secondary" type="supporting">
        {message}
      </Text>
    )
  }

  const shown = compact ? windows.slice(0, 3) : windows
  return (
    <VStack gap={compact ? 2 : 3}>
      <HStack gap={2} wrap="wrap" vAlign="center">
        {report?.plan_type ? <Token label={report.plan_type} color="gray" /> : null}
        {status === "error" ? (
          <Token
            label={report ? "快照可用 · 刷新失败" : "已有额度可用 · 刷新失败"}
            color="red"
          />
        ) : null}
        {!compact && report?.source ? (
          <Token label={report.source} color="gray" />
        ) : null}
        {!compact && (report?.observed_at || observedAt) ? (
          <Text color="secondary" type="supporting">
            观测于 {dateTime(report?.observed_at || observedAt || undefined)}
          </Text>
        ) : null}
      </HStack>
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
        <Text color="secondary" type="supporting">
          另有 {windows.length - shown.length} 个窗口
        </Text>
      ) : null}
    </VStack>
  )
}

function CompactWindow({ item }: { item: DisplayWindow }) {
  const { upstream: window, configured } = item
  const used = usedPercent(window)
  return (
    <VStack gap={1}>
      <HStack hAlign="between" gap={3} vAlign="center">
        <Text type="supporting">{window.label || window.kind}</Text>
        <Text color="secondary" type="supporting">
          {compactValue(window, configured, used)}
        </Text>
      </HStack>
      {used == null ? null : (
        <ProgressBar
          label={`${window.label || window.kind}已用`}
          isLabelHidden
          value={Math.min(100, Math.max(0, used))}
        />
      )}
      {window.resets_at || configured?.resets_at ? (
        <Text color="secondary" type="supporting">
          {dateTime(window.resets_at || configured?.resets_at)} 重置
        </Text>
      ) : null}
    </VStack>
  )
}

function DetailedWindow({ item }: { item: DisplayWindow }) {
  const { upstream: window, configured } = item
  const used = usedPercent(window)
  if (used == null) {
    return (
      <VStack gap={2}>
        <HStack hAlign="between" wrap="wrap" gap={2} vAlign="center">
          <Text weight="semibold">{window.label || window.kind}</Text>
          {configured ? (
            <CapacityToken window={configured} />
          ) : (
            <Text color="secondary">{amount(window)}</Text>
          )}
        </HStack>
        <WindowMeta window={window} configured={configured} />
      </VStack>
    )
  }
  return (
    <VStack gap={2}>
      <HStack hAlign="between" wrap="wrap" gap={2} vAlign="center">
        <Text weight="semibold">{window.label || window.kind}</Text>
        <HStack gap={2} wrap="wrap" vAlign="center">
          {configured ? <CapacityToken window={configured} /> : null}
          <Text color="secondary">已用 {formatNumber(used)}%</Text>
        </HStack>
      </HStack>
      <ProgressBar
        label={`${window.label || window.kind}已用`}
        isLabelHidden
        value={Math.min(100, Math.max(0, used))}
      />
      <WindowMeta window={window} configured={configured} />
    </VStack>
  )
}

function CapacityToken({ window }: { window: ParentQuotaWindow }) {
  const label = window.source === "manual_conversion" ? "手工容量" : "推测容量"
  return <Token label={`${label} ${money(window.limit_nano_usd)}`} color="gray" />
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
    <Text color="secondary" type="supporting">
      {window.enforceable ? "参与父订阅校准" : "仅展示，不参与总容量校准"}
      {resetsAt ? ` · ${dateTime(resetsAt)} 重置` : ""}
      {window.remaining != null || window.limit != null
        ? ` · ${amount(window)}`
        : ""}
    </Text>
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

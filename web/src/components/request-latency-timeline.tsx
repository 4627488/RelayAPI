import { ActivityIcon, ClockIcon, GaugeIcon, NetworkIcon } from "lucide-react"
import type { ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

type LatencyOwner = "relay" | "queue" | "upstream" | "downstream" | "billing"

type LatencySegment = {
  id: string
  label: string
  owner: LatencyOwner
  track: "critical" | "network"
  start_ms: number
  duration_ms: number
  description?: string
}

type LatencyMark = {
  id: string
  label: string
  offset_ms: number
}

type LatencyTrace = {
  version: number
  total_ms: number
  boundary?: string
  segments: LatencySegment[]
  marks?: LatencyMark[]
}

const ownerMeta: Record<LatencyOwner, { label: string; dot: string; bar: string; soft: string }> = {
  relay: { label: "Relay", dot: "bg-violet-500", bar: "bg-violet-500", soft: "bg-violet-500/10 text-violet-700 dark:text-violet-300" },
  queue: { label: "排队", dot: "bg-amber-500", bar: "bg-amber-500", soft: "bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  upstream: { label: "上游", dot: "bg-rose-500", bar: "bg-rose-500", soft: "bg-rose-500/10 text-rose-700 dark:text-rose-300" },
  downstream: { label: "响应传输", dot: "bg-emerald-500", bar: "bg-emerald-500", soft: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  billing: { label: "计费", dot: "bg-indigo-500", bar: "bg-indigo-500", soft: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300" },
}

export function RequestLatencyTimeline({ value, totalMS, ttftMS, stream }: { value?: string; totalMS: number; ttftMS?: number; stream: boolean }) {
  const trace = parseTrace(value)
  if (!trace) return null

  const total = Math.max(trace.total_ms, totalMS, 0.001)
  const critical = trace.segments.filter((segment) => segment.track === "critical")
  const network = trace.segments.filter((segment) => segment.track === "network")
  const attribution = ownerTotals(critical)
  const diagnosis = diagnose(attribution, total, stream)

  return (
    <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
      <div className="border-b bg-gradient-to-br from-violet-500/[0.08] via-background to-sky-500/[0.08] p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <ActivityIcon className="size-4 text-violet-500" />
              <h3 className="text-sm font-semibold">请求关键路径</h3>
              <Badge variant="outline" className="rounded-full bg-background/70 font-normal">实测</Badge>
            </div>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">{diagnosis.message}</p>
          </div>
          <span className={cn("rounded-full px-2.5 py-1 text-xs font-medium", ownerMeta[diagnosis.owner].soft)}>
            {diagnosis.label}
          </span>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric icon={<ClockIcon />} label="端到端" value={formatMS(total)} />
          <Metric icon={<GaugeIcon />} label="首字节" value={ttftMS != null ? formatMS(ttftMS) : "未观测"} />
          <Metric icon={<NetworkIcon />} label="主要耗时" value={`${ownerMeta[diagnosis.owner].label} ${formatPercent(diagnosis.duration / total)}`} />
          <Metric icon={<ActivityIcon />} label="关键阶段" value={`${critical.length} 个`} />
        </div>

        <div className="mt-4 flex h-2.5 overflow-hidden rounded-full bg-muted ring-1 ring-border/60">
          {critical.map((segment, index) => (
            <div
              key={`${segment.id}-${index}`}
              className={cn("h-full min-w-px transition-opacity hover:opacity-75", ownerMeta[segment.owner].bar)}
              style={{ width: `${Math.max(0, segment.duration_ms / total) * 100}%` }}
              title={`${segment.label} · ${formatMS(segment.duration_ms)}`}
            />
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
          {(Object.keys(ownerMeta) as LatencyOwner[]).map((owner) => attribution[owner] > 0 ? (
            <span key={owner} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className={cn("size-1.5 rounded-full", ownerMeta[owner].dot)} />
              {ownerMeta[owner].label} {formatMS(attribution[owner])}
            </span>
          ) : null)}
        </div>
      </div>

      <div className="overflow-x-auto p-4 sm:p-5">
        <div className="min-w-[600px]">
          <TimeRuler total={total} />
          <div className="mt-3 space-y-2">
            {critical.map((segment, index) => <TimelineRow key={`${segment.id}-${index}`} segment={segment} total={total} />)}
          </div>

          {network.length ? (
            <div className="mt-5 border-t pt-4">
              <div className="mb-3 flex items-center gap-2 text-xs font-medium">
                <NetworkIcon className="size-3.5 text-muted-foreground" />
                HTTP 网络细节
                <span className="font-normal text-muted-foreground">可与关键路径重叠，不重复计入归因</span>
              </div>
              <div className="space-y-2">
                {network.map((segment, index) => <TimelineRow key={`${segment.id}-${index}`} segment={segment} total={total} compact />)}
              </div>
            </div>
          ) : null}

          {trace.marks?.length ? <TimelineMarks marks={trace.marks} total={total} /> : null}
        </div>
      </div>

      {trace.boundary ? (
        <div className="border-t bg-muted/25 px-4 py-3 text-[11px] leading-relaxed text-muted-foreground sm:px-5">
          {trace.boundary}。因此“原生运行时 / 上游处理”可以可靠判断慢在 Relay 之外，但不能虚构供应商内部的 DNS、排队或推理占比。
        </div>
      ) : null}
    </section>
  )
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-background/70 p-3 backdrop-blur-sm">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground [&_svg]:size-3.5">{icon}{label}</div>
      <div className="mt-1 truncate text-sm font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function TimeRuler({ total }: { total: number }) {
  return (
    <div className="grid grid-cols-[150px_1fr] items-end gap-3">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">阶段</span>
      <div className="relative h-5 border-b">
        {[0, 25, 50, 75, 100].map((percent) => (
          <div key={percent} className="absolute bottom-0 -translate-x-1/2 text-[10px] tabular-nums text-muted-foreground" style={{ left: `${percent}%` }}>
            <span className="block h-1.5 border-l" />
            <span className={percent === 0 ? "translate-x-1/2" : percent === 100 ? "-translate-x-1/2" : ""}>{formatMS(total * percent / 100)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function TimelineRow({ segment, total, compact = false }: { segment: LatencySegment; total: number; compact?: boolean }) {
  const left = Math.min(100, Math.max(0, segment.start_ms / total * 100))
  const width = Math.min(100 - left, Math.max(0, segment.duration_ms / total * 100))
  const meta = ownerMeta[segment.owner]
  return (
    <div className="group grid grid-cols-[150px_1fr] items-center gap-3" title={segment.description}>
      <div className="min-w-0">
        <div className="truncate text-xs font-medium">{segment.label}</div>
        <div className="text-[10px] tabular-nums text-muted-foreground">+{formatMS(segment.start_ms)} · {formatMS(segment.duration_ms)}</div>
      </div>
      <div className={cn("relative overflow-hidden rounded-md bg-muted/70", compact ? "h-5" : "h-7")}>
        <div className="absolute inset-y-0 left-1/4 border-l border-dashed border-border/70" />
        <div className="absolute inset-y-0 left-1/2 border-l border-dashed border-border/70" />
        <div className="absolute inset-y-0 left-3/4 border-l border-dashed border-border/70" />
        <div
          className={cn("absolute inset-y-1 min-w-[3px] rounded-sm shadow-sm transition-all group-hover:brightness-110", meta.bar, compact && "opacity-75")}
          style={{ left: `${left}%`, width: `max(${width}%, 3px)` }}
        />
        {!compact && width > 14 ? (
          <span className="absolute inset-y-0 flex items-center truncate px-2 text-[10px] font-medium text-white drop-shadow-sm" style={{ left: `${left}%`, width: `${width}%` }}>
            {formatMS(segment.duration_ms)}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function TimelineMarks({ marks, total }: { marks: LatencyMark[]; total: number }) {
  return (
    <div className="mt-4 grid grid-cols-[150px_1fr] gap-3 border-t pt-3">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">里程碑</span>
      <div className="relative h-9">
        {marks.map((mark) => {
          const left = Math.min(100, Math.max(0, mark.offset_ms / total * 100))
          return (
            <div key={mark.id} className="absolute top-0 -translate-x-1/2" style={{ left: `${left}%` }} title={`${mark.label} · +${formatMS(mark.offset_ms)}`}>
              <span className="mx-auto block h-3 border-l-2 border-foreground/60" />
              <span className="block whitespace-nowrap rounded-full bg-foreground px-2 py-0.5 text-[9px] text-background">{mark.label}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function parseTrace(value?: string): LatencyTrace | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<LatencyTrace>
    if (parsed.version !== 2 || !Array.isArray(parsed.segments) || typeof parsed.total_ms !== "number") return null
    const segments = parsed.segments.filter((segment): segment is LatencySegment => {
      if (!segment || typeof segment !== "object") return false
      const candidate = segment as Partial<LatencySegment>
      return typeof candidate.id === "string" && typeof candidate.label === "string" &&
        typeof candidate.start_ms === "number" && typeof candidate.duration_ms === "number" &&
        (candidate.track === "critical" || candidate.track === "network") &&
        typeof candidate.owner === "string" && candidate.owner in ownerMeta
    })
    return { version: 2, total_ms: parsed.total_ms, boundary: parsed.boundary, marks: parsed.marks, segments }
  } catch {
    return null
  }
}

function ownerTotals(segments: LatencySegment[]) {
  const result: Record<LatencyOwner, number> = { relay: 0, queue: 0, upstream: 0, downstream: 0, billing: 0 }
  for (const segment of segments) result[segment.owner] += Math.max(0, segment.duration_ms)
  return result
}

function diagnose(totals: Record<LatencyOwner, number>, total: number, stream: boolean) {
  let owner = (Object.keys(totals) as LatencyOwner[]).reduce((current, candidate) => totals[candidate] > totals[current] ? candidate : current, "relay")
  if (stream && owner === "downstream") {
    return { owner, duration: totals[owner], label: "流式传输占主导", message: `响应建立后持续传输了 ${formatMS(totals.downstream)}。这是流式会话持续时间，不等同于首字节慢；请结合首字节指标判断模型是否启动缓慢。` }
  }
  if (owner === "upstream") {
    return { owner, duration: totals[owner], label: "上游耗时占主导", message: `主要时间花在 原生运行时 / 模型供应商返回响应上（${formatPercent(totals.upstream / total)}）。Relay 已完成鉴权、准入和转发，优先检查上游负载、凭据重试或模型生成速度。` }
  }
  if (owner === "queue") {
    return { owner, duration: totals[owner], label: "本地排队占主导", message: `请求主要等待 Relay 的 原生运行时 并发槽位（${formatMS(totals.queue)}）。这通常意味着本实例并发或请求体内存预算已接近上限。` }
  }
  if (owner === "relay" || owner === "billing") {
    owner = totals.billing > totals.relay ? "billing" : "relay"
    return { owner, duration: totals[owner], label: "Relay 处理占主导", message: `主要耗时发生在 Relay 的${owner === "billing" ? "订阅、预留与结算" : "鉴权、策略或请求准备"}阶段，应该优先排查本服务与数据库。` }
  }
  return { owner, duration: totals[owner], label: `${ownerMeta[owner].label}占主导`, message: `主要耗时为${ownerMeta[owner].label} ${formatMS(totals[owner])}，可结合下方各阶段起点和持续时间继续定位。` }
}

function formatMS(value: number) {
  if (!Number.isFinite(value)) return "—"
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)} s`
  if (value >= 10) return `${value.toFixed(0)} ms`
  if (value >= 1) return `${value.toFixed(1)} ms`
  return `${value.toFixed(3)} ms`
}

function formatPercent(value: number) {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`
}

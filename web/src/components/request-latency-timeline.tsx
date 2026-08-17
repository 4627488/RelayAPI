import { ActivityIcon, ClockIcon, GaugeIcon, NetworkIcon } from "lucide-react"
import type { ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

type LatencyOwner = "relay" | "queue" | "cpa" | "upstream" | "downstream" | "billing"

type LatencySegment = {
  id: string
  label: string
  owner: LatencyOwner
  track: "critical" | "cpa" | "attempt" | "network"
  start_ms: number
  duration_ms: number
  description?: string
  attempt?: number
  status?: string
  provider?: string
  model?: string
  credential?: string
  error?: string
  reused?: boolean
  remote_addr?: string
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

const ownerMeta: Record<LatencyOwner, { label: string; bar: string }> = {
  relay: { label: "Relay", bar: "bg-foreground" },
  queue: { label: "排队", bar: "bg-chart-2" },
  cpa: { label: "CPA 内部", bar: "bg-chart-3" },
  upstream: { label: "供应商", bar: "bg-chart-4" },
  downstream: { label: "响应传输", bar: "bg-chart-2" },
  billing: { label: "计费", bar: "bg-chart-5" },
}

export function RequestLatencyTimeline({ value, totalMS, ttftMS, stream }: { value?: string; totalMS: number; ttftMS?: number; stream: boolean }) {
  const trace = parseTrace(value)
  if (!trace) return null

  const total = Math.max(trace.total_ms, totalMS, 0.001)
  const critical = trace.segments.filter((segment) => segment.track === "critical")
  const cpa = trace.segments.filter((segment) => segment.track === "cpa")
  const attempts = trace.segments.filter((segment) => segment.track === "attempt" && segment.id.startsWith("cpa_attempt_"))
  const retryWaits = trace.segments.filter((segment) => segment.track === "attempt" && segment.id.startsWith("cpa_retry_wait_"))
  const network = trace.segments.filter((segment) => segment.track === "network")
  const providerNetwork = network.filter((segment) => segment.id.startsWith("cpa_attempt_"))
  const relayNetwork = network.filter((segment) => !segment.id.startsWith("cpa_attempt_"))
  const attribution = ownerTotals(critical)
  const diagnosis = diagnose(attribution, total, stream, attempts, retryWaits, cpa, providerNetwork)

  return (
    <section className="overflow-hidden rounded-lg border bg-card">
      <div className="border-b p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <ActivityIcon className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">请求关键路径</h3>
              <Badge variant="outline">实测</Badge>
            </div>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">{diagnosis.message}</p>
          </div>
          <Badge variant="secondary">{diagnosis.label}</Badge>
        </div>

        <div className="mt-4 grid grid-cols-2 border sm:grid-cols-4">
          <Metric icon={<ClockIcon />} label="端到端" value={formatMS(total)} />
          <Metric icon={<GaugeIcon />} label="首字节" value={ttftMS != null ? formatMS(ttftMS) : "未观测"} />
          <Metric icon={<ActivityIcon />} label="上游尝试" value={attempts.length ? `${attempts.length} 次` : "未采集"} />
          <Metric icon={<NetworkIcon />} label="主要耗时" value={`${ownerMeta[diagnosis.owner].label} ${formatPercent(diagnosis.duration / total)}`} />
        </div>

        <div className="mt-4 flex h-2 overflow-hidden rounded-sm bg-muted">
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
              <span className={cn("size-1.5 rounded-[1px]", ownerMeta[owner].bar)} />
              {ownerMeta[owner].label} {formatMS(attribution[owner])}
            </span>
          ) : null)}
        </div>
      </div>

      <div className="overflow-x-auto p-4 sm:p-5">
        <div className="min-w-[680px]">
          <TimeRuler total={total} />
          <div className="mt-3 flex flex-col gap-2">
            {critical.map((segment, index) => <TimelineRow key={`${segment.id}-${index}`} segment={segment} total={total} />)}
          </div>

          {cpa.length || attempts.length ? (
            <div className="mt-5 border-t pt-4">
              <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium">
                <ActivityIcon className="size-3.5 text-muted-foreground" />
                CPA 内部执行
                <span className="font-normal text-muted-foreground">真实 executor 调用；多次尝试代表重试、凭据切换或模型池回退</span>
              </div>
              <div className="flex flex-col gap-2">
                {[...cpa, ...attempts, ...retryWaits].sort((a, b) => a.start_ms - b.start_ms).map((segment, index) => (
                  <TimelineRow key={`${segment.id}-${index}`} segment={segment} total={total} compact detail />
                ))}
              </div>
            </div>
          ) : null}

          {providerNetwork.length ? (
            <div className="mt-5 border-t pt-4">
              <div className="mb-3 flex items-center gap-2 text-xs font-medium">
                <NetworkIcon className="size-3.5 text-muted-foreground" />
                供应商网络细节
                <span className="font-normal text-muted-foreground">每次尝试独立采集，可与关键路径重叠</span>
              </div>
              <div className="flex flex-col gap-2">
                {providerNetwork.map((segment, index) => <TimelineRow key={`${segment.id}-${index}`} segment={segment} total={total} compact />)}
              </div>
            </div>
          ) : null}

          {relayNetwork.length ? (
            <div className="mt-5 border-t pt-4">
              <div className="mb-3 flex items-center gap-2 text-xs font-medium">
                <NetworkIcon className="size-3.5 text-muted-foreground" />
                Relay → CPA 本地链路
                <span className="font-normal text-muted-foreground">连接池与本机 HTTP 写入，不代表供应商网络</span>
              </div>
              <div className="flex flex-col gap-2">
                {relayNetwork.map((segment, index) => <TimelineRow key={`${segment.id}-${index}`} segment={segment} total={total} compact />)}
              </div>
            </div>
          ) : null}

          {trace.marks?.length ? <TimelineMarks marks={trace.marks} total={total} /> : null}
        </div>
      </div>

      {trace.boundary ? (
        <div className="border-t bg-muted/25 px-4 py-3 text-xs text-muted-foreground sm:px-5">
          {trace.boundary}。
        </div>
      ) : null}
    </section>
  )
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="border-r border-b p-3 last:border-r-0 sm:border-b-0">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground [&_svg]:size-3.5">{icon}{label}</div>
      <div className="mt-1 truncate text-sm font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function TimeRuler({ total }: { total: number }) {
  return (
    <div className="grid grid-cols-[180px_1fr] items-end gap-3">
      <span className="text-xs text-muted-foreground">阶段</span>
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

function TimelineRow({ segment, total, compact = false, detail = false }: { segment: LatencySegment; total: number; compact?: boolean; detail?: boolean }) {
  const left = Math.min(100, Math.max(0, segment.start_ms / total * 100))
  const width = Math.min(100 - left, Math.max(0, segment.duration_ms / total * 100))
  const meta = ownerMeta[segment.owner]
  return (
    <div className="group grid grid-cols-[180px_1fr] items-center gap-3" title={[segment.description, segment.error].filter(Boolean).join(" · ")}>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          {detail && segment.status ? <span className={cn("size-1.5 shrink-0 rounded-full", segment.status === "failed" ? "bg-destructive" : "bg-chart-2")} /> : null}
          <div className="truncate text-xs font-medium">{segment.label}</div>
        </div>
        <div className="text-[10px] tabular-nums text-muted-foreground">+{formatMS(segment.start_ms)} · {formatMS(segment.duration_ms)}</div>
        {detail && (segment.provider || segment.model) ? (
          <div className={cn("truncate text-[10px]", segment.error ? "text-destructive" : "text-muted-foreground")}>
            {[segment.provider, segment.model].filter(Boolean).join(" · ")}{segment.error ? ` · ${segment.error}` : ""}
          </div>
        ) : null}
      </div>
      <div className={cn("relative overflow-hidden rounded-md bg-muted/70", compact ? "h-5" : "h-7")}>
        <div className="absolute inset-y-0 left-1/4 border-l border-dashed border-border/70" />
        <div className="absolute inset-y-0 left-1/2 border-l border-dashed border-border/70" />
        <div className="absolute inset-y-0 left-3/4 border-l border-dashed border-border/70" />
        <div
          className={cn("absolute inset-y-1 min-w-[3px] rounded-sm transition-opacity duration-150 group-hover:opacity-75", segment.status === "failed" ? "bg-destructive" : meta.bar, compact && "opacity-75")}
          style={{ left: `${left}%`, width: `max(${width}%, 3px)` }}
        />
        {!compact && width > 14 ? (
          <span className="absolute inset-y-0 flex items-center truncate px-2 text-[10px] font-medium text-background" style={{ left: `${left}%`, width: `${width}%` }}>
            {formatMS(segment.duration_ms)}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function TimelineMarks({ marks, total }: { marks: LatencyMark[]; total: number }) {
  return (
    <div className="mt-4 grid grid-cols-[180px_1fr] gap-3 border-t pt-3">
      <span className="text-xs text-muted-foreground">里程碑</span>
      <div className="relative h-9">
        {marks.map((mark) => {
          const left = Math.min(100, Math.max(0, mark.offset_ms / total * 100))
          return (
            <div key={mark.id} className="absolute top-0 -translate-x-1/2" style={{ left: `${left}%` }} title={`${mark.label} · +${formatMS(mark.offset_ms)}`}>
              <span className="mx-auto block h-3 border-l-2 border-foreground/60" />
              <span className="block whitespace-nowrap rounded-sm bg-foreground px-1.5 py-0.5 text-[9px] text-background">{mark.label}</span>
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
    if ((parsed.version !== 2 && parsed.version !== 3) || !Array.isArray(parsed.segments) || typeof parsed.total_ms !== "number") return null
    const segments = parsed.segments.filter((segment): segment is LatencySegment => {
      if (!segment || typeof segment !== "object") return false
      const candidate = segment as Partial<LatencySegment>
      return typeof candidate.id === "string" && typeof candidate.label === "string" &&
        typeof candidate.start_ms === "number" && typeof candidate.duration_ms === "number" &&
        (candidate.track === "critical" || candidate.track === "cpa" || candidate.track === "attempt" || candidate.track === "network") &&
        typeof candidate.owner === "string" && candidate.owner in ownerMeta
    })
    const marks = Array.isArray(parsed.marks) ? parsed.marks.filter((mark): mark is LatencyMark =>
      Boolean(mark) && typeof mark.id === "string" && typeof mark.label === "string" && typeof mark.offset_ms === "number"
    ) : undefined
    return { version: parsed.version, total_ms: parsed.total_ms, boundary: parsed.boundary, marks, segments }
  } catch {
    return null
  }
}

function ownerTotals(segments: LatencySegment[]) {
  const result: Record<LatencyOwner, number> = { relay: 0, queue: 0, cpa: 0, upstream: 0, downstream: 0, billing: 0 }
  for (const segment of segments) result[segment.owner] += Math.max(0, segment.duration_ms)
  return result
}

function diagnose(
  totals: Record<LatencyOwner, number>,
  total: number,
  stream: boolean,
  attempts: LatencySegment[],
  retryWaits: LatencySegment[],
  cpa: LatencySegment[],
  network: LatencySegment[],
) {
  let owner = (Object.keys(totals) as LatencyOwner[]).reduce((current, candidate) => totals[candidate] > totals[current] ? candidate : current, "relay")
  const failedAttempts = attempts.filter((attempt) => attempt.status === "failed")
  const retryWait = retryWaits.reduce((sum, segment) => sum + Math.max(0, segment.duration_ms), 0)
  const providerWait = network.filter((segment) => segment.id.endsWith("_wait_first_byte")).reduce((sum, segment) => sum + Math.max(0, segment.duration_ms), 0)
  const dispatch = cpa.reduce((sum, segment) => sum + Math.max(0, segment.duration_ms), 0)

  if (attempts.length > 1) {
    owner = retryWait > providerWait ? "queue" : "upstream"
    const failed = failedAttempts.length ? `，其中 ${failedAttempts.length} 次失败` : ""
    const waiting = retryWait > 0 ? `，重试等待 ${formatMS(retryWait)}` : ""
    return {
      owner,
      duration: Math.max(retryWait, providerWait, attempts.reduce((sum, attempt) => sum + Math.max(0, attempt.duration_ms), 0)),
      label: `${attempts.length} 次上游尝试`,
      message: `CPA 实际发起了 ${attempts.length} 次供应商调用${failed}${waiting}。请按下方尝试顺序查看失败凭据、模型池回退和每次供应商首包等待。`,
    }
  }
  if (providerWait > 0 && providerWait >= Math.max(dispatch, totals.relay, totals.billing)) {
    owner = "upstream"
    return {
      owner,
      duration: providerWait,
      label: "供应商首包较慢",
      message: `CPA 写完上游请求后等待供应商首个响应字节 ${formatMS(providerWait)}。连接、DNS 和 TLS 已单独列出，因此这里更接近供应商排队或模型启动时间。`,
    }
  }
  if (dispatch > 0 && dispatch > Math.max(10, total * 0.15)) {
    owner = "cpa"
    return {
      owner,
      duration: dispatch,
      label: "CPA 调度较慢",
      message: `CPA 在协议路由、请求翻译与凭据选择上用了 ${formatMS(dispatch)}。如果该阶段持续偏高，应检查可用凭据规模、冷却状态和模型路由配置。`,
    }
  }
  if (stream && owner === "downstream") {
    return { owner, duration: totals[owner], label: "流式传输占主导", message: `响应建立后持续传输了 ${formatMS(totals.downstream)}。这是流式会话持续时间，不等同于首字节慢；请结合首字节指标判断模型是否启动缓慢。` }
  }
  if (owner === "upstream") {
    return { owner, duration: totals[owner], label: "供应商耗时占主导", message: `主要时间花在供应商返回响应上（${formatPercent(totals.upstream / total)}）。可继续对照下方 CPA 尝试和网络阶段，区分连接、重试与模型生成。` }
  }
  if (owner === "queue") {
    return { owner, duration: totals[owner], label: "本地排队占主导", message: `请求主要等待 Relay 的 CPA 并发槽位（${formatMS(totals.queue)}）。这通常意味着本实例并发或请求体内存预算已接近上限。` }
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

import { ActivityIcon, ClockIcon, GaugeIcon } from "lucide-react"
import { useState, type ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

type LatencyOwner =
  "relay" | "queue" | "cpa" | "upstream" | "downstream" | "billing"

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

type DisplaySegment = LatencySegment & {
  steps?: LatencySegment[]
}

const ownerMeta: Record<
  LatencyOwner,
  { label: string; bar: string; soft: string }
> = {
  relay: { label: "Relay", bar: "bg-foreground", soft: "bg-foreground/5" },
  queue: { label: "排队", bar: "bg-chart-2", soft: "bg-chart-2/10" },
  cpa: { label: "CPA", bar: "bg-chart-3", soft: "bg-chart-3/10" },
  upstream: { label: "供应商", bar: "bg-chart-4", soft: "bg-chart-4/10" },
  downstream: { label: "传输", bar: "bg-chart-2", soft: "bg-chart-2/10" },
  billing: { label: "结算", bar: "bg-chart-5", soft: "bg-chart-5/10" },
}

export function RequestLatencyTimeline({
  value,
  totalMS,
  ttftMS,
  stream,
}: {
  value?: string
  totalMS: number
  ttftMS?: number
  stream: boolean
}) {
  const trace = parseTrace(value)
  if (!trace) return null

  return (
    <LatencyChart
      trace={trace}
      totalMS={totalMS}
      ttftMS={ttftMS}
      stream={stream}
    />
  )
}

function LatencyChart({
  trace,
  totalMS,
  ttftMS,
  stream,
}: {
  trace: LatencyTrace
  totalMS: number
  ttftMS?: number
  stream: boolean
}) {
  const total = Math.max(trace.total_ms, totalMS, 0.001)
  const critical = collapseCriticalPath(
    trace.segments.filter((segment) => segment.track === "critical")
  )
  const cpaLane = trace.segments
    .filter((segment) => segment.track === "cpa" || segment.track === "attempt")
    .sort(byStart)
  const network = trace.segments
    .filter((segment) => segment.track === "network")
    .sort(byStart)
  const attempts = cpaLane.filter(
    (segment) =>
      segment.track === "attempt" && segment.id.startsWith("cpa_attempt_")
  )
  const defaultSegment = critical.reduce<DisplaySegment | undefined>(
    (largest, segment) =>
      !largest || segment.duration_ms > largest.duration_ms ? segment : largest,
    undefined
  )
  const [selectedID, setSelectedID] = useState("")
  const selectable = [...critical, ...cpaLane, ...network]
  const selected =
    selectable.find((segment) => segment.id === selectedID) ??
    defaultSegment ??
    cpaLane[0] ??
    network[0]
  const visibleNetwork = networkForSelection(network, selected)
  const totals = ownerTotals(critical)
  const dominantOwner = (Object.keys(totals) as LatencyOwner[]).reduce(
    (current, candidate) =>
      totals[candidate] > totals[current] ? candidate : current,
    "relay"
  )
  const marks = compactMarks(trace.marks ?? [], total)

  return (
    <TooltipProvider>
      <section className="overflow-hidden rounded-lg border bg-card">
        <header className="flex flex-col gap-4 border-b p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-md bg-muted">
              <ActivityIcon className="size-4" />
            </span>
            <div>
              <h3 className="text-sm font-semibold">请求耗时</h3>
              <div className="mt-0.5 flex items-center gap-1.5">
                <Badge variant="outline">{stream ? "流式" : "非流式"}</Badge>
                {attempts.length > 1 ? (
                  <Badge variant="destructive">{attempts.length} 次尝试</Badge>
                ) : null}
              </div>
            </div>
          </div>

          <dl className="grid grid-cols-3 divide-x self-stretch rounded-md border sm:min-w-[22rem] sm:self-auto">
            <SummaryMetric
              icon={<ClockIcon />}
              label="总耗时"
              value={formatMS(total)}
            />
            <SummaryMetric
              icon={<GaugeIcon />}
              label="首字节"
              value={ttftMS != null ? formatMS(ttftMS) : "—"}
            />
            <SummaryMetric
              label="主要阶段"
              value={`${ownerMeta[dominantOwner].label} ${formatPercent(totals[dominantOwner] / total)}`}
            />
          </dl>
        </header>

        <div className="p-4 sm:p-5">
          <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 sm:grid-cols-[5rem_minmax(0,1fr)]">
            <div />
            <TimeScale total={total} />

            <LaneLabel>全链路</LaneLabel>
            <TimelineLane
              segments={critical}
              total={total}
              selectedID={selected?.id}
              onSelect={setSelectedID}
              height="h-11"
              showLabels
              ttftMS={ttftMS}
              marks={marks}
            />

            {cpaLane.length ? (
              <>
                <LaneLabel>CPA</LaneLabel>
                <TimelineLane
                  segments={cpaLane}
                  total={total}
                  selectedID={selected?.id}
                  onSelect={setSelectedID}
                  height="h-8"
                  showLabels
                  variant="execution"
                />
              </>
            ) : null}

            {visibleNetwork.length ? (
              <>
                <LaneLabel>网络</LaneLabel>
                <TimelineLane
                  segments={visibleNetwork}
                  total={total}
                  selectedID={selected?.id}
                  onSelect={setSelectedID}
                  height="h-7"
                  variant="network"
                />
              </>
            ) : null}
          </div>

          <OwnerKey segments={critical} totals={totals} />
        </div>

        {selected ? <SelectionPanel segment={selected} total={total} /> : null}
      </section>
    </TooltipProvider>
  )
}

function SummaryMetric({
  icon,
  label,
  value,
}: {
  icon?: ReactNode
  label: string
  value: string
}) {
  return (
    <div className="min-w-0 px-3 py-2.5">
      <dt className="flex items-center gap-1 text-[10px] text-muted-foreground [&_svg]:size-3">
        {icon}
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-xs font-semibold tabular-nums sm:text-sm">
        {value}
      </dd>
    </div>
  )
}

function TimeScale({ total }: { total: number }) {
  return (
    <div className="relative h-5 text-[9px] text-muted-foreground tabular-nums">
      {[0, 25, 50, 75, 100].map((percent) => (
        <span
          key={percent}
          className={cn(
            "absolute top-0",
            percent === 0
              ? "left-0"
              : percent === 100
                ? "right-0"
                : "-translate-x-1/2"
          )}
          style={
            percent > 0 && percent < 100 ? { left: `${percent}%` } : undefined
          }
        >
          {formatMS((total * percent) / 100)}
        </span>
      ))}
    </div>
  )
}

function LaneLabel({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center text-[10px] font-medium text-muted-foreground sm:text-xs">
      {children}
    </div>
  )
}

function TimelineLane({
  segments,
  total,
  selectedID,
  onSelect,
  height,
  showLabels = false,
  variant = "path",
  ttftMS,
  marks = [],
}: {
  segments: DisplaySegment[]
  total: number
  selectedID?: string
  onSelect: (id: string) => void
  height: string
  showLabels?: boolean
  variant?: "path" | "execution" | "network"
  ttftMS?: number
  marks?: LatencyMark[]
}) {
  return (
    <div
      className={cn("relative overflow-hidden rounded-md bg-muted/60", height)}
    >
      {[25, 50, 75].map((percent) => (
        <span
          key={percent}
          className="pointer-events-none absolute inset-y-0 border-l border-dashed border-border/80"
          style={{ left: `${percent}%` }}
        />
      ))}

      {segments.map((segment) => {
        const left = clampPercent((segment.start_ms / total) * 100)
        const width = Math.min(
          100 - left,
          Math.max(0, (segment.duration_ms / total) * 100)
        )
        const selected = selectedID === segment.id
        const failed = segment.status === "failed"
        const label = segmentLabel(segment, variant)
        return (
          <Tooltip key={segment.id}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`${label} ${formatMS(segment.duration_ms)}`}
                  onClick={() => onSelect(segment.id)}
                  className={cn(
                    "absolute inset-y-1 min-w-[3px] overflow-hidden rounded-sm text-left text-[9px] font-medium text-background transition-[opacity,box-shadow] hover:opacity-80 focus-visible:z-20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    segmentBar(segment, variant),
                    failed && "bg-destructive",
                    selected &&
                      "z-10 ring-2 ring-ring ring-offset-2 ring-offset-card",
                    variant === "network" && "inset-y-1.5"
                  )}
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              }
            >
              {showLabels && width >= 8 ? (
                <span className="block truncate px-2">{label}</span>
              ) : null}
            </TooltipTrigger>
            <TooltipContent>
              <span className="font-medium">{label}</span>
              <span className="text-background/70 tabular-nums">
                {formatMS(segment.duration_ms)}
              </span>
            </TooltipContent>
          </Tooltip>
        )
      })}

      {ttftMS != null && ttftMS >= 0 && ttftMS <= total ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className="absolute inset-y-0 z-20 w-px bg-foreground/70"
                style={{ left: `${clampPercent((ttftMS / total) * 100)}%` }}
              />
            }
          >
            <span className="absolute top-0 -left-1 size-2 rotate-45 bg-foreground" />
          </TooltipTrigger>
          <TooltipContent>首字节 · {formatMS(ttftMS)}</TooltipContent>
        </Tooltip>
      ) : null}

      {marks.map((mark) => (
        <Tooltip key={mark.id}>
          <TooltipTrigger
            render={
              <span
                className="absolute bottom-1 z-20 size-1.5 -translate-x-1/2 rounded-full border border-card bg-foreground"
                style={{
                  left: `${clampPercent((mark.offset_ms / total) * 100)}%`,
                }}
              />
            }
          />
          <TooltipContent>
            {mark.label} · +{formatMS(mark.offset_ms)}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}

function OwnerKey({
  segments,
  totals,
}: {
  segments: DisplaySegment[]
  totals: Record<LatencyOwner, number>
}) {
  const owners = [...new Set(segments.map((segment) => segment.owner))]
  return (
    <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 border-t pt-3">
      {owners.map((owner) => (
        <span
          key={owner}
          className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground"
        >
          <span
            className={cn("size-1.5 rounded-[1px]", ownerMeta[owner].bar)}
          />
          <span>{ownerMeta[owner].label}</span>
          <span className="text-foreground tabular-nums">
            {formatMS(totals[owner])}
          </span>
        </span>
      ))}
    </div>
  )
}

function SelectionPanel({
  segment,
  total,
}: {
  segment: DisplaySegment
  total: number
}) {
  const meta = ownerMeta[segment.owner]
  const labels = segment.steps?.map((step) => step.label) ?? []
  return (
    <div className={cn("border-t px-4 py-3 sm:px-5", meta.soft)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span
              className={cn(
                "size-2 shrink-0 rounded-[2px]",
                segment.status === "failed" ? "bg-destructive" : meta.bar
              )}
            />
            <span className="truncate text-sm font-medium">
              {segment.label}
            </span>
            <Badge
              variant={segment.status === "failed" ? "destructive" : "outline"}
            >
              {meta.label}
            </Badge>
            {segment.attempt ? (
              <Badge variant="secondary">尝试 {segment.attempt}</Badge>
            ) : null}
            {segment.reused ? (
              <Badge variant="secondary">连接复用</Badge>
            ) : null}
          </div>
          {segment.provider ||
          segment.model ||
          segment.credential ||
          segment.remote_addr ? (
            <div className="mt-1 truncate text-[11px] text-muted-foreground">
              {[
                segment.provider,
                segment.model,
                segment.credential ? `凭据 ${segment.credential}` : undefined,
                segment.remote_addr,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          ) : labels.length > 1 ? (
            <div className="mt-1 truncate text-[11px] text-muted-foreground">
              {labels.join(" · ")}
            </div>
          ) : null}
        </div>

        <dl className="grid shrink-0 grid-cols-3 divide-x rounded-md border bg-card/70">
          <SelectionMetric
            label="开始"
            value={`+${formatMS(segment.start_ms)}`}
          />
          <SelectionMetric label="耗时" value={formatMS(segment.duration_ms)} />
          <SelectionMetric
            label="占比"
            value={formatPercent(segment.duration_ms / total)}
          />
        </dl>
      </div>
      {segment.error ? (
        <div className="mt-2 truncate text-xs text-destructive">
          {segment.error}
        </div>
      ) : null}
    </div>
  )
}

function SelectionMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2">
      <dt className="text-[9px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-xs font-medium tabular-nums">{value}</dd>
    </div>
  )
}

function collapseCriticalPath(segments: LatencySegment[]): DisplaySegment[] {
  const sorted = [...segments].sort(byStart)
  const groups: DisplaySegment[] = []
  for (const segment of sorted) {
    const previous = groups.at(-1)
    const previousEnd = previous ? previous.start_ms + previous.duration_ms : 0
    if (
      !previous ||
      previous.owner !== segment.owner ||
      segment.start_ms - previousEnd > 0.5
    ) {
      groups.push({
        ...segment,
        id: `path_${groups.length}_${segment.id}`,
        label: ownerMeta[segment.owner].label,
        steps: [segment],
      })
      continue
    }
    const end = Math.max(previousEnd, segment.start_ms + segment.duration_ms)
    previous.duration_ms = end - previous.start_ms
    previous.steps = [...(previous.steps ?? []), segment]
  }
  return groups
}

function networkForSelection(
  network: LatencySegment[],
  selected?: DisplaySegment
) {
  if (!selected) return []
  if (selected.attempt) {
    const sameAttempt = network.filter(
      (segment) => segment.attempt === selected.attempt
    )
    if (sameAttempt.length) return sameAttempt
  }
  if (selected.track === "network") {
    return selected.id.startsWith("cpa_attempt_")
      ? network.filter((segment) => segment.attempt === selected.attempt)
      : network.filter((segment) => !segment.id.startsWith("cpa_attempt_"))
  }
  const start = selected.start_ms
  const end = start + selected.duration_ms
  return network.filter(
    (segment) =>
      segment.start_ms < end && segment.start_ms + segment.duration_ms > start
  )
}

function compactMarks(marks: LatencyMark[], total: number) {
  const visible = marks
    .filter((mark) => mark.offset_ms >= 0 && mark.offset_ms <= total)
    .sort((a, b) => a.offset_ms - b.offset_ms)
  if (visible.length <= 8) return visible
  const first = visible[0]!
  const last = visible.at(-1)!
  const middle = visible
    .slice(1, -1)
    .filter((_, index, values) => index % Math.ceil(values.length / 6) === 0)
  return [first, ...middle, last]
}

function segmentBar(
  segment: LatencySegment,
  variant: "path" | "execution" | "network"
) {
  if (segment.status === "failed") return "bg-destructive"
  if (variant === "execution" && segment.id.startsWith("cpa_retry_wait_"))
    return "border border-dashed border-muted-foreground/70 bg-muted-foreground/30 text-foreground"
  return ownerMeta[segment.owner].bar
}

function segmentLabel(
  segment: LatencySegment,
  variant: "path" | "execution" | "network"
) {
  if (variant === "execution" && segment.track === "attempt")
    return segment.attempt ? `尝试 ${segment.attempt}` : segment.label
  if (variant === "network") return networkLabel(segment.id, segment.label)
  return segment.label
}

function networkLabel(id: string, fallback: string) {
  if (id.endsWith("_connection")) return "连接池"
  if (id.endsWith("_dns")) return "DNS"
  if (id.endsWith("_tcp")) return "TCP"
  if (id.endsWith("_tls")) return "TLS"
  if (id.endsWith("_request_write")) return "发送"
  if (id.endsWith("_wait_first_byte")) return "首包等待"
  return fallback
}

function parseTrace(value?: string): LatencyTrace | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<LatencyTrace>
    if (
      (parsed.version !== 2 && parsed.version !== 3) ||
      !Array.isArray(parsed.segments) ||
      typeof parsed.total_ms !== "number"
    )
      return null
    const segments = parsed.segments.filter(
      (segment): segment is LatencySegment => {
        if (!segment || typeof segment !== "object") return false
        const candidate = segment as Partial<LatencySegment>
        return (
          typeof candidate.id === "string" &&
          typeof candidate.label === "string" &&
          typeof candidate.start_ms === "number" &&
          typeof candidate.duration_ms === "number" &&
          (candidate.track === "critical" ||
            candidate.track === "cpa" ||
            candidate.track === "attempt" ||
            candidate.track === "network") &&
          typeof candidate.owner === "string" &&
          candidate.owner in ownerMeta
        )
      }
    )
    const marks = Array.isArray(parsed.marks)
      ? parsed.marks.filter(
          (mark): mark is LatencyMark =>
            Boolean(mark) &&
            typeof mark.id === "string" &&
            typeof mark.label === "string" &&
            typeof mark.offset_ms === "number"
        )
      : undefined
    return {
      version: parsed.version,
      total_ms: parsed.total_ms,
      boundary: parsed.boundary,
      marks,
      segments,
    }
  } catch {
    return null
  }
}

function ownerTotals(segments: DisplaySegment[]) {
  const result: Record<LatencyOwner, number> = {
    relay: 0,
    queue: 0,
    cpa: 0,
    upstream: 0,
    downstream: 0,
    billing: 0,
  }
  for (const segment of segments)
    result[segment.owner] += Math.max(0, segment.duration_ms)
  return result
}

function byStart(a: LatencySegment, b: LatencySegment) {
  return a.start_ms - b.start_ms
}

function clampPercent(value: number) {
  return Math.min(100, Math.max(0, value))
}

function formatMS(value: number) {
  if (!Number.isFinite(value)) return "—"
  if (value >= 1000)
    return `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)} s`
  if (value >= 10) return `${value.toFixed(0)} ms`
  if (value >= 1) return `${value.toFixed(1)} ms`
  return `${Math.max(0, value).toFixed(3)} ms`
}

function formatPercent(value: number) {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`
}

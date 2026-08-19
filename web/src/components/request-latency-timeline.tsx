import { useState, type ReactNode } from "react"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

type LatencyBucket = "user" | "relay" | "upstream" | "mixed" | "context"

type LatencyOwner =
  | "relay"
  | "queue"
  | "runtime"
  | "upstream"
  | "downstream"
  | "billing"

type LatencyTrack =
  | "critical"
  | "runtime"
  | "attempt"
  | "network"
  | "user"
  | "upstream"

type LatencySegment = {
  id: string
  label: string
  owner: LatencyOwner
  track: LatencyTrack
  bucket: LatencyBucket
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

type LatencyTransfer = {
  upstream_read_wait_ms: number
  client_write_wait_ms: number
  bytes_read: number
  bytes_written: number
  read_count: number
  write_count: number
  first_read_ms?: number
  last_read_ms?: number
  first_write_ms?: number
  last_write_ms?: number
  wall_ms?: number
  local_copy_ms?: number
}

type LatencyAttribution = {
  user_network_ms: number
  relay_ms: number
  upstream_ms: number
  unattributed_ms: number
  observed_sum_ms: number
  overlap_ms: number
  transfer?: LatencyTransfer
  notes?: string[]
}

type LatencyTrace = {
  version: number
  total_ms: number
  boundary?: string
  attribution: LatencyAttribution
  segments: LatencySegment[]
  marks?: LatencyMark[]
}

const bucketMeta: Record<
  LatencyBucket,
  { label: string; bar: string; text: string }
> = {
  user: { label: "用户网络", bar: "bg-chart-2", text: "text-chart-2" },
  relay: { label: "中转", bar: "bg-foreground", text: "text-foreground" },
  upstream: { label: "上游", bar: "bg-chart-4", text: "text-chart-4" },
  mixed: {
    label: "未拆分",
    bar: "bg-muted-foreground/50",
    text: "text-muted-foreground",
  },
  context: {
    label: "参考",
    bar: "bg-muted-foreground/30",
    text: "text-muted-foreground",
  },
}

const laneOrder: LatencyBucket[] = ["user", "relay", "upstream", "mixed"]

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
  const attribution = trace.attribution
  const lanes = laneOrder
    .map((bucket) => ({
      bucket,
      segments: trace.segments
        .filter((segment) => segment.bucket === bucket)
        .sort(byStart),
    }))
    .filter(
      (lane) => lane.bucket !== "mixed" || lane.segments.length > 0
    )
  const [selectedID, setSelectedID] = useState("")
  const selectable = lanes.flatMap((lane) => lane.segments)
  const selected =
    selectable.find((segment) => segment.id === selectedID) ??
    longestSegment(selectable)
  const marks = compactMarks(trace.marks ?? [], total)
  const attempts = trace.segments.filter(
    (segment) => segment.track === "attempt" && !isRetryWait(segment.id)
  ).length
  const observed = attribution.observed_sum_ms
  const scale = Math.max(observed, total, 0.001)

  return (
    <TooltipProvider>
      <section className="overflow-hidden rounded-md border bg-card">
        <header className="flex flex-col gap-3 border-b px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h3 className="text-sm font-medium">耗时测量</h3>
            <p className="text-xs text-muted-foreground tabular-nums">
              {stream ? "流式" : "非流式"}
              {attempts > 1 ? ` · ${attempts} 次上游尝试` : ""}
              {" · 墙钟 "}
              {formatMS(total)}
              {" · 首字节 "}
              {ttftMS != null ? formatMS(ttftMS) : "—"}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-px overflow-hidden rounded-md border bg-border">
            <BucketStat
              bucket="user"
              value={attribution.user_network_ms}
              total={total}
            />
            <BucketStat
              bucket="relay"
              value={attribution.relay_ms}
              total={total}
            />
            <BucketStat
              bucket="upstream"
              value={attribution.upstream_ms}
              total={total}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <StackedRow
              label="观测累计"
              value={formatMS(observed)}
              scale={scale}
            >
              <StackSlice
                bucket="user"
                value={attribution.user_network_ms}
                scale={scale}
              />
              <StackSlice
                bucket="relay"
                value={attribution.relay_ms}
                scale={scale}
              />
              <StackSlice
                bucket="upstream"
                value={attribution.upstream_ms}
                scale={scale}
              />
            </StackedRow>
            <StackedRow label="墙钟" value={formatMS(total)} scale={scale}>
              <span
                className="h-full bg-foreground/25"
                style={{ width: `${clampPercent((total / scale) * 100)}%` }}
              />
            </StackedRow>
          </div>
          <p className="text-[11px] text-muted-foreground tabular-nums">
            三桶合计 {formatPercent(observed / total)} 墙钟
            {attribution.overlap_ms > 0
              ? ` · 重叠 ${formatMS(attribution.overlap_ms)}`
              : ""}
            {attribution.unattributed_ms > 0
              ? ` · 未覆盖 ${formatMS(attribution.unattributed_ms)}`
              : ""}
          </p>
        </header>

        {attribution.transfer ? (
          <TransferPanel transfer={attribution.transfer} />
        ) : null}

        <div className="px-4 py-4 sm:px-5">
          <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 sm:grid-cols-[5.5rem_minmax(0,1fr)]">
            <div />
            <TimeScale total={total} />
            {lanes.map((lane) => (
              <Lane
                key={lane.bucket}
                bucket={lane.bucket}
                segments={lane.segments}
                total={total}
                selectedID={selected?.id}
                onSelect={setSelectedID}
                ttftMS={ttftMS}
                marks={lane.bucket === "user" ? marks : []}
              />
            ))}
          </div>
        </div>

        {selected ? (
          <SelectionPanel segment={selected} total={total} />
        ) : null}

        <SegmentTable
          segments={trace.segments}
          total={total}
          selectedID={selected?.id}
          onSelect={setSelectedID}
        />

        {trace.boundary ? (
          <p className="border-t px-4 py-3 text-[11px] leading-5 text-muted-foreground sm:px-5">
            {trace.boundary}
          </p>
        ) : null}
      </section>
    </TooltipProvider>
  )
}

function BucketStat({
  bucket,
  value,
  total,
}: {
  bucket: Exclude<LatencyBucket, "mixed" | "context">
  value: number
  total: number
}) {
  const meta = bucketMeta[bucket]
  return (
    <div className="bg-card px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className={cn("size-1.5 rounded-[1px]", meta.bar)} />
        {meta.label}
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium tabular-nums">{formatMS(value)}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {formatPercent(value / total)}
        </span>
      </div>
    </div>
  )
}

function StackedRow({
  label,
  value,
  scale,
  children,
}: {
  label: string
  value: string
  scale: number
  children: ReactNode
}) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_4.5rem] items-center gap-2 sm:grid-cols-[5.5rem_minmax(0,1fr)_5rem]">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <div className="flex h-3 overflow-hidden rounded-[2px] bg-muted">
        {scale > 0 ? children : null}
      </div>
      <span className="text-right text-[11px] tabular-nums text-muted-foreground">
        {value}
      </span>
    </div>
  )
}

function StackSlice({
  bucket,
  value,
  scale,
}: {
  bucket: LatencyBucket
  value: number
  scale: number
}) {
  if (value <= 0) return null
  return (
    <span
      className={cn("h-full", bucketMeta[bucket].bar)}
      style={{ width: `${clampPercent((value / scale) * 100)}%` }}
      title={`${bucketMeta[bucket].label} ${formatMS(value)}`}
    />
  )
}

function TransferPanel({ transfer }: { transfer: LatencyTransfer }) {
  const rows: Array<[string, string]> = [
    ["首字节后墙钟", transfer.wall_ms != null ? formatMS(transfer.wall_ms) : "—"],
    [
      "Read() 阻塞",
      `${formatMS(transfer.upstream_read_wait_ms)} · ${transfer.read_count} 次 · ${formatBytes(transfer.bytes_read)}`,
    ],
    [
      "Write() 阻塞",
      `${formatMS(transfer.client_write_wait_ms)} · ${transfer.write_count} 次 · ${formatBytes(transfer.bytes_written)}`,
    ],
  ]
  if (transfer.local_copy_ms && transfer.local_copy_ms > 0) {
    rows.push(["读/写之外的本地处理", formatMS(transfer.local_copy_ms)])
  }
  return (
    <dl className="grid gap-x-6 gap-y-2 border-b px-4 py-3 text-[12px] sm:grid-cols-2 sm:px-5">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function TimeScale({ total }: { total: number }) {
  return (
    <div className="relative h-5 text-[10px] text-muted-foreground tabular-nums">
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

function Lane({
  bucket,
  segments,
  total,
  selectedID,
  onSelect,
  ttftMS,
  marks,
}: {
  bucket: LatencyBucket
  segments: LatencySegment[]
  total: number
  selectedID?: string
  onSelect: (id: string) => void
  ttftMS?: number
  marks: LatencyMark[]
}) {
  const meta = bucketMeta[bucket]
  return (
    <>
      <div className="flex items-center text-[11px] text-muted-foreground">
        {meta.label}
      </div>
      <div className="relative h-8 overflow-hidden rounded-[2px] bg-muted/70">
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
            Math.max(0.2, (segment.duration_ms / total) * 100)
          )
          const selected = selectedID === segment.id
          return (
            <Tooltip key={segment.id}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`${segment.label} ${formatMS(segment.duration_ms)}`}
                    onClick={() => onSelect(segment.id)}
                    className={cn(
                      "absolute inset-y-1 min-w-[2px] overflow-hidden text-left text-[10px] text-background hover:opacity-80 focus-visible:z-20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      meta.bar,
                      segment.status === "failed" && "bg-destructive",
                      selected &&
                        "z-10 ring-2 ring-ring ring-offset-1 ring-offset-card"
                    )}
                    style={{ left: `${left}%`, width: `${width}%` }}
                  />
                }
              >
                {width >= 10 ? (
                  <span className="block truncate px-1.5">{segment.label}</span>
                ) : null}
              </TooltipTrigger>
              <TooltipContent>
                <span className="font-medium">{segment.label}</span>
                <span className="text-background/70 tabular-nums">
                  {formatMS(segment.duration_ms)}
                </span>
              </TooltipContent>
            </Tooltip>
          )
        })}
        {ttftMS != null && ttftMS >= 0 && ttftMS <= total ? (
          <span
            className="pointer-events-none absolute inset-y-0 z-20 w-px bg-foreground/70"
            style={{ left: `${clampPercent((ttftMS / total) * 100)}%` }}
          />
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
    </>
  )
}

function SelectionPanel({
  segment,
  total,
}: {
  segment: LatencySegment
  total: number
}) {
  const meta = bucketMeta[segment.bucket]
  return (
    <div className="border-t px-4 py-3 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className={cn("size-2 shrink-0 rounded-[1px]", meta.bar)} />
            <span className="text-sm font-medium">{segment.label}</span>
            <span className="text-[11px] text-muted-foreground">{meta.label}</span>
          </div>
          {segment.description ? (
            <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
              {segment.description}
            </p>
          ) : null}
          {segment.provider ||
          segment.model ||
          segment.credential ||
          segment.remote_addr ? (
            <p className="mt-1 truncate text-[11px] text-muted-foreground">
              {[
                segment.provider,
                segment.model,
                segment.credential ? `凭据 ${segment.credential}` : undefined,
                segment.remote_addr,
                segment.reused ? "连接复用" : undefined,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
          {segment.error ? (
            <p className="mt-1 text-xs text-destructive">{segment.error}</p>
          ) : null}
        </div>
        <dl className="grid shrink-0 grid-cols-3 divide-x rounded-md border">
          <SelectionMetric label="开始" value={`+${formatMS(segment.start_ms)}`} />
          <SelectionMetric label="耗时" value={formatMS(segment.duration_ms)} />
          <SelectionMetric
            label="占墙钟"
            value={formatPercent(segment.duration_ms / total)}
          />
        </dl>
      </div>
    </div>
  )
}

function SelectionMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2">
      <dt className="text-[10px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-xs tabular-nums">{value}</dd>
    </div>
  )
}

function SegmentTable({
  segments,
  total,
  selectedID,
  onSelect,
}: {
  segments: LatencySegment[]
  total: number
  selectedID?: string
  onSelect: (id: string) => void
}) {
  const rows = [...segments].sort(byStart)
  if (!rows.length) return null
  return (
    <div className="border-t">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>轨道</TableHead>
            <TableHead>阶段</TableHead>
            <TableHead className="text-right">开始</TableHead>
            <TableHead className="text-right">耗时</TableHead>
            <TableHead className="text-right">占墙钟</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((segment) => (
            <TableRow
              key={segment.id}
              className={cn(
                "cursor-pointer",
                selectedID === segment.id && "bg-muted/70"
              )}
              onClick={() => onSelect(segment.id)}
            >
              <TableCell className="text-muted-foreground">
                {bucketMeta[segment.bucket].label}
              </TableCell>
              <TableCell>
                <div>{segment.label}</div>
                {segment.description ? (
                  <div className="mt-0.5 max-w-[36rem] text-[11px] leading-4 text-muted-foreground">
                    {segment.description}
                  </div>
                ) : null}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                +{formatMS(segment.start_ms)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatMS(segment.duration_ms)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatPercent(segment.duration_ms / total)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function parseTrace(value?: string): LatencyTrace | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<LatencyTrace> & {
      attribution?: Partial<LatencyAttribution>
    }
    if (
      (parsed.version !== 2 && parsed.version !== 3 && parsed.version !== 4) ||
      !Array.isArray(parsed.segments) ||
      typeof parsed.total_ms !== "number"
    )
      return null
    const segments = parsed.segments.flatMap((segment): LatencySegment[] => {
      if (!segment || typeof segment !== "object") return []
      const candidate = segment as Partial<LatencySegment> & {
        track?: string
        owner?: string
        bucket?: string
      }
      const track = normalizeTrack(candidate.track)
      const owner = normalizeOwner(candidate.owner)
      if (
        typeof candidate.id !== "string" ||
        typeof candidate.label !== "string" ||
        typeof candidate.start_ms !== "number" ||
        typeof candidate.duration_ms !== "number" ||
        !track ||
        !owner
      )
        return []
      const bucket = normalizeBucket(candidate.bucket) ?? bucketForSegment({
        id: candidate.id,
        owner,
        track,
      })
      return [
        {
          ...(segment as LatencySegment),
          id: candidate.id,
          label: candidate.label,
          track,
          owner,
          bucket,
        },
      ]
    })
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
      attribution: normalizeAttribution(parsed.attribution, segments, parsed.total_ms),
    }
  } catch {
    return null
  }
}

function normalizeAttribution(
  value: Partial<LatencyAttribution> | undefined,
  segments: LatencySegment[],
  total: number
): LatencyAttribution {
  if (
    value &&
    typeof value.user_network_ms === "number" &&
    typeof value.relay_ms === "number" &&
    typeof value.upstream_ms === "number"
  ) {
    const observed =
      typeof value.observed_sum_ms === "number"
        ? value.observed_sum_ms
        : value.user_network_ms + value.relay_ms + value.upstream_ms
    return {
      user_network_ms: value.user_network_ms,
      relay_ms: value.relay_ms,
      upstream_ms: value.upstream_ms,
      unattributed_ms: value.unattributed_ms ?? Math.max(0, total - observed),
      observed_sum_ms: observed,
      overlap_ms: value.overlap_ms ?? Math.max(0, observed - total),
      transfer: value.transfer,
      notes: value.notes,
    }
  }
  let user = 0
  let relay = 0
  let upstream = 0
  let mixed = 0
  for (const segment of segments) {
    switch (segment.bucket) {
      case "user":
        user += Math.max(0, segment.duration_ms)
        break
      case "relay":
        relay += Math.max(0, segment.duration_ms)
        break
      case "upstream":
        upstream += Math.max(0, segment.duration_ms)
        break
      case "mixed":
        mixed += Math.max(0, segment.duration_ms)
        break
    }
  }
  const observed = user + relay + upstream
  return {
    user_network_ms: user,
    relay_ms: relay,
    upstream_ms: upstream,
    unattributed_ms: Math.max(mixed, Math.max(0, total - observed)),
    observed_sum_ms: observed,
    overlap_ms: Math.max(0, observed - total),
  }
}

function bucketForSegment(segment: {
  id: string
  owner: LatencyOwner
  track: LatencyTrack
}): LatencyBucket {
  switch (segment.id) {
    case "read_request_body":
    case "client_write_wait":
      return "user"
    case "upstream_read_wait":
      return "upstream"
    case "response_transfer":
    case "runtime_response_headers":
    case "runtime_first_body":
    case "websocket_session":
    case "websocket_turn":
      return "mixed"
  }
  if (segment.id.includes("wait_first_byte") || segment.track === "network")
    return "upstream"
  if (segment.id.includes("retry_wait")) return "relay"
  if (segment.track === "attempt") return "context"
  if (
    segment.owner === "relay" ||
    segment.owner === "queue" ||
    segment.owner === "billing" ||
    segment.owner === "runtime"
  )
    return "relay"
  if (segment.owner === "upstream") return "upstream"
  if (segment.owner === "downstream") return "mixed"
  return "context"
}

function normalizeTrack(track?: string): LatencyTrack | undefined {
  if (track === "cpa") return "runtime"
  if (
    track === "critical" ||
    track === "runtime" ||
    track === "attempt" ||
    track === "network" ||
    track === "user" ||
    track === "upstream"
  )
    return track
  return undefined
}

function normalizeOwner(owner?: string): LatencyOwner | undefined {
  if (owner === "cpa") return "runtime"
  if (
    owner === "relay" ||
    owner === "queue" ||
    owner === "runtime" ||
    owner === "upstream" ||
    owner === "downstream" ||
    owner === "billing"
  )
    return owner
  return undefined
}

function normalizeBucket(bucket?: string): LatencyBucket | undefined {
  if (
    bucket === "user" ||
    bucket === "relay" ||
    bucket === "upstream" ||
    bucket === "mixed" ||
    bucket === "context"
  )
    return bucket
  return undefined
}

function longestSegment(segments: LatencySegment[]) {
  return segments.reduce<LatencySegment | undefined>(
    (largest, segment) =>
      !largest || segment.duration_ms > largest.duration_ms ? segment : largest,
    undefined
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

function isRetryWait(id: string) {
  return id.includes("_retry_wait_")
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
  if (!Number.isFinite(value)) return "—"
  return `${(Math.max(0, value) * 100).toFixed(value >= 0.1 ? 1 : 2)}%`
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return "—"
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`
}

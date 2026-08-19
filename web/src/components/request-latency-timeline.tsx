import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, XAxis, YAxis } from "recharts"

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { bytes } from "@/lib/format"
import { StatStrip } from "@/components/workspace-ui"

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

const chartConfig = {
  user: { label: "用户网络", color: "var(--chart-2)" },
  relay: { label: "中转", color: "var(--chart-3)" },
  upstream: { label: "上游", color: "var(--chart-4)" },
  mixed: { label: "未拆分", color: "var(--muted-foreground)" },
  wall: { label: "墙钟", color: "var(--foreground)" },
  duration: { label: "耗时", color: "var(--chart-3)" },
} satisfies ChartConfig

const bucketLabel: Record<LatencyBucket, string> = {
  user: "用户网络",
  relay: "中转",
  upstream: "上游",
  mixed: "未拆分",
  context: "参考",
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

  const total = Math.max(trace.total_ms, totalMS, 0.001)
  const attribution = trace.attribution
  const attempts = trace.segments.filter(
    (segment) => segment.track === "attempt" && !segment.id.includes("_retry_wait_")
  ).length
  const comparison = [
    {
      name: "观测累计",
      user: attribution.user_network_ms,
      relay: attribution.relay_ms,
      upstream: attribution.upstream_ms,
      mixed: 0,
      wall: 0,
    },
    {
      name: "墙钟",
      user: 0,
      relay: 0,
      upstream: 0,
      mixed: 0,
      wall: total,
    },
  ]
  const gantt = trace.segments
    .filter((segment) => segment.bucket !== "context")
    .sort((a, b) => a.start_ms - b.start_ms)
    .map((segment) => ({
      name: segment.label,
      offset: segment.start_ms,
      duration: segment.duration_ms,
      bucket: segment.bucket,
      fill: `var(--color-${segment.bucket})`,
    }))
  const transfer = attribution.transfer

  return (
    <Card>
      <CardHeader>
        <CardTitle>耗时测量</CardTitle>
        <CardDescription>
          {stream ? "流式" : "非流式"}
          {attempts > 1 ? ` · ${attempts} 次上游尝试` : ""}
          {` · 墙钟 ${formatMS(total)}`}
          {` · 首字节 ${ttftMS != null ? formatMS(ttftMS) : "—"}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <StatStrip
          className="sm:grid-cols-3"
          items={[
            {
              label: "用户网络",
              value: formatMS(attribution.user_network_ms),
              detail: formatPercent(attribution.user_network_ms / total),
            },
            {
              label: "中转",
              value: formatMS(attribution.relay_ms),
              detail: formatPercent(attribution.relay_ms / total),
            },
            {
              label: "上游",
              value: formatMS(attribution.upstream_ms),
              detail: formatPercent(attribution.upstream_ms / total),
            },
          ]}
        />

        <ChartContainer config={chartConfig} className="aspect-auto h-44 w-full">
          <BarChart data={comparison} layout="vertical" accessibilityLayer>
            <CartesianGrid horizontal={false} />
            <XAxis
              type="number"
              tickLine={false}
              axisLine={false}
              tickFormatter={formatMS}
            />
            <YAxis
              type="category"
              dataKey="name"
              tickLine={false}
              axisLine={false}
              width={64}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) => formatMS(Number(value))}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            <Bar dataKey="user" stackId="compare" fill="var(--color-user)" />
            <Bar dataKey="relay" stackId="compare" fill="var(--color-relay)" />
            <Bar
              dataKey="upstream"
              stackId="compare"
              fill="var(--color-upstream)"
            />
            <Bar dataKey="wall" stackId="compare" fill="var(--color-wall)" />
          </BarChart>
        </ChartContainer>

        <p className="text-xs text-muted-foreground tabular-nums">
          三桶合计 {formatPercent(attribution.observed_sum_ms / total)} 墙钟
          {attribution.overlap_ms > 0
            ? ` · 重叠 ${formatMS(attribution.overlap_ms)}`
            : ""}
          {attribution.unattributed_ms > 0
            ? ` · 未覆盖 ${formatMS(attribution.unattributed_ms)}`
            : ""}
        </p>

        {transfer ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>首字节后</TableHead>
                <TableHead className="text-right">测量</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>墙钟</TableCell>
                <TableCell className="text-right tabular-nums">
                  {transfer.wall_ms != null ? formatMS(transfer.wall_ms) : "—"}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Read() 阻塞</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMS(transfer.upstream_read_wait_ms)} · {transfer.read_count}{" "}
                  次 · {bytes(transfer.bytes_read)}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Write() 阻塞</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMS(transfer.client_write_wait_ms)} · {transfer.write_count}{" "}
                  次 · {bytes(transfer.bytes_written)}
                </TableCell>
              </TableRow>
              {transfer.local_copy_ms && transfer.local_copy_ms > 0 ? (
                <TableRow>
                  <TableCell>读/写之外的本地处理</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMS(transfer.local_copy_ms)}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        ) : null}

        {gantt.length ? (
          <ChartContainer
            config={chartConfig}
            className="aspect-auto w-full"
            style={{ height: Math.max(220, gantt.length * 36) }}
          >
            <BarChart data={gantt} layout="vertical" accessibilityLayer>
              <CartesianGrid horizontal={false} />
              <XAxis
                type="number"
                domain={[0, total]}
                tickLine={false}
                axisLine={false}
                tickFormatter={formatMS}
              />
              <YAxis
                type="category"
                dataKey="name"
                tickLine={false}
                axisLine={false}
                width={112}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value, name) =>
                      name === "offset" ? null : formatMS(Number(value))
                    }
                  />
                }
              />
              <Bar dataKey="offset" stackId="gantt" fill="transparent" />
              <Bar dataKey="duration" stackId="gantt">
                {gantt.map((row) => (
                  <Cell key={row.name} fill={row.fill} />
                ))}
              </Bar>
              {ttftMS != null && ttftMS >= 0 && ttftMS <= total ? (
                <ReferenceLine
                  x={ttftMS}
                  stroke="var(--foreground)"
                  strokeDasharray="3 3"
                />
              ) : null}
            </BarChart>
          </ChartContainer>
        ) : null}

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
            {[...trace.segments]
              .sort((a, b) => a.start_ms - b.start_ms)
              .map((segment) => (
                <TableRow key={segment.id}>
                  <TableCell className="text-muted-foreground">
                    {bucketLabel[segment.bucket]}
                  </TableCell>
                  <TableCell>
                    <div>{segment.label}</div>
                    {segment.description ? (
                      <div className="mt-0.5 max-w-[36rem] text-xs text-muted-foreground">
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
      </CardContent>
      {trace.boundary ? (
        <CardFooter>
          <p className="text-xs leading-5 text-muted-foreground">
            {trace.boundary}
          </p>
        </CardFooter>
      ) : null}
    </Card>
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
      const bucket =
        normalizeBucket(candidate.bucket) ??
        bucketForSegment({
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
      attribution: normalizeAttribution(
        parsed.attribution,
        segments,
        parsed.total_ms
      ),
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

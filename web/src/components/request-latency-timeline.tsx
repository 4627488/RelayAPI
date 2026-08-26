import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts"

import { EmptyState } from "@astryxdesign/core/EmptyState"
import { Table, pixel, proportional } from "@astryxdesign/core/Table"
import { Text } from "@astryxdesign/core/Text"
import { VStack } from "@astryxdesign/core/Layout"

import { ChartFrame, MetricStrip, PageSection, useChartColors } from "@/components/page-kit"
import { bytes } from "@/lib/format"

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

const bucketLabel: Record<LatencyBucket, string> = {
  user: "用户网络",
  relay: "中转",
  upstream: "上游",
  mixed: "未拆分",
  context: "参考",
}

interface TransferRow extends Record<string, unknown> {
  id: string
  label: string
  value: string
}

interface SegmentRow extends Record<string, unknown> {
  id: string
  bucket: string
  label: string
  description?: string
  start: string
  duration: string
  share: string
}

export function RequestLatencyTimeline({
  value,
  totalMS,
  ttftMS,
}: {
  value?: string
  totalMS: number
  ttftMS?: number
  stream: boolean
}) {
  const colors = useChartColors()
  const trace = parseTrace(value)
  if (!trace) return null

  const total = Math.max(trace.total_ms, totalMS, 0.001)
  const attribution = trace.attribution
  const comparison = [
    {
      name: "观测累计",
      user: attribution.user_network_ms,
      relay: attribution.relay_ms,
      upstream: attribution.upstream_ms,
      wall: 0,
    },
    {
      name: "墙钟",
      user: 0,
      relay: 0,
      upstream: 0,
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
      fill: bucketColor(segment.bucket, colors),
    }))
  const transfer = attribution.transfer
  const transferRows: TransferRow[] = transfer
    ? [
        {
          id: "wall",
          label: "墙钟",
          value: transfer.wall_ms != null ? formatMS(transfer.wall_ms) : "—",
        },
        {
          id: "read",
          label: "Read() 阻塞",
          value: `${formatMS(transfer.upstream_read_wait_ms)} · ${transfer.read_count} 次 · ${bytes(transfer.bytes_read)}`,
        },
        {
          id: "write",
          label: "Write() 阻塞",
          value: `${formatMS(transfer.client_write_wait_ms)} · ${transfer.write_count} 次 · ${bytes(transfer.bytes_written)}`,
        },
        ...(transfer.local_copy_ms && transfer.local_copy_ms > 0
          ? [
              {
                id: "local",
                label: "读/写之外的本地处理",
                value: formatMS(transfer.local_copy_ms),
              },
            ]
          : []),
      ]
    : []
  const segmentRows: SegmentRow[] = [...trace.segments]
    .sort((a, b) => a.start_ms - b.start_ms)
    .map((segment) => ({
      id: segment.id,
      bucket: bucketLabel[segment.bucket],
      label: segment.label,
      description: segment.description,
      start: `+${formatMS(segment.start_ms)}`,
      duration: formatMS(segment.duration_ms),
      share: formatPercent(segment.duration_ms / total),
    }))

  return (
    <PageSection title="耗时">
      <VStack gap={4}>
        <MetricStrip
          items={[
            {
              label: "用户网络",
              value: formatMS(attribution.user_network_ms),
              hint: formatPercent(attribution.user_network_ms / total),
            },
            {
              label: "中转",
              value: formatMS(attribution.relay_ms),
              hint: formatPercent(attribution.relay_ms / total),
            },
            {
              label: "上游",
              value: formatMS(attribution.upstream_ms),
              hint: formatPercent(attribution.upstream_ms / total),
            },
          ]}
        />

        <ChartFrame>
          <BarChart data={comparison} layout="vertical">
            <CartesianGrid horizontal={false} stroke={colors.border} />
            <XAxis
              type="number"
              tickLine={false}
              axisLine={false}
              tick={{ fill: colors.text }}
              tickFormatter={formatMS}
            />
            <YAxis
              type="category"
              dataKey="name"
              tickLine={false}
              axisLine={false}
              width={64}
              tick={{ fill: colors.text }}
            />
            <Tooltip
              contentStyle={{
                background: colors.surface,
                border: `1px solid ${colors.border}`,
              }}
              formatter={(value) => formatMS(Number(value))}
            />
            <Bar dataKey="user" name="用户网络" stackId="compare" fill={colors.blue} />
            <Bar dataKey="relay" name="中转" stackId="compare" fill={colors.accent} />
            <Bar dataKey="upstream" name="上游" stackId="compare" fill={colors.success} />
            <Bar dataKey="wall" name="墙钟" stackId="compare" fill={colors.muted} />
          </BarChart>
        </ChartFrame>

        <Text color="secondary" type="supporting">
          三桶合计 {formatPercent(attribution.observed_sum_ms / total)} 墙钟
          {attribution.overlap_ms > 0 ? ` · 重叠 ${formatMS(attribution.overlap_ms)}` : ""}
          {attribution.unattributed_ms > 0
            ? ` · 未覆盖 ${formatMS(attribution.unattributed_ms)}`
            : ""}
        </Text>

        {transferRows.length ? (
          <Table
            data={transferRows}
            idKey="id"
            density="compact"
            columns={[
              { key: "label", header: "首字节后", width: proportional(1) },
              { key: "value", header: "测量", width: proportional(1), align: "end" },
            ]}
          />
        ) : null}

        {gantt.length ? (
          <ChartFrame>
            <BarChart data={gantt} layout="vertical">
              <CartesianGrid horizontal={false} stroke={colors.border} />
              <XAxis
                type="number"
                domain={[0, total]}
                tickLine={false}
                axisLine={false}
                tick={{ fill: colors.text }}
                tickFormatter={formatMS}
              />
              <YAxis
                type="category"
                dataKey="name"
                tickLine={false}
                axisLine={false}
                width={112}
                tick={{ fill: colors.text }}
              />
              <Tooltip
                contentStyle={{
                  background: colors.surface,
                  border: `1px solid ${colors.border}`,
                }}
                formatter={(value, name) =>
                  name === "offset" ? "" : formatMS(Number(value))
                }
              />
              <Bar dataKey="offset" stackId="gantt" fill="transparent" />
              <Bar dataKey="duration" name="耗时" stackId="gantt">
                {gantt.map((row) => (
                  <Cell key={row.name} fill={row.fill} />
                ))}
              </Bar>
              {ttftMS != null && ttftMS >= 0 && ttftMS <= total ? (
                <ReferenceLine
                  x={ttftMS}
                  stroke={colors.text}
                  strokeDasharray="3 3"
                />
              ) : null}
            </BarChart>
          </ChartFrame>
        ) : (
          <EmptyState isCompact title="没有可展示的阶段" />
        )}

        <Table
          data={segmentRows}
          idKey="id"
          density="compact"
          columns={[
            { key: "bucket", header: "轨道", width: pixel(90) },
            {
              key: "label",
              header: "阶段",
              width: proportional(1),
              renderCell: (row) => (
                <VStack gap={0}>
                  <Text>{row.label}</Text>
                  {row.description ? (
                    <Text color="secondary" type="supporting">
                      {row.description}
                    </Text>
                  ) : null}
                </VStack>
              ),
            },
            { key: "start", header: "开始", width: pixel(90), align: "end" },
            { key: "duration", header: "耗时", width: pixel(90), align: "end" },
            { key: "share", header: "占墙钟", width: pixel(90), align: "end" },
          ]}
        />

        {trace.boundary ? (
          <Text color="secondary" type="supporting">
            {trace.boundary}
          </Text>
        ) : null}
      </VStack>
    </PageSection>
  )
}

function bucketColor(
  bucket: LatencyBucket,
  colors: ReturnType<typeof useChartColors>
) {
  if (bucket === "user") return colors.blue
  if (bucket === "relay") return colors.accent
  if (bucket === "upstream") return colors.success
  return colors.muted
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

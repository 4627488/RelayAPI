import {
  Tooltip,
  TooltipContent,
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
}

type LatencyAttribution = {
  user_network_ms: number
  relay_ms: number
  upstream_ms: number
  unattributed_ms: number
  observed_sum_ms: number
  overlap_ms: number
}

type LatencyTrace = {
  version: number
  total_ms: number
  attribution: LatencyAttribution
  segments: LatencySegment[]
}

const slices = [
  { key: "user", label: "用户网络", className: "bg-chart-2" },
  { key: "relay", label: "中转", className: "bg-chart-3" },
  { key: "upstream", label: "上游", className: "bg-chart-4" },
] as const

export function RequestLatencyTimeline({
  value,
  totalMS,
}: {
  value?: string
  totalMS: number
}) {
  const trace = parseTrace(value)
  if (!trace) return null

  const total = Math.max(trace.total_ms, totalMS, 0.001)
  const observed =
    trace.attribution.user_network_ms +
    trace.attribution.relay_ms +
    trace.attribution.upstream_ms
  const scale = observed > total ? total / observed : 1
  const parts = slices
    .map((slice) => ({
      ...slice,
      ms:
        slice.key === "user"
          ? trace.attribution.user_network_ms
          : slice.key === "relay"
            ? trace.attribution.relay_ms
            : trace.attribution.upstream_ms,
    }))
    .filter((part) => part.ms > 0)
    .map((part) => ({ ...part, width: (part.ms * scale) / total }))

  if (!parts.length) return null

  return (
    <div className="max-w-56">
      <div
        className="flex h-1.5 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={parts
          .map((part) => `${part.label} ${formatMS(part.ms)}`)
          .concat(`合计 ${formatMS(total)}`)
          .join("，")}
      >
        {parts.map((part) => (
          <Tooltip key={part.key}>
            <TooltipTrigger
              render={
                <span
                  className={cn("h-full min-w-px", part.className)}
                  style={{ width: `${part.width * 100}%` }}
                />
              }
            />
            <TooltipContent>
              {part.label} {formatMS(part.ms)}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
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
      const bucket =
        normalizeBucket(candidate.bucket) ??
        bucketForSegment({
          id: candidate.id,
          owner,
          track,
        })
      return [
        {
          id: candidate.id,
          label: candidate.label,
          track,
          owner,
          bucket,
          start_ms: candidate.start_ms,
          duration_ms: candidate.duration_ms,
        },
      ]
    })
    return {
      version: parsed.version,
      total_ms: parsed.total_ms,
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

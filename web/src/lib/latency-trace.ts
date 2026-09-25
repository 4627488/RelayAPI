export type LatencySegment = {
  id: string
  label: string
  start_ms: number
  duration_ms: number
  description?: string
  status?: string
  provider?: string
  model?: string
  credential?: string
  error?: string
  remote_addr?: string
  attempt?: number
  reused?: boolean
}

export type LatencyTrace = {
  version: 5
  total_ms: number
  boundary?: string
  segments: LatencySegment[]
  marks: { id: string; label: string; offset_ms: number }[]
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const measured = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0

export function parseLatencyTrace(value?: string): LatencyTrace | null {
  try {
    const trace: unknown = JSON.parse(value || "{}")
    if (
      !record(trace) ||
      trace.version !== 5 ||
      !measured(trace.total_ms) ||
      !Array.isArray(trace.segments)
    )
      return null
    const segments = trace.segments.flatMap((s): LatencySegment[] => {
      if (
        !record(s) ||
        typeof s.label !== "string" ||
        !measured(s.start_ms) ||
        !measured(s.duration_ms)
      )
        return []
      const segment: LatencySegment = {
        id: typeof s.id === "string" ? s.id : s.label,
        label: s.label,
        start_ms: s.start_ms,
        duration_ms: s.duration_ms,
      }
      for (const key of [
        "description",
        "status",
        "provider",
        "model",
        "credential",
        "error",
        "remote_addr",
      ] as const) {
        if (typeof s[key] === "string") segment[key] = s[key]
      }
      if (measured(s.attempt)) segment.attempt = s.attempt
      if (typeof s.reused === "boolean") segment.reused = s.reused
      return [segment]
    })
    const marks = Array.isArray(trace.marks)
      ? trace.marks.flatMap((m) =>
          record(m) && typeof m.label === "string" && measured(m.offset_ms)
            ? [
                {
                  id: typeof m.id === "string" ? m.id : m.label,
                  label: m.label,
                  offset_ms: m.offset_ms,
                },
              ]
            : []
        )
      : []
    return {
      version: 5,
      total_ms: trace.total_ms,
      boundary: typeof trace.boundary === "string" ? trace.boundary : undefined,
      segments,
      marks,
    }
  } catch {
    return null
  }
}

export const measuredMS = (value: number | undefined) =>
  value != null && Number.isFinite(value) && value >= 0
    ? `${value.toLocaleString(undefined, { maximumFractionDigits: 3 })} ms`
    : "未记录"

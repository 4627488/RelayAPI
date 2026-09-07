import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

type Segment = {
  id: string
  label: string
  start_ms: number
  duration_ms: number
  description?: string
  status?: string
}
type Trace = {
  version: number
  total_ms: number
  boundary?: string
  segments: Segment[]
  marks?: { id: string; label: string; offset_ms: number }[]
}

function parseTrace(value?: string): Trace | null {
  try {
    const trace = JSON.parse(value || "{}")
    if (
      trace.version !== 5 ||
      !Array.isArray(trace.segments) ||
      !Number.isFinite(trace.total_ms)
    )
      return null
    return {
      ...trace,
      segments: trace.segments.filter(
        (s: Segment) =>
          typeof s.label === "string" &&
          Number.isFinite(s.start_ms) &&
          s.start_ms >= 0 &&
          Number.isFinite(s.duration_ms) &&
          s.duration_ms >= 0
      ),
    }
  } catch {
    return null
  }
}

const ms = (value: number) =>
  `${value.toLocaleString(undefined, { maximumFractionDigits: 3 })} ms`

export function RequestLatencyTimeline({
  value,
  totalMS,
}: {
  value?: string
  totalMS: number
  ttftMS?: number
  stream: boolean
}) {
  const trace = parseTrace(value)
  return (
    <Card>
      <CardHeader>
        <CardTitle>计费块耗时 · {ms(trace?.total_ms ?? totalMS)}</CardTitle>
        <CardDescription>
          {trace?.boundary ??
            "历史记录未采集新的计费块观测点，仅保留原始总耗时。"}
        </CardDescription>
      </CardHeader>
      {trace && (
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>观测点</TableHead>
                <TableHead className="text-right">开始偏移</TableHead>
                <TableHead className="text-right">耗时</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trace.segments.map((segment, index) => (
                <TableRow key={`${segment.id}-${index}`}>
                  <TableCell className="whitespace-normal">
                    <div>
                      {segment.label}
                      {segment.status ? ` · ${segment.status}` : ""}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {segment.description}
                    </p>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {ms(segment.start_ms)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {ms(segment.duration_ms)}
                  </TableCell>
                </TableRow>
              ))}
              {trace.marks
                ?.filter((mark) => Number.isFinite(mark.offset_ms))
                .map((mark, index) => (
                  <TableRow key={`mark-${index}`}>
                    <TableCell>{mark.label}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {ms(mark.offset_ms)}
                    </TableCell>
                    <TableCell className="text-right">—</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </CardContent>
      )}
    </Card>
  )
}

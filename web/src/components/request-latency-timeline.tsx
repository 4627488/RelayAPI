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

import {
  parseLatencyTrace,
  measuredMS as ms,
  type LatencyTrace,
} from "@/lib/latency-trace"

export function LatencyObservations({ trace }: { trace: LatencyTrace }) {
  return (
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
            <TableCell className="max-w-72 break-words whitespace-normal">
              <div>
                {segment.label}
                {segment.status ? ` · ${segment.status}` : ""}
              </div>
              {segment.description && (
                <p className="text-xs text-muted-foreground">
                  {segment.description}
                </p>
              )}
              <dl className="text-xs text-muted-foreground">
                {(
                  [
                    ["尝试", segment.attempt],
                    ["提供商", segment.provider],
                    ["模型", segment.model],
                    ["凭据", segment.credential],
                    ["远端", segment.remote_addr],
                    [
                      "连接",
                      segment.reused === undefined
                        ? undefined
                        : segment.reused
                          ? "复用"
                          : "新建",
                    ],
                    ["错误", segment.error],
                  ] as const
                )
                  .filter(([, value]) => value !== undefined && value !== "")
                  .map(([label, value]) => (
                    <div key={label} className="flex flex-wrap gap-x-1">
                      <dt>{label}：</dt>
                      <dd className="min-w-0 break-all">{value}</dd>
                    </div>
                  ))}
              </dl>
            </TableCell>
            <TableCell className="text-right align-top tabular-nums">
              {ms(segment.start_ms)}
            </TableCell>
            <TableCell className="text-right align-top tabular-nums">
              {ms(segment.duration_ms)}
            </TableCell>
          </TableRow>
        ))}
        {trace.marks.map((mark, index) => (
          <TableRow key={`mark-${index}`}>
            <TableCell className="whitespace-normal">{mark.label}</TableCell>
            <TableCell className="text-right tabular-nums">
              {ms(mark.offset_ms)}
            </TableCell>
            <TableCell className="text-right">—</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function RequestLatencyTimeline({
  value,
  totalMS,
}: {
  value?: string
  totalMS: number
  ttftMS?: number
  stream: boolean
}) {
  const trace = parseLatencyTrace(value)
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
          <LatencyObservations trace={trace} />
        </CardContent>
      )}
    </Card>
  )
}

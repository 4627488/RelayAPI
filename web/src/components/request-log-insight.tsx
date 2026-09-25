import { useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { LatencyObservations } from "@/components/request-latency-timeline"
import { parseLatencyTrace, measuredMS } from "@/lib/latency-trace"
import type { RequestLog } from "@/lib/api"
import {
  bytes,
  cacheHitRateLabel,
  money,
  requestLogTransport,
} from "@/lib/format"

type Section = "latency" | "usage" | "billing" | "route"
const labels: Record<Section, string> = {
  latency: "耗时",
  usage: "用量",
  billing: "计费",
  route: "链路",
}
const count = (value?: number) =>
  value == null ? "未记录" : value.toLocaleString()
const state = (value?: boolean) =>
  value === undefined ? "未记录" : value ? "是" : "否"

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 text-right break-all tabular-nums">
            {value === undefined || value === null || value === ""
              ? "未记录"
              : value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function RequestLogInsight({
  log,
  section,
  children,
}: {
  log: RequestLog
  section: Section
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const trace = open ? parseLatencyTrace(log.stage_timings) : null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        openOnHover
        delay={250}
        closeDelay={200}
        aria-label={`查看${labels[section]}详情`}
        render={
          <Button variant="link" size="sm" className="h-auto max-w-full p-0" />
        }
      >
        {children}
      </PopoverTrigger>
      <PopoverContent
        className="max-h-[min(70vh,var(--available-height))] w-[34rem] max-w-[calc(100vw-2rem)] overflow-y-auto"
        initialFocus={false}
      >
        <PopoverHeader>
          <PopoverTitle>请求观测详情</PopoverTitle>
          <PopoverDescription className="break-all">
            {log.actual_model || log.model || log.path}
          </PopoverDescription>
        </PopoverHeader>
        <Tabs defaultValue={section}>
          <TabsList aria-label="观测分类" className="w-full">
            {(Object.keys(labels) as Section[]).map((key) => (
              <TabsTrigger key={key} value={key}>
                {labels[key]}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="latency" className="flex flex-col gap-3">
            <Facts
              rows={[
                ["总耗时", measuredMS(log.latency_ms)],
                ["首响应 / 首字节", measuredMS(log.ttft_ms)],
                ["首 Token", measuredMS(log.first_token_ms)],
              ]}
            />
            {trace && (trace.segments.length || trace.marks.length) ? (
              <>
                <p className="text-xs text-muted-foreground">
                  阶段可能嵌套或重叠，不能相加为总耗时；计费处理可能发生在响应结束后。
                </p>
                <LatencyObservations trace={trace} />
                {trace.boundary && (
                  <p className="text-xs text-muted-foreground">
                    {trace.boundary}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                此记录没有可展示的 v5 阶段观测。
              </p>
            )}
          </TabsContent>
          <TabsContent value="usage">
            <Facts
              rows={[
                ["总 Tokens", count(log.total_tokens)],
                ["输入", count(log.prompt_tokens)],
                ["输出", count(log.completion_tokens)],
                ["缓存读取", count(log.cached_tokens)],
                [
                  "缓存命中率",
                  cacheHitRateLabel(log.cached_tokens, log.prompt_tokens),
                ],
                ["缓存写入", count(log.cache_write_tokens)],
                ["推理", count(log.reasoning_tokens)],
                ["图片输入", count(log.image_input_tokens)],
                ["图片缓存读取", count(log.cached_image_input_tokens)],
                ["图片输出", count(log.image_output_tokens)],
                [
                  "请求体",
                  log.request_body_bytes == null
                    ? undefined
                    : bytes(log.request_body_bytes),
                ],
                [
                  "转发体",
                  log.forwarded_body_bytes == null
                    ? undefined
                    : bytes(log.forwarded_body_bytes),
                ],
                [
                  "响应体",
                  log.response_body_bytes == null
                    ? undefined
                    : bytes(log.response_body_bytes),
                ],
              ]}
            />
            <p className="mt-3 text-xs text-muted-foreground">
              缓存、图片、推理可能包含在输入或输出中，不重复累加。
            </p>
          </TabsContent>
          <TabsContent value="billing">
            <Facts
              rows={[
                ["费用", money(log.cost_nano_usd)],
                ["定价完成", state(log.pricing_complete)],
                ["已结算", state(log.settled)],
                ["计价模型", log.price_model],
                ["价格来源", log.price_source],
                ["价格版本", log.price_version],
                [
                  "倍率",
                  log.price_multiplier == null
                    ? undefined
                    : `${log.price_multiplier}×`,
                ],
                ...(
                  [
                    ["输入单价", log.input_price_nano_usd_per_token],
                    ["输出单价", log.output_price_nano_usd_per_token],
                    ["缓存读取单价", log.cached_input_price_nano_usd_per_token],
                    ["缓存写入单价", log.cache_write_price_nano_usd_per_token],
                    ["推理单价", log.reasoning_price_nano_usd_per_token],
                  ] as const
                )
                  .filter(([, value]) => value != null)
                  .map(([label, value]): [string, ReactNode] => [
                    label,
                    `${money(value! * 1_000_000)} / 百万 Tokens`,
                  ]),
              ]}
            />
          </TabsContent>
          <TabsContent value="route">
            <Facts
              rows={[
                ["请求模型", log.requested_model || log.model],
                ["实际模型", log.actual_model],
                ["提供商", log.provider],
                [
                  "凭据",
                  log.credential_email || log.credential_name || log.auth_index,
                ],
                [
                  "订阅",
                  [
                    log.parent_subscription_name || log.channel_name,
                    log.child_subscription_name,
                  ]
                    .filter(Boolean)
                    .join(" / "),
                ],
                [
                  "客户端",
                  [log.client_name, log.client_version]
                    .filter(Boolean)
                    .join(" "),
                ],
                ["入口", `${log.method} ${log.path}`],
                ["传输", requestLogTransport(log.request_type, log.stream)],
                ["HTTP 状态", log.status_code],
                ["错误码", log.error_code],
                ["错误详情", log.error_message],
                ["计费块 ID", log.id],
                ["关联会话", log.reservation_request_id],
                ["上游请求 ID", log.upstream_request_id],
                ["上游 Trace", log.upstream_trace_id],
                ["上游 Execution", log.upstream_execution_id],
              ]}
            />
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  )
}

import { useCallback, useEffect, useMemo, useState } from "react"
import { CheckIcon, RotateCcwIcon, SaveIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { StatStrip } from "@/components/workspace-ui"
import { api, type OutboundProxy } from "@/lib/api"

type RoutingStrategy = "round-robin" | "fill-first"
type UnpricedPolicy = "allow" | "deny"
type ImageGenerationMode = "enabled" | "disabled" | "chat" | "passthrough"

type RuntimeSettings = {
  routing_strategy: RoutingStrategy
  credential_failure_threshold: number
  credential_cooldown_seconds: number
  system_proxy_id: string
  request_timeout_seconds: number
  max_request_mib: number
  request_bytes_in_flight_mib: number
  memory_reclaim_threshold_mib: number
  unpriced_model_policy: UnpricedPolicy
  upstream_websockets: boolean
  request_retry: number
  max_retry_credentials: number
  max_retry_interval: number
  disable_credential_cooling: boolean
  passthrough_headers: boolean
  image_generation_mode: ImageGenerationMode
  gpt_image_base_model: string
  video_result_auth_cache_ttl: string
  force_model_prefix: boolean
  stream_keepalive_seconds: number
  stream_bootstrap_retries: number
  nonstream_keepalive_interval: number
}

type RuntimeInfo = {
  ready: boolean
  credentials: number
  models: number
  max_in_flight: number
  max_queue: number
}

type SettingsResponse = {
  mode: "embedded_cpa" | "native"
  settings: RuntimeSettings
  runtime: RuntimeInfo
}

type Choice<T extends string | number> = { value: T; label: string }

const routingChoices: Choice<RoutingStrategy>[] = [
  { value: "round-robin", label: "轮流用" },
  { value: "fill-first", label: "先打满主账户" },
]

const retryChoices: Choice<number>[] = [
  { value: 0, label: "不重试" },
  { value: 1, label: "1 次" },
  { value: 2, label: "2 次" },
  { value: 3, label: "3 次" },
  { value: 5, label: "5 次" },
]

const retryCredentialChoices: Choice<number>[] = [
  { value: 0, label: "不限制" },
  { value: 2, label: "2 个" },
  { value: 3, label: "3 个" },
  { value: 5, label: "5 个" },
]

const retryIntervalChoices: Choice<number>[] = [
  { value: 0, label: "立即" },
  { value: 5, label: "5 秒" },
  { value: 15, label: "15 秒" },
  { value: 30, label: "30 秒" },
  { value: 60, label: "1 分钟" },
]

const streamKeepAliveChoices: Choice<number>[] = [
  { value: 0, label: "关闭" },
  { value: 15, label: "15 秒" },
  { value: 30, label: "30 秒" },
  { value: 60, label: "1 分钟" },
]

const bootstrapRetryChoices: Choice<number>[] = [
  { value: 0, label: "不重试" },
  { value: 1, label: "1 次" },
  { value: 2, label: "2 次" },
  { value: 3, label: "3 次" },
]

const nonstreamKeepAliveChoices: Choice<number>[] = [
  { value: 0, label: "关闭" },
  { value: 15, label: "15 秒" },
  { value: 30, label: "30 秒" },
]

const timeoutChoices: Choice<number>[] = [
  { value: 120, label: "2 分钟" },
  { value: 300, label: "5 分钟" },
  { value: 900, label: "15 分钟" },
  { value: 3600, label: "1 小时" },
  { value: 86400, label: "等到流结束" },
]

const requestBodyChoices: Choice<number>[] = [
  { value: 32, label: "32 MiB" },
  { value: 128, label: "128 MiB" },
  { value: 256, label: "256 MiB" },
  { value: 1024, label: "1 GiB" },
  { value: 2048, label: "2 GiB" },
]

const inFlightChoices: Choice<number>[] = [
  { value: 512, label: "512 MiB" },
  { value: 1024, label: "1 GiB" },
  { value: 2048, label: "2 GiB" },
  { value: 4096, label: "4 GiB" },
  { value: 8192, label: "8 GiB" },
]

const reclaimChoices: Choice<number>[] = [
  { value: 256, label: "256 MiB" },
  { value: 1024, label: "1 GiB" },
  { value: 4096, label: "4 GiB" },
  { value: 8192, label: "8 GiB" },
]

const imageModeChoices: Choice<ImageGenerationMode>[] = [
  { value: "enabled", label: "全部允许" },
  { value: "disabled", label: "全部关闭" },
  { value: "chat", label: "对话不注入" },
  { value: "passthrough", label: "按客户端" },
]

const imageModelChoices: Choice<string>[] = [
  { value: "gpt-5.4-mini", label: "gpt-5.4-mini" },
  { value: "gpt-5.4", label: "gpt-5.4" },
  { value: "gpt-5.6-luna", label: "gpt-5.6-luna" },
  { value: "gpt-5.6-sol", label: "gpt-5.6-sol" },
  { value: "gpt-5.6-terra", label: "gpt-5.6-terra" },
]

const videoTtlChoices: Choice<string>[] = [
  { value: "30m", label: "30 分钟" },
  { value: "1h", label: "1 小时" },
  { value: "3h", label: "3 小时" },
  { value: "6h", label: "6 小时" },
  { value: "12h", label: "12 小时" },
]

const imageModeHelp: Record<ImageGenerationMode, string> = {
  enabled: "对话里的出图工具和 /v1/images 都交给上游。",
  disabled: "对话不出图，/v1/images 直接 404。",
  chat: "对话里不再塞出图工具，/v1/images 仍可用。",
  passthrough:
    "对话里不增不删出图工具：客户端带了就转，没带就不加。/v1/images 仍可用。",
}

function withCurrent<T extends string | number>(
  options: Choice<T>[],
  current: T,
  label: (value: T) => string
): Choice<T>[] {
  if (options.some((item) => item.value === current)) {
    return options
  }
  return [{ value: current, label: label(current) }, ...options]
}

function formatSeconds(value: number) {
  if (value <= 0) return "关闭"
  if (value % 3600 === 0) return `${value / 3600} 小时`
  if (value % 60 === 0) return `${value / 60} 分钟`
  return `${value} 秒`
}

function formatCount(value: number, unit: string, zero = "不限制") {
  if (value === 0) return zero
  return `${value} ${unit}`
}

function formatMib(value: number) {
  return value >= 1024 && value % 1024 === 0
    ? `${value / 1024} GiB`
    : `${value} MiB`
}

function nextInFlight(requestMiB: number, currentInFlight: number) {
  if (currentInFlight >= requestMiB) return currentInFlight
  const preset = inFlightChoices.find((item) => item.value >= requestMiB)
  return preset?.value ?? requestMiB
}

function ChoiceField<T extends string | number>({
  label,
  description,
  value,
  options,
  onChange,
}: {
  label: string
  description: string
  value: T
  options: Choice<T>[]
  onChange: (value: T) => void
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <ToggleGroup
        variant="outline"
        size="sm"
        spacing={1}
        value={[String(value)]}
        onValueChange={(next) => {
          const picked = next[0]
          if (picked == null) return
          const match = options.find((item) => String(item.value) === picked)
          if (match) onChange(match.value)
        }}
        className="w-full flex-wrap"
      >
        {options.map((option) => (
          <ToggleGroupItem
            key={String(option.value)}
            value={String(option.value)}
            className="min-w-24 flex-1"
          >
            {String(value) === String(option.value) ? <CheckIcon /> : null}
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <FieldDescription>{description}</FieldDescription>
    </Field>
  )
}

function SwitchField({
  id,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  id: string
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </Field>
  )
}

export function RuntimeSettingsView() {
  const [value, setValue] = useState<RuntimeSettings | null>(null)
  const [saved, setSaved] = useState<RuntimeSettings | null>(null)
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [proxies, setProxies] = useState<OutboundProxy[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [result, proxyResult] = await Promise.all([
        api<SettingsResponse>("/api/admin/runtime/settings"),
        api<{ items: OutboundProxy[] }>("/api/admin/proxies"),
      ])
      setValue(result.settings)
      setSaved(result.settings)
      setRuntime(result.runtime)
      setProxies(proxyResult.items ?? [])
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "无法读取运行配置")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => void load(), [load])
  const dirty = useMemo(
    () =>
      Boolean(
        value && saved && JSON.stringify(value) !== JSON.stringify(saved)
      ),
    [saved, value]
  )
  const patch = <K extends keyof RuntimeSettings>(
    key: K,
    next: RuntimeSettings[K]
  ) => setValue((current) => (current ? { ...current, [key]: next } : current))

  useEffect(() => {
    if (!dirty) return
    const guard = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener("beforeunload", guard)
    return () => window.removeEventListener("beforeunload", guard)
  }, [dirty])

  async function save() {
    if (!value) return
    setSaving(true)
    try {
      const result = await api<SettingsResponse>(
        "/api/admin/runtime/settings",
        {
          method: "PATCH",
          body: JSON.stringify(value),
        }
      )
      setValue(result.settings)
      setSaved(result.settings)
      setRuntime(result.runtime)
      toast.success("运行策略已热更新")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  if (loading || !value || !runtime) {
    return (
      <div className="flex min-h-56 items-center justify-center">
        <Spinner />
      </div>
    )
  }

  const proxyItems = [
    { value: "direct", label: "直连" },
    ...proxies.map((item) => ({
      value: item.id,
      label: `${item.name} · ${item.endpoint}`,
    })),
  ]
  const imageModels = withCurrent(
    imageModelChoices,
    value.gpt_image_base_model,
    (model) => model
  )
  const imageModes = withCurrent(
    imageModeChoices,
    value.image_generation_mode,
    (mode) => mode
  )
  const imageModeHelpText =
    imageModeHelp[value.image_generation_mode] ??
    "当前值不在常用选项里，选一项后才会按上面的规则生效。"

  return (
    <div className="flex flex-col gap-5">
      <StatStrip
        className="lg:grid-cols-4"
        items={[
          {
            label: "运行状态",
            value: runtime.ready ? "正常" : "异常",
            tone: runtime.ready ? "positive" : "negative",
          },
          { label: "有效凭据", value: runtime.credentials },
          { label: "发布模型", value: runtime.models },
          {
            label: "同时处理 / 排队",
            value: `${runtime.max_in_flight} / ${runtime.max_queue}`,
            detail: "启动项，改环境变量后重启生效",
          },
        ]}
      />

      <div className="grid items-start gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>多账户怎么选</CardTitle>
            <CardDescription>
              同一模型有多个账户时的分流方式。不会改写用户请求。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <ChoiceField
                label="调度方式"
                description={
                  value.routing_strategy === "fill-first"
                    ? "一直用优先级最高的可用账户，打满或失败后再换下一个。"
                    : "同一模型下的可用账户轮流接请求，适合把额度摊开。"
                }
                value={value.routing_strategy}
                options={routingChoices}
                onChange={(next) => patch("routing_strategy", next)}
              />
              <SwitchField
                id="credential-cooling"
                label="失败后暂时移出账户"
                description="打开后，连续失败的账户会短时间不再被选中。偶发 429 较多时建议关掉，避免把限流当成账户坏了。"
                checked={!value.disable_credential_cooling}
                onCheckedChange={(checked) =>
                  patch("disable_credential_cooling", !checked)
                }
              />
            </FieldGroup>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>失败怎么处理</CardTitle>
            <CardDescription>
              只在上游运行时内部换账户再试，不会让 Relay 把同一笔请求重放一遍。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <ChoiceField
                label="同一请求再试几次"
                description="针对 403、408、500、502、503、504。选「不重试」则失败立刻返回。"
                value={value.request_retry}
                options={withCurrent(
                  retryChoices,
                  value.request_retry,
                  (count) => formatCount(count, "次", "不重试")
                )}
                onChange={(next) => patch("request_retry", next)}
              />
              <ChoiceField
                label="最多换几个账户"
                description="0 表示能试的账户都试。有上限时，试满就停。"
                value={value.max_retry_credentials}
                options={withCurrent(
                  retryCredentialChoices,
                  value.max_retry_credentials,
                  (count) => formatCount(count, "个")
                )}
                onChange={(next) => patch("max_retry_credentials", next)}
              />
              <ChoiceField
                label="两次尝试间隔上限"
                description="换账户再试之前最多等这么久。选「立即」表示不等冷却。"
                value={value.max_retry_interval}
                options={withCurrent(
                  retryIntervalChoices,
                  value.max_retry_interval,
                  formatSeconds
                )}
                onChange={(next) => patch("max_retry_interval", next)}
              />
              <ChoiceField
                label="出字前再试"
                description="流式响应还没吐出第一个字节时，允许再换账户试几次。"
                value={value.stream_bootstrap_retries}
                options={withCurrent(
                  bootstrapRetryChoices,
                  value.stream_bootstrap_retries,
                  (count) => formatCount(count, "次", "不重试")
                )}
                onChange={(next) => patch("stream_bootstrap_retries", next)}
              />
            </FieldGroup>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>长连接怎么维持</CardTitle>
            <CardDescription>
              只影响已经建立的 SSE 或 WebSocket，不会打断正在输出的内容。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <ChoiceField
                label="流式保活"
                description="隔多久给客户端发一行空的保活。代理或浏览器容易因空闲断开时再打开。"
                value={value.stream_keepalive_seconds}
                options={withCurrent(
                  streamKeepAliveChoices,
                  value.stream_keepalive_seconds,
                  formatSeconds
                )}
                onChange={(next) => patch("stream_keepalive_seconds", next)}
              />
              <ChoiceField
                label="非流式保活"
                description="普通 JSON 响应等待期间的空闲保活。大多数部署保持关闭即可。"
                value={value.nonstream_keepalive_interval}
                options={withCurrent(
                  nonstreamKeepAliveChoices,
                  value.nonstream_keepalive_interval,
                  formatSeconds
                )}
                onChange={(next) => patch("nonstream_keepalive_interval", next)}
              />
              <SwitchField
                id="upstream-websockets"
                label="上游 WebSocket"
                description="打开后，Codex / xAI 账户可以使用原生多轮 WebSocket。关掉则目录不再推荐，客户端改走 HTTP 流式。"
                checked={value.upstream_websockets}
                onCheckedChange={(checked) =>
                  patch("upstream_websockets", checked)
                }
              />
            </FieldGroup>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>出图与视频</CardTitle>
            <CardDescription>
              对应上游运行时对出图工具和视频结果绑定的处理方式。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <ChoiceField
                label="出图"
                description={imageModeHelpText}
                value={value.image_generation_mode}
                options={imageModes}
                onChange={(next) => patch("image_generation_mode", next)}
              />
              {value.image_generation_mode === "disabled" ? null : (
                <Field>
                  <FieldLabel>对话出图用哪颗模型垫底</FieldLabel>
                  <Select
                    items={imageModels}
                    value={value.gpt_image_base_model}
                    onValueChange={(next) =>
                      next && patch("gpt_image_base_model", next)
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {imageModels.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    只在对话里走旧版出图工具、又没直接打到 /v1/images
                    时用到。必须是 gpt- 开头的模型。
                  </FieldDescription>
                </Field>
              )}
              <ChoiceField
                label="视频结果还绑在原账户多久"
                description="生成视频后，结果会继续找当时那个账户。过期后再去取，可能换到别的账户。"
                value={value.video_result_auth_cache_ttl}
                options={withCurrent(
                  videoTtlChoices,
                  value.video_result_auth_cache_ttl,
                  (ttl) => ttl
                )}
                onChange={(next) => patch("video_result_auth_cache_ttl", next)}
              />
            </FieldGroup>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>系统网络</CardTitle>
            <CardDescription>
              只给 OAuth、价格目录这些 Relay
              自己的请求用。推理流量在模型账户上单独选代理。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel>系统代理</FieldLabel>
                <Select
                  items={proxyItems}
                  value={value.system_proxy_id || "direct"}
                  onValueChange={(next) =>
                    patch(
                      "system_proxy_id",
                      next === "direct" || !next ? "" : next
                    )
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {proxyItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  账户代理在「出站代理」里维护，再到模型账户上绑定。
                </FieldDescription>
              </Field>
              <SwitchField
                id="passthrough-headers"
                label="把上游响应头转给客户端"
                description="打开后，上游允许转发的响应头会继续给到客户端。一般保持打开。"
                checked={value.passthrough_headers}
                onCheckedChange={(checked) =>
                  patch("passthrough_headers", checked)
                }
              />
              <SwitchField
                id="force-model-prefix"
                label="模型名必须带账户前缀"
                description="打开后，必须写成「账户/模型」才能打到带前缀的账户。现有客户端都用裸模型名，保持关闭。"
                checked={value.force_model_prefix}
                onCheckedChange={(checked) =>
                  patch("force_model_prefix", checked)
                }
              />
            </FieldGroup>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>进程边界</CardTitle>
            <CardDescription>
              保存后立即生效，不必改环境变量。同时处理路数仍由启动项决定。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <ChoiceField
                label="等多久才算上游没响应"
                description="只限制等待响应头。已经开始的 SSE 或 WebSocket 不会被这个时间砍断。"
                value={value.request_timeout_seconds}
                options={withCurrent(
                  timeoutChoices,
                  value.request_timeout_seconds,
                  formatSeconds
                )}
                onChange={(next) => patch("request_timeout_seconds", next)}
              />
              <ChoiceField
                label="单个请求体"
                description="超过这个大小的推理请求会被拒绝。"
                value={value.max_request_mib}
                options={withCurrent(
                  requestBodyChoices,
                  value.max_request_mib,
                  formatMib
                )}
                onChange={(next) => {
                  setValue((current) =>
                    current
                      ? {
                          ...current,
                          max_request_mib: next,
                          request_bytes_in_flight_mib: nextInFlight(
                            next,
                            current.request_bytes_in_flight_mib
                          ),
                        }
                      : current
                  )
                }}
              />
              <ChoiceField
                label="在途请求体合计"
                description="所有正在处理的请求体加起来不能超过这个数，必须不小于单个请求体。"
                value={value.request_bytes_in_flight_mib}
                options={withCurrent(
                  inFlightChoices.filter(
                    (item) => item.value >= value.max_request_mib
                  ),
                  value.request_bytes_in_flight_mib,
                  formatMib
                )}
                onChange={(next) => patch("request_bytes_in_flight_mib", next)}
              />
              <ChoiceField
                label="内存回收"
                description="堆占用超过这个值才主动回收。调高会少打扰正在跑的请求。"
                value={value.memory_reclaim_threshold_mib}
                options={withCurrent(
                  reclaimChoices,
                  value.memory_reclaim_threshold_mib,
                  formatMib
                )}
                onChange={(next) => patch("memory_reclaim_threshold_mib", next)}
              />
              <ChoiceField
                label="还没标价的模型"
                description={
                  value.unpriced_model_policy === "deny"
                    ? "没有价格的模型直接 503，需要先在价格页补上。"
                    : "没有价格也能调用，只是不预留余额。"
                }
                value={value.unpriced_model_policy}
                options={[
                  { value: "allow", label: "允许调用" },
                  { value: "deny", label: "拒绝调用" },
                ]}
                onChange={(next) => patch("unpriced_model_policy", next)}
              />
            </FieldGroup>
          </CardContent>
        </Card>
      </div>

      {dirty ? (
        <div className="sticky bottom-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-background px-4 py-3">
          <p className="text-sm">有未保存的更改</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => saved && setValue(saved)}
            >
              <RotateCcwIcon data-icon="inline-start" /> 撤销
            </Button>
            <Button disabled={saving} onClick={() => void save()}>
              {saving ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <SaveIcon data-icon="inline-start" />
              )}
              保存
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

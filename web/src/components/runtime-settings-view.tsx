import { useCallback, useEffect, useId, useMemo, useState } from "react"
import { Button } from "@astryxdesign/core/Button"
import { Field } from "@astryxdesign/core/Field"
import { FormLayout } from "@astryxdesign/core/FormLayout"
import { Grid } from "@astryxdesign/core/Grid"
import {
  HStack,
  LayoutFooter,
  VStack,
} from "@astryxdesign/core/Layout"
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl"
import { Selector } from "@astryxdesign/core/Selector"
import { Switch } from "@astryxdesign/core/Switch"
import { Text } from "@astryxdesign/core/Text"
import { useToast } from "@astryxdesign/core/Toast"
import { RotateCcwIcon, SaveIcon } from "lucide-react"

import { LoadErrorView } from "@/components/load-error-view"
import { LoadingView } from "@/components/loading-view"
import { MetricStrip, PageFrame, PageSection, StatusLabel } from "@/components/page-kit"
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
  { value: "round-robin", label: "轮询" },
  { value: "fill-first", label: "固定优先级" },
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
  { value: 86400, label: "24 小时" },
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
  { value: "enabled", label: "启用" },
  { value: "disabled", label: "禁用" },
  { value: "chat", label: "对话除外" },
  { value: "passthrough", label: "透传" },
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
  enabled: "对话出图工具与 /v1/images 均可用。",
  disabled: "关闭出图工具，/v1/images 返回 404。",
  chat: "对话不注入出图工具，/v1/images 仍可用。",
  passthrough: "对话不增删出图工具，按客户端请求转发；/v1/images 仍可用。",
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
  value,
  options,
  onChange,
}: {
  label: string
  description?: string
  value: T
  options: Choice<T>[]
  onChange: (value: T) => void
}) {
  const inputID = useId()
  const selected = String(value)
  const selectorOptions = options.map((option) => ({
    value: String(option.value),
    label: option.label,
  }))

  function handleChange(next: string) {
    const match = options.find((item) => String(item.value) === next)
    if (match) onChange(match.value)
  }

  if (options.length >= 2 && options.length <= 5) {
    return (
      <Field
        label={label}
        inputID={inputID}
        isGroupLabel
      >
        <SegmentedControl
          label={label}
          value={selected}
          onChange={handleChange}
          layout="fill"
        >
          {options.map((option) => (
            <SegmentedControlItem
              key={String(option.value)}
              value={String(option.value)}
              label={option.label}
            />
          ))}
        </SegmentedControl>
      </Field>
    )
  }

  return (
    <Selector
      label={label}
      value={selected}
      options={selectorOptions}
      onChange={handleChange}
    />
  )
}

export function RuntimeSettingsView({
  accessory,
}: {
  accessory?: import("react").ReactNode
}) {
  const toast = useToast()
  const [value, setValue] = useState<RuntimeSettings | null>(null)
  const [saved, setSaved] = useState<RuntimeSettings | null>(null)
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [saving, setSaving] = useState(false)
  const [proxies, setProxies] = useState<OutboundProxy[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError("")
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
      const message =
        cause instanceof Error ? cause.message : "无法读取运行配置"
      setLoadError(message)
      toast({ type: "error", body: message })
    } finally {
      setLoading(false)
    }
  }, [toast])

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
      toast({ body: "运行策略已更新" })
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "保存失败",
      })
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <LoadingView />
  if (loadError || !value || !runtime) {
    return (
      <LoadErrorView
        message={loadError || "无法读取运行配置"}
        onRetry={() => void load()}
      />
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
    imageModeHelp[value.image_generation_mode] ?? "当前值不在预设选项中。"

  return (
    <PageFrame
      title="设置"
      accessory={accessory}
      contentWidth={640}
      contentPadding={6}
      footer={
        dirty ? (
          <LayoutFooter>
            <HStack hAlign="between" vAlign="center" gap={3} wrap="wrap">
              <Text>有未保存的更改</Text>
              <HStack gap={2} vAlign="center" wrap="wrap">
                <Button
                  label="重置"
                  icon={<RotateCcwIcon />}
                  isDisabled={saving}
                  onClick={() => saved && setValue(saved)}
                />
                <Button
                  label="保存"
                  variant="primary"
                  icon={<SaveIcon />}
                  isLoading={saving}
                  onClick={() => void save()}
                />
              </HStack>
            </HStack>
          </LayoutFooter>
        ) : undefined
      }
    >
        <VStack gap={6}>
          <MetricStrip
            items={[
              {
                label: "运行状态",
                value: (
                  <StatusLabel
                    tone={runtime.ready ? "success" : "error"}
                    label={runtime.ready ? "正常" : "异常"}
                  />
                ),
              },
              { label: "有效凭据", value: runtime.credentials },
              { label: "发布模型", value: runtime.models },
              {
                label: "并发 / 排队",
                value: `${runtime.max_in_flight} / ${runtime.max_queue}`,
              },
            ]}
          />

          <Grid columns={{ minWidth: 360, max: 2 }} gap={4}>
            <PageSection title="凭据调度">
              <FormLayout direction="horizontal-labels">
                <ChoiceField
                  label="调度方式"
                  description={
                    value.routing_strategy === "fill-first"
                      ? "优先使用优先级最高的可用账户，不可用后再切换。"
                      : "同一模型下的可用账户轮流接请求。"
                  }
                  value={value.routing_strategy}
                  options={routingChoices}
                  onChange={(next) => patch("routing_strategy", next)}
                />
                <Switch
                  label="凭据冷却"
                  description="连续失败的账户会暂时移出候选。"
                  value={!value.disable_credential_cooling}
                  onChange={(checked) =>
                    patch("disable_credential_cooling", !checked)
                  }
                />
              </FormLayout>
            </PageSection>

            <PageSection title="失败重试">
              <FormLayout direction="horizontal-labels">
                <ChoiceField
                  label="请求重试"
                  description="适用于 403、408、500、502、503、504。"
                  value={value.request_retry}
                  options={withCurrent(
                    retryChoices,
                    value.request_retry,
                    (count) => formatCount(count, "次", "不重试")
                  )}
                  onChange={(next) => patch("request_retry", next)}
                />
                <ChoiceField
                  label="最多尝试账户"
                  description="不限制时会尝试该模型下所有可用账户。"
                  value={value.max_retry_credentials}
                  options={withCurrent(
                    retryCredentialChoices,
                    value.max_retry_credentials,
                    (count) => formatCount(count, "个")
                  )}
                  onChange={(next) => patch("max_retry_credentials", next)}
                />
                <ChoiceField
                  label="重试间隔上限"
                  description="两次更换账户之间的最长等待时间。"
                  value={value.max_retry_interval}
                  options={withCurrent(
                    retryIntervalChoices,
                    value.max_retry_interval,
                    formatSeconds
                  )}
                  onChange={(next) => patch("max_retry_interval", next)}
                />
                <ChoiceField
                  label="流式启动重试"
                  description="流式响应发出首字节前，允许再换账户。"
                  value={value.stream_bootstrap_retries}
                  options={withCurrent(
                    bootstrapRetryChoices,
                    value.stream_bootstrap_retries,
                    (count) => formatCount(count, "次", "不重试")
                  )}
                  onChange={(next) => patch("stream_bootstrap_retries", next)}
                />
              </FormLayout>
            </PageSection>

            <PageSection title="长连接">
              <FormLayout direction="horizontal-labels">
                <ChoiceField
                  label="流式保活"
                  description="向客户端发送空行保活的间隔。"
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
                  description="非流式响应等待期间的保活间隔。"
                  value={value.nonstream_keepalive_interval}
                  options={withCurrent(
                    nonstreamKeepAliveChoices,
                    value.nonstream_keepalive_interval,
                    formatSeconds
                  )}
                  onChange={(next) =>
                    patch("nonstream_keepalive_interval", next)
                  }
                />
                <Switch
                  label="上游 WebSocket"
                  description="允许 Codex / xAI 使用原生 WebSocket。关闭后目录不再推荐，客户端改走 HTTP 流式。"
                  value={value.upstream_websockets}
                  onChange={(checked) => patch("upstream_websockets", checked)}
                />
              </FormLayout>
            </PageSection>

            <PageSection title="图像与视频">
              <FormLayout direction="horizontal-labels">
                <ChoiceField
                  label="图像生成"
                  description={imageModeHelpText}
                  value={value.image_generation_mode}
                  options={imageModes}
                  onChange={(next) => patch("image_generation_mode", next)}
                />
                {value.image_generation_mode === "disabled" ? null : (
                  <Selector
                    label="图像基础模型"
                    description="对话内出图工具使用的基础模型，须以 gpt- 开头。"
                    value={value.gpt_image_base_model}
                    options={imageModels}
                    onChange={(next) => patch("gpt_image_base_model", next)}
                  />
                )}
                <ChoiceField
                  label="视频结果绑定"
                  description="视频结果与创建账户的绑定时长。过期后再次获取可能切换账户。"
                  value={value.video_result_auth_cache_ttl}
                  options={withCurrent(
                    videoTtlChoices,
                    value.video_result_auth_cache_ttl,
                    (ttl) => ttl
                  )}
                  onChange={(next) =>
                    patch("video_result_auth_cache_ttl", next)
                  }
                />
              </FormLayout>
            </PageSection>

            <PageSection title="系统网络">
              <FormLayout direction="horizontal-labels">
                <Selector
                  label="系统代理"
                  description="账户代理在「出站代理」中维护，并在模型账户上绑定。"
                  value={value.system_proxy_id || "direct"}
                  options={proxyItems}
                  onChange={(next) =>
                    patch(
                      "system_proxy_id",
                      next === "direct" || !next ? "" : next
                    )
                  }
                />
                <Switch
                  label="转发上游响应头"
                  description="将允许转发的上游响应头交给客户端。"
                  value={value.passthrough_headers}
                  onChange={(checked) => patch("passthrough_headers", checked)}
                />
                <Switch
                  label="强制模型前缀"
                  description="仅接受「账户/模型」形式的模型名。"
                  value={value.force_model_prefix}
                  onChange={(checked) => patch("force_model_prefix", checked)}
                />
              </FormLayout>
            </PageSection>

            <PageSection title="进程边界">
              <FormLayout direction="horizontal-labels">
                <ChoiceField
                  label="响应头超时"
                  description="仅限制等待响应头的时间，已开始的流不会中断。"
                  value={value.request_timeout_seconds}
                  options={withCurrent(
                    timeoutChoices,
                    value.request_timeout_seconds,
                    formatSeconds
                  )}
                  onChange={(next) => patch("request_timeout_seconds", next)}
                />
                <ChoiceField
                  label="请求体上限"
                  description="单个推理请求体的上限。"
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
                  label="在途请求体"
                  description="所有在途请求体合计上限，且不得小于请求体上限。"
                  value={value.request_bytes_in_flight_mib}
                  options={withCurrent(
                    inFlightChoices.filter(
                      (item) => item.value >= value.max_request_mib
                    ),
                    value.request_bytes_in_flight_mib,
                    formatMib
                  )}
                  onChange={(next) =>
                    patch("request_bytes_in_flight_mib", next)
                  }
                />
                <ChoiceField
                  label="内存回收阈值"
                  description="堆占用超过该值时才主动回收。"
                  value={value.memory_reclaim_threshold_mib}
                  options={withCurrent(
                    reclaimChoices,
                    value.memory_reclaim_threshold_mib,
                    formatMib
                  )}
                  onChange={(next) =>
                    patch("memory_reclaim_threshold_mib", next)
                  }
                />
                <ChoiceField
                  label="未定价模型"
                  description={
                    value.unpriced_model_policy === "deny"
                      ? "未配置价格的模型返回 503。"
                      : "未配置价格的模型仍可调用，不预留余额。"
                  }
                  value={value.unpriced_model_policy}
                  options={[
                    { value: "allow", label: "允许" },
                    { value: "deny", label: "拒绝" },
                  ]}
                  onChange={(next) => patch("unpriced_model_policy", next)}
                />
              </FormLayout>
            </PageSection>
          </Grid>
        </VStack>
    </PageFrame>
  )
}

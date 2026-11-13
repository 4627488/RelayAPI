import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { RotateCcwIcon, SaveIcon } from "lucide-react"
import { toast } from "@/components/ui/toast"

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
  FieldSet,
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
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { StatStrip } from "@/components/workspace-ui"
import { api, type OutboundProxy } from "@/lib/api"

function SettingsSection({ children }: { children: ReactNode }) {
  return (
    <Card className="grid items-start gap-4 rounded-none border-0 border-b last:border-b-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      {children}
    </Card>
  )
}

type RoutingStrategy = "round-robin" | "fill-first"
type UnpricedPolicy = "allow" | "deny"

type RuntimeSettings = {
  rai_default_models: string[]
  routing_strategy: RoutingStrategy
  credential_failure_threshold: number
  credential_cooldown_seconds: number
  system_proxy_id: string
  github_proxy_id?: string
  request_timeout_seconds: number
  max_request_mib: number
  request_bytes_in_flight_mib: number
  memory_reclaim_threshold_mib: number
  unpriced_model_policy: UnpricedPolicy
  upstream_websockets: boolean
}

type RuntimeInfo = {
  ready: boolean
  credentials: number
  models: number
  max_in_flight: number
  max_queue: number
}

type SettingsResponse = {
  mode: "codex"
  settings: RuntimeSettings
  runtime: RuntimeInfo
}

type Choice<T extends string | number> = { value: T; label: string }

const routingChoices: Choice<RoutingStrategy>[] = [
  { value: "round-robin", label: "轮询" },
  { value: "fill-first", label: "固定优先级" },
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
        aria-label={label}
      >
        {options.map((option) => (
          <ToggleGroupItem
            key={String(option.value)}
            value={String(option.value)}
            className="min-w-24 flex-1"
          >
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
  disabled,
  onCheckedChange,
}: {
  id: string
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
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
      toast.add({
        title: cause instanceof Error ? cause.message : "无法读取运行配置",
        type: "error",
      })
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
    if (!value || saving) return
    setSaving(true)
    try {
      const result = await api<SettingsResponse>(
        "/api/admin/runtime/settings",
        {
          method: "PATCH",
          body: JSON.stringify({
            ...value,
            rai_default_models: value.rai_default_models
              .map((model) => model.trim())
              .filter(Boolean),
          }),
        }
      )
      setValue(result.settings)
      setSaved(result.settings)
      setRuntime(result.runtime)
      toast.add({ title: "运行策略已更新", type: "success" })
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "保存失败",
        type: "error",
      })
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
  const githubProxyItems = [
    { value: "system", label: "跟随系统代理" },
    ...proxyItems,
  ]
  return (
    <div className="flex flex-col gap-6">
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
            label: "并发 / 排队",
            value: `${runtime.max_in_flight} / ${runtime.max_queue}`,
            detail: "启动配置，修改后需重启",
          },
        ]}
      />

      <FieldSet
        disabled={saving}
        aria-label="运行策略"
        className="gap-0 overflow-hidden rounded-xl border bg-card"
      >
        <SettingsSection>
          <CardHeader>
            <CardTitle>RAI 默认模型</CardTitle>
            <CardDescription>
              按优先顺序，从用户当前可用的模型中选择默认模型。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="rai-default-models">候选模型</FieldLabel>
                <Textarea
                  id="rai-default-models"
                  aria-describedby="rai-default-models-help"
                  value={value.rai_default_models.join("\n")}
                  onChange={(event) =>
                    patch("rai_default_models", event.target.value.split("\n"))
                  }
                  rows={4}
                  placeholder={"gpt-6-sol\ngpt-6-luna"}
                />
                <FieldDescription id="rai-default-models-help">
                  每行一个模型
                  ID，越靠前越优先。全部不可用或留空时，提示用户手动选择。
                  用户指定的模型优先；自动模式在下次启动时使用最新配置。
                </FieldDescription>
              </Field>
            </FieldGroup>
          </CardContent>
        </SettingsSection>

        <SettingsSection>
          <CardHeader>
            <CardTitle>凭据调度</CardTitle>
            <CardDescription>同一模型有多个账户时的分流方式。</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
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
            </FieldGroup>
          </CardContent>
        </SettingsSection>

        <SettingsSection>
          <CardHeader>
            <CardTitle>长连接</CardTitle>
            <CardDescription>
              已建立的 SSE 或 WebSocket 保活策略，不会中断正在输出的内容。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <SwitchField
                id="upstream-websockets"
                label="上游 WebSocket"
                description="允许 Codex 使用原生 WebSocket。关闭后目录不再推荐，客户端改走 HTTP 流式。"
                checked={value.upstream_websockets}
                disabled={saving}
                onCheckedChange={(checked) =>
                  patch("upstream_websockets", checked)
                }
              />
            </FieldGroup>
          </CardContent>
        </SettingsSection>

        <SettingsSection>
          <CardHeader>
            <CardTitle>系统网络</CardTitle>
            <CardDescription>
              用于 OAuth
              与价格目录等系统请求。推理流量在模型账户上单独选择代理。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="system-proxy">系统代理</FieldLabel>
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
                  <SelectTrigger id="system-proxy" className="w-full">
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
                  账户代理在「出站代理」中维护，并在模型账户上绑定。
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="github-login-proxy">
                  GitHub 登录代理
                </FieldLabel>
                <Select
                  items={githubProxyItems}
                  value={value.github_proxy_id || "direct"}
                  onValueChange={(next) =>
                    patch(
                      "github_proxy_id",
                      next === "direct" || !next ? "" : next
                    )
                  }
                >
                  <SelectTrigger id="github-login-proxy" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {githubProxyItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  用于 GitHub
                  登录和绑定回调中的授权码交换、身份查询。默认直连，保存后生效；代理在「出站代理」中维护。
                </FieldDescription>
              </Field>
            </FieldGroup>
          </CardContent>
        </SettingsSection>

        <SettingsSection>
          <CardHeader>
            <CardTitle>进程边界</CardTitle>
            <CardDescription>
              保存后立即生效。并发路数仍由启动配置决定。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
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
                onChange={(next) => patch("request_bytes_in_flight_mib", next)}
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
                onChange={(next) => patch("memory_reclaim_threshold_mib", next)}
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
            </FieldGroup>
          </CardContent>
        </SettingsSection>
      </FieldSet>

      {dirty ? (
        <div className="sticky bottom-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3 shadow-sm">
          <p className="text-sm">有未保存的更改</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => saved && setValue(saved)}
            >
              <RotateCcwIcon data-icon="inline-start" /> 撤销
            </Button>
            <Button
              disabled={saving}
              aria-busy={saving}
              onClick={() => void save()}
            >
              {saving ? (
                <Spinner aria-hidden="true" data-icon="inline-start" />
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

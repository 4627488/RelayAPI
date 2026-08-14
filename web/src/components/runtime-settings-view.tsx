import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ActivityIcon,
  ImageIcon,
  NetworkIcon,
  RotateCcwIcon,
  SaveIcon,
  ServerCogIcon,
  ShieldCheckIcon,
  WavesIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
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
  FieldTitle,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api, type OutboundProxy } from "@/lib/api"

type RuntimeSettings = {
  request_retry: number
  max_retry_credentials: number
  max_retry_interval: number
  routing_strategy: "round-robin" | "fill-first"
  system_proxy_id: string
  passthrough_headers: boolean
  codex_capability_policy: "optimistic" | "verified"
  image_generation_mode: "enabled" | "disabled" | "chat" | "passthrough"
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
  request_timeout_seconds: number
  max_in_flight: number
  max_queue: number
  queue_timeout_seconds: number
  max_request_bytes: number
  request_bytes_in_flight: number
  circuit_failure_threshold: number
  circuit_open_seconds: number
  executor_cache_pressure_bytes: number
  unpriced_model_policy: string
  request_log_retention_days: number
  request_success_detail_days: number
  request_error_detail_days: number
}

type SettingsResponse = {
  mode: "native"
  settings: RuntimeSettings
  runtime: RuntimeInfo
}

function NumberField({
  id,
  label,
  description,
  value,
  min,
  max,
  onChange,
}: {
  id: string
  label: string
  description: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <FieldDescription>{description}</FieldDescription>
    </Field>
  )
}

function SwitchField({
  id,
  title,
  description,
  checked,
  onCheckedChange,
}: {
  id: string
  title: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldTitle>{title}</FieldTitle>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={title}
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
      toast.error(cause instanceof Error ? cause.message : "无法读取运行配置")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])
  const dirty = useMemo(
    () => value && saved && JSON.stringify(value) !== JSON.stringify(saved),
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
        { method: "PATCH", body: JSON.stringify(value) }
      )
      setValue(result.settings)
      setSaved(result.settings)
      setRuntime(result.runtime)
      toast.success("native 运行配置已热更新")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  if (loading || !value || !runtime)
    return (
      <div className="flex min-h-56 items-center justify-center">
        <Spinner />
      </div>
    )

  return (
    <div className="flex flex-col gap-5 pb-20">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Badge variant="secondary">Native</Badge>
            <span className="text-xs text-muted-foreground">运行时配置</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">系统设置</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            配置 RelayAPI 内置推理引擎。保存后立即作用于新请求。
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!dirty || saving}
            onClick={() => saved && setValue(saved)}
          >
            <RotateCcwIcon />
            撤销
          </Button>
          <Button disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? <Spinner /> : <SaveIcon />}
            {dirty ? "保存更改" : "已保存"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-4">
        {[
          ["运行状态", runtime.ready ? "正常" : "异常"],
          ["有效凭据", runtime.credentials],
          ["已发布模型", runtime.models],
          ["并发上限", runtime.max_in_flight],
        ].map(([label, item]) => (
          <div key={label} className="bg-background px-4 py-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{item}</p>
          </div>
        ))}
      </div>

      <Tabs defaultValue="reliability">
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="reliability">
            <ActivityIcon />
            可靠性
          </TabsTrigger>
          <TabsTrigger value="network">
            <NetworkIcon />
            网络
          </TabsTrigger>
          <TabsTrigger value="media">
            <ImageIcon />
            图像与视频
          </TabsTrigger>
          <TabsTrigger value="protocol">
            <WavesIcon />
            协议行为
          </TabsTrigger>
          <TabsTrigger value="limits">
            <ServerCogIcon />
            容量
          </TabsTrigger>
        </TabsList>

        <TabsContent value="reliability">
          <Card>
            <CardHeader>
              <CardTitle>失败恢复与凭据调度</CardTitle>
              <CardDescription>
                控制上游失败后如何切换凭据，以及多个可用账户如何分配请求。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup className="grid md:grid-cols-2">
                <NumberField
                  id="request-retry"
                  label="请求重试次数"
                  description="单个请求失败后允许再次执行的次数。"
                  value={value.request_retry}
                  min={0}
                  max={20}
                  onChange={(next) => patch("request_retry", next)}
                />
                <NumberField
                  id="retry-credentials"
                  label="最大尝试凭据数"
                  description="0 表示不限制；达到上限后停止切换账户。"
                  value={value.max_retry_credentials}
                  min={0}
                  max={100}
                  onChange={(next) => patch("max_retry_credentials", next)}
                />
                <NumberField
                  id="retry-interval"
                  label="最大等待时间（秒）"
                  description="等待冷却中凭据恢复的最长时间。"
                  value={value.max_retry_interval}
                  min={0}
                  max={3600}
                  onChange={(next) => patch("max_retry_interval", next)}
                />
                <Field>
                  <FieldLabel>调度策略</FieldLabel>
                  <Select
                    value={value.routing_strategy}
                    onValueChange={(next) => {
                      if (next)
                        patch(
                          "routing_strategy",
                          next as RuntimeSettings["routing_strategy"]
                        )
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="round-robin">
                          轮询 — 均匀分散请求
                        </SelectItem>
                        <SelectItem value="fill-first">
                          顺序优先 — 优先使用首个可用凭据
                        </SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    账户优先级仍会先于此策略生效。
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="network">
          <Card>
            <CardHeader>
              <CardTitle>系统请求代理</CardTitle>
              <CardDescription>
                仅用于模型元数据同步、系统级 OAuth 等 RelayAPI
                自身发起的请求，不会成为模型账户的默认代理。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <Field>
                  <FieldLabel>系统代理</FieldLabel>
                  <Select
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
                        <SelectItem value="direct">
                          不使用代理（直连）
                        </SelectItem>
                        {proxies.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.name} · {item.endpoint}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    代理条目请在左侧“代理”页面新增、测试和维护。模型账户是否使用代理需在账户中单独选择。
                  </FieldDescription>
                </Field>
                {!proxies.length ? (
                  <Alert>
                    <NetworkIcon />
                    <AlertTitle>还没有代理条目</AlertTitle>
                    <AlertDescription>
                      当前系统请求保持直连。先到“代理”页面添加并测试代理，再返回选择。
                    </AlertDescription>
                  </Alert>
                ) : null}
              </FieldGroup>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="media">
          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>图像生成</CardTitle>
                <CardDescription>
                  控制 image_generation 工具注入和 Images API 的可用范围。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <Field>
                    <FieldLabel>图像生成策略</FieldLabel>
                    <Select
                      value={value.image_generation_mode}
                      onValueChange={(next) => {
                        if (next)
                          patch(
                            "image_generation_mode",
                            next as RuntimeSettings["image_generation_mode"]
                          )
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="enabled">完整启用</SelectItem>
                          <SelectItem value="chat">仅 Images API</SelectItem>
                          <SelectItem value="passthrough">
                            仅客户端显式传入
                          </SelectItem>
                          <SelectItem value="disabled">全部禁用</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="image-model">
                      图像工具基础模型
                    </FieldLabel>
                    <Input
                      id="image-model"
                      value={value.gpt_image_base_model}
                      onChange={(event) =>
                        patch("gpt_image_base_model", event.target.value)
                      }
                      placeholder="gpt-5.4-mini"
                      className="font-mono"
                    />
                    <FieldDescription>
                      用于兼容模式下托管的 image_generation 工具路径。
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>视频结果绑定</CardTitle>
                <CardDescription>
                  视频任务创建后，将结果查询固定到同一上游凭据。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="video-ttl">绑定时长</FieldLabel>
                    <Input
                      id="video-ttl"
                      value={value.video_result_auth_cache_ttl}
                      onChange={(event) =>
                        patch("video_result_auth_cache_ttl", event.target.value)
                      }
                      placeholder="3h"
                    />
                    <FieldDescription>
                      Go duration 格式，例如 30m、3h、24h。
                    </FieldDescription>
                  </Field>
                  <SwitchField
                    id="force-prefix"
                    title="强制模型前缀"
                    description="带前缀的凭据只接受显式前缀模型，降低误路由风险。"
                    checked={value.force_model_prefix}
                    onCheckedChange={(next) =>
                      patch("force_model_prefix", next)
                    }
                  />
                </FieldGroup>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="protocol">
          <Card>
            <CardHeader>
              <CardTitle>响应与连接行为</CardTitle>
              <CardDescription>
                这些设置会影响客户端兼容性。保活值为 0 时表示关闭。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup className="grid md:grid-cols-2">
                <Field>
                  <FieldLabel>Codex 能力声明</FieldLabel>
                  <Select
                    value={value.codex_capability_policy || "optimistic"}
                    onValueChange={(next) => {
                      if (next)
                        patch(
                          "codex_capability_policy",
                          next as RuntimeSettings["codex_capability_policy"]
                        )
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="optimistic">
                          乐观 — 默认声明全部能力
                        </SelectItem>
                        <SelectItem value="verified">
                          严格 — 仅声明已验证能力
                        </SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    乐观模式功能更完整；若某个转换型上游出现工具兼容问题，可切换严格模式诊断。
                  </FieldDescription>
                </Field>
                <SwitchField
                  id="headers"
                  title="透传上游响应头"
                  description="向客户端保留速率限制和追踪等上游响应头。"
                  checked={value.passthrough_headers}
                  onCheckedChange={(next) => patch("passthrough_headers", next)}
                />
                <NumberField
                  id="stream-keepalive"
                  label="流式心跳（秒）"
                  description="SSE 长连接的 keep-alive 间隔。"
                  value={value.stream_keepalive_seconds}
                  min={0}
                  max={300}
                  onChange={(next) => patch("stream_keepalive_seconds", next)}
                />
                <NumberField
                  id="bootstrap-retry"
                  label="流式启动重试"
                  description="发送首字节前允许透明重试的次数。"
                  value={value.stream_bootstrap_retries}
                  min={0}
                  max={10}
                  onChange={(next) => patch("stream_bootstrap_retries", next)}
                />
                <NumberField
                  id="nonstream-keepalive"
                  label="非流式保活（秒）"
                  description="等待较慢非流式响应时发送空行的间隔。"
                  value={value.nonstream_keepalive_interval}
                  min={0}
                  max={300}
                  onChange={(next) =>
                    patch("nonstream_keepalive_interval", next)
                  }
                />
              </FieldGroup>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="limits">
          <Alert>
            <ShieldCheckIcon />
            <AlertTitle>容量参数由部署环境控制</AlertTitle>
            <AlertDescription>
              并发、队列、请求体和熔断参数影响内存布局与准入控制，修改环境变量并重启后生效。
            </AlertDescription>
          </Alert>
          <Card className="mt-4">
            <CardHeader>
              <CardTitle>当前启动参数</CardTitle>
              <CardDescription>
                用于核对部署配置，不可在运行中修改。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                {[
                  ["请求超时", `${runtime.request_timeout_seconds}s`],
                  ["最大并发", runtime.max_in_flight],
                  ["排队上限", runtime.max_queue],
                  ["排队超时", `${runtime.queue_timeout_seconds}s`],
                  [
                    "单请求上限",
                    `${Math.round(runtime.max_request_bytes / 1024 / 1024)} MiB`,
                  ],
                  [
                    "在途请求体",
                    `${Math.round(runtime.request_bytes_in_flight / 1024 / 1024)} MiB`,
                  ],
                  [
                    "执行器缓存阈值",
                    `${Math.round(runtime.executor_cache_pressure_bytes / 1024 / 1024)} MiB`,
                  ],
                  ["熔断阈值", runtime.circuit_failure_threshold],
                  ["熔断时长", `${runtime.circuit_open_seconds}s`],
                  ["未定价模型", runtime.unpriced_model_policy],
                  ["请求摘要保留", `${runtime.request_log_retention_days} 天`],
                  ["成功详情保留", `${runtime.request_success_detail_days} 天`],
                  ["错误详情保留", `${runtime.request_error_detail_days} 天`],
                ].map(([label, item]) => (
                  <div key={label}>
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="mt-1 font-medium tabular-nums">{item}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

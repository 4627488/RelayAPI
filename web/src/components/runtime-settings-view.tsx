import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ActivityIcon,
  CheckCircle2Icon,
  GaugeIcon,
  NetworkIcon,
  RotateCcwIcon,
  RouteIcon,
  SaveIcon,
  ServerCogIcon,
  SparklesIcon,
  TimerResetIcon,
} from "lucide-react"
import { toast } from "sonner"

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
  FieldDescription,
  FieldGroup,
  FieldLabel,
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
import { PageHeader, StatStrip } from "@/components/workspace-ui"
import { api, type OutboundProxy } from "@/lib/api"

type RuntimeSettings = {
  routing_strategy: "round-robin" | "fill-first"
  credential_failure_threshold: number
  credential_cooldown_seconds: number
  system_proxy_id: string
}

type RuntimeInfo = {
  ready: boolean
  credentials: number
  models: number
  upstream_websockets: boolean
  request_timeout_seconds: number
  max_in_flight: number
  max_queue: number
  queue_timeout_seconds: number
  max_request_bytes: number
  request_bytes_in_flight: number
  circuit_failure_threshold: number
  circuit_open_seconds: number
  memory_reclaim_threshold_bytes: number
  unpriced_model_policy: string
}

type SettingsResponse = {
  mode: "native"
  settings: RuntimeSettings
  runtime: RuntimeInfo
}

const recommended: Omit<RuntimeSettings, "system_proxy_id"> = {
  routing_strategy: "round-robin",
  credential_failure_threshold: 3,
  credential_cooldown_seconds: 0,
}

function NumberField({
  id,
  label,
  description,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  id: string
  label: string
  description: string
  value: number
  min: number
  max: number
  suffix: string
  onChange: (value: number) => void
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="relative">
        <Input
          id={id}
          type="number"
          min={min}
          max={max}
          value={value}
          className="pr-14 tabular-nums"
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
          {suffix}
        </span>
      </div>
      <FieldDescription>{description}</FieldDescription>
    </Field>
  )
}

function formatMiB(value: number) {
  return `${Math.round(value / 1024 / 1024)} MiB`
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

  const runtimeFacts: [string, string | number][] = [
    ["响应头超时", `${runtime.request_timeout_seconds}s`],
    ["请求体上限", formatMiB(runtime.max_request_bytes)],
    ["在途内存预算", formatMiB(runtime.request_bytes_in_flight)],
    ["内存回收阈值", formatMiB(runtime.memory_reclaim_threshold_bytes)],
    [
      "全局熔断",
      `${runtime.circuit_failure_threshold} 次 / ${runtime.circuit_open_seconds}s`,
    ],
    ["未定价模型", runtime.unpriced_model_policy === "allow" ? "允许" : "拒绝"],
  ]

  return (
    <div className="flex flex-col gap-5 pb-20">
      <PageHeader
        title="运行策略"
        accessory={
          <Badge variant="secondary">
            <SparklesIcon /> Relay Native
          </Badge>
        }
        actions={
          <>
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() =>
                setValue((current) =>
                  current ? { ...current, ...recommended } : current
                )
              }
            >
              <TimerResetIcon /> 建议值
            </Button>
            <Button
              variant="outline"
              disabled={!dirty || saving}
              onClick={() => saved && setValue(saved)}
            >
              <RotateCcwIcon /> 撤销
            </Button>
            <Button disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? <Spinner /> : <SaveIcon />}
              {dirty ? "保存更改" : "已保存"}
            </Button>
          </>
        }
      />

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
            label: "流量容量",
            value: `${runtime.max_in_flight} + ${runtime.max_queue}`,
          },
        ]}
      />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,.65fr)]">
        <div className="grid gap-5">
          <Card>
            <CardHeader>
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-primary/10 p-2 text-primary">
                  <RouteIcon className="size-5" />
                </div>
                <div>
                  <CardTitle>调度与透明重试</CardTitle>
                  <CardDescription className="mt-1">
                    决定同一模型的多个账户如何分流，以及临时网络或限流错误的恢复节奏。
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <FieldGroup className="grid md:grid-cols-2">
                <Field>
                  <FieldLabel>凭据调度</FieldLabel>
                  <Select
                    items={{
                      "round-robin": "轮询均衡（推荐）",
                      "fill-first": "固定优先级",
                    }}
                    value={value.routing_strategy}
                    onValueChange={(next) =>
                      next &&
                      patch(
                        "routing_strategy",
                        next as RuntimeSettings["routing_strategy"]
                      )
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="round-robin">
                          轮询均衡（推荐）
                        </SelectItem>
                        <SelectItem value="fill-first">固定优先级</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    轮询适合共享容量；固定优先级适合主账户加备用账户。上游错误原样返回，不会透明重试。
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-amber-500/10 p-2 text-amber-600">
                  <ActivityIcon className="size-5" />
                </div>
                <div>
                  <CardTitle>凭据故障隔离</CardTitle>
                  <CardDescription className="mt-1">
                    逐凭据观察鉴权、连接和临时上游故障，自动绕开不健康账户，再进行试探恢复。
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <FieldGroup className="grid md:grid-cols-2">
                <NumberField
                  id="failure-threshold"
                  label="连续失败阈值"
                  suffix="次"
                  description="达到阈值后仅隔离该凭据，不影响同模型下的其他账户。"
                  value={value.credential_failure_threshold}
                  min={1}
                  max={20}
                  onChange={(next) =>
                    patch("credential_failure_threshold", next)
                  }
                />
                <NumberField
                  id="failure-cooldown"
                  label="隔离冷却时间"
                  suffix="秒"
                  description="0 表示不隔离。非 0 时冷却结束后回到候选池，由下一次请求验证恢复。"
                  value={value.credential_cooldown_seconds}
                  min={0}
                  max={3600}
                  onChange={(next) =>
                    patch("credential_cooldown_seconds", next)
                  }
                />
              </FieldGroup>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-5">
          <Card>
            <CardHeader>
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-blue-500/10 p-2 text-blue-600">
                  <NetworkIcon className="size-5" />
                </div>
                <div>
                  <CardTitle>系统网络</CardTitle>
                  <CardDescription className="mt-1">
                    仅供 OAuth、公共价格目录等 Relay 自身请求使用。
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Field>
                <FieldLabel>系统代理</FieldLabel>
                <Select
                  items={[
                    { value: "direct", label: "直连" },
                    ...proxies.map((item) => ({
                      value: item.id,
                      label: `${item.name} · ${item.endpoint}`,
                    })),
                  ]}
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
                      <SelectItem value="direct">直连</SelectItem>
                      {proxies.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name} · {item.endpoint}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  推理流量不继承这里；每个模型账户在账户页独立选择代理。
                </FieldDescription>
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-muted p-2 text-muted-foreground">
                  <ServerCogIcon className="size-5" />
                </div>
                <div>
                  <CardTitle>当前部署边界</CardTitle>
                  <CardDescription className="mt-1">
                    这些值影响进程资源，需要修改环境变量并重启。
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-x-5 gap-y-4 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                {runtimeFacts.map(([label, item]) => (
                  <div key={label}>
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="mt-1 font-medium tabular-nums">{item}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-5 flex items-center gap-2 rounded-lg border bg-muted/35 px-3 py-2.5 text-xs text-muted-foreground">
                {runtime.upstream_websockets ? (
                  <CheckCircle2Icon className="size-4 text-emerald-600" />
                ) : (
                  <GaugeIcon className="size-4" />
                )}
                Codex / xAI 上游 WebSocket：
                {runtime.upstream_websockets ? "已启用" : "已关闭"}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useMemo, useState } from "react"
import { RotateCcwIcon, SaveIcon } from "lucide-react"
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
import { StatStrip } from "@/components/workspace-ui"
import { api, type OutboundProxy } from "@/lib/api"

type RuntimeSettings = {
  routing_strategy: "round-robin" | "fill-first"
  credential_failure_threshold: number
  credential_cooldown_seconds: number
  system_proxy_id: string
  request_timeout_seconds: number
  max_request_mib: number
  request_bytes_in_flight_mib: number
  memory_reclaim_threshold_mib: number
  unpriced_model_policy: "allow" | "deny"
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
            label: "流量容量",
            value: `${runtime.max_in_flight} + ${runtime.max_queue}`,
          },
        ]}
      />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,.65fr)]">
        <div className="grid gap-5">
          <Card>
            <CardHeader>
              <CardTitle>凭据调度</CardTitle>
              <CardDescription>
                同一模型有多个账户时如何分流。上游错误原样返回，不会改写或重试。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <Field>
                  <FieldLabel>调度方式</FieldLabel>
                  <Select
                    items={{
                      "round-robin": "轮询均衡",
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
                        <SelectItem value="round-robin">轮询均衡</SelectItem>
                        <SelectItem value="fill-first">固定优先级</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    轮询适合共享容量；固定优先级适合主账户加备用账户。
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>凭据故障隔离</CardTitle>
              <CardDescription>
                连续失败的账户会暂时离开候选池，冷却后再由下一次请求验证。
              </CardDescription>
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
                  description="0 表示不隔离。非 0 时冷却结束后回到候选池。"
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
              <CardTitle>系统网络</CardTitle>
              <CardDescription>
                仅供 OAuth、公共价格目录等 Relay
                自身请求使用。推理流量在账户页单独选代理。
              </CardDescription>
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
                  账户代理在「出站代理」里维护，再到模型账户上绑定。
                </FieldDescription>
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>进程边界</CardTitle>
              <CardDescription>
                保存后立即生效，不必改环境变量或重启。默认按宽松上限运行。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <NumberField
                  id="request-timeout"
                  label="响应头超时"
                  suffix="秒"
                  description="只限制等待上游响应头，不会打断已经开始的 SSE 或 WebSocket。"
                  value={value.request_timeout_seconds}
                  min={1}
                  max={86400}
                  onChange={(next) => patch("request_timeout_seconds", next)}
                />
                <NumberField
                  id="max-request-mib"
                  label="请求体上限"
                  suffix="MiB"
                  description="单个推理请求体的上限。"
                  value={value.max_request_mib}
                  min={1}
                  max={65536}
                  onChange={(next) => patch("max_request_mib", next)}
                />
                <NumberField
                  id="in-flight-mib"
                  label="在途内存预算"
                  suffix="MiB"
                  description="所有在途请求体合计上限，必须不小于请求体上限。"
                  value={value.request_bytes_in_flight_mib}
                  min={value.max_request_mib}
                  max={262144}
                  onChange={(next) =>
                    patch("request_bytes_in_flight_mib", next)
                  }
                />
                <NumberField
                  id="reclaim-mib"
                  label="内存回收阈值"
                  suffix="MiB"
                  description="堆占用超过该值时才主动回收。调高可减少回收打扰。"
                  value={value.memory_reclaim_threshold_mib}
                  min={64}
                  max={524288}
                  onChange={(next) =>
                    patch("memory_reclaim_threshold_mib", next)
                  }
                />
                <Field>
                  <FieldLabel>未定价模型</FieldLabel>
                  <Select
                    items={{ allow: "允许", deny: "拒绝" }}
                    value={value.unpriced_model_policy}
                    onValueChange={(next) =>
                      next &&
                      patch(
                        "unpriced_model_policy",
                        next as RuntimeSettings["unpriced_model_policy"]
                      )
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="allow">允许</SelectItem>
                        <SelectItem value="deny">拒绝</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    允许时，尚未配置价格的模型仍可调用，只是不预留余额。
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel>上游 WebSocket</FieldLabel>
                  <Select
                    items={{ enabled: "已启用", disabled: "已关闭" }}
                    value={
                      value.upstream_websockets ? "enabled" : "disabled"
                    }
                    onValueChange={(next) =>
                      next && patch("upstream_websockets", next === "enabled")
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="enabled">已启用</SelectItem>
                        <SelectItem value="disabled">已关闭</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    关闭后目录不再推荐 WebSocket，客户端改走 HTTP 流式。
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </CardContent>
          </Card>
        </div>
      </div>

      {dirty ? (
        <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-background px-4 py-3">
          <p className="text-sm">有未保存的更改</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => saved && setValue(saved)}
            >
              <RotateCcwIcon /> 撤销
            </Button>
            <Button disabled={saving} onClick={() => void save()}>
              {saving ? <Spinner /> : <SaveIcon />}
              保存
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

import { useCallback, useEffect, useState, type FormEvent } from "react"
import { Button } from "@cloudflare/kumo/components/button"
import { Dialog } from "@cloudflare/kumo/components/dialog"
import { Field } from "@cloudflare/kumo/components/field"
import { Input } from "@cloudflare/kumo/components/input"
import { Select } from "@cloudflare/kumo/components/select"
import { SensitiveInput } from "@cloudflare/kumo/components/sensitive-input"
import { Switch } from "@cloudflare/kumo/components/switch"
import { Tabs } from "@cloudflare/kumo/components/tabs"
import { useAsyncResource } from "@/hooks/use-async-resource"
import {
  api,
  deleteRequest,
  postJSON,
  type OutboundProxy,
  type ProxyTestResult,
} from "@/lib/api"
import { errorMessage, toast } from "@/lib/toast"
import {
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  Page,
  Surface,
} from "@/console/kit"

type RuntimeSettings = {
  routing_strategy: string
  credential_failure_threshold: number
  system_proxy_id: string
  unpriced_model_policy: string
  upstream_websockets: boolean
} & Record<string, unknown>

export function AdminSettingsPage() {
  const [tab, setTab] = useState("runtime")
  const loadSettings = useCallback(async () => {
    const value = await api<{ settings: RuntimeSettings }>(
      "/api/admin/runtime/settings"
    )
    return value.settings
  }, [])
  const loadProxies = useCallback(async () => {
    const value = await api<{ items: OutboundProxy[] }>("/api/admin/proxies")
    return value.items ?? []
  }, [])
  const settings = useAsyncResource(loadSettings, {
    initialData: null,
    errorMessage: "无法读取运行时设置",
    onBackgroundError: (message) => toast.error(message),
  })
  const proxies = useAsyncResource(loadProxies, {
    initialData: [],
    errorMessage: "无法读取代理",
    onBackgroundError: (message) => toast.error(message),
  })
  const [proxyOpen, setProxyOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [websockets, setWebsockets] = useState(true)
  const [routingStrategy, setRoutingStrategy] = useState("round-robin")
  const [unpricedPolicy, setUnpricedPolicy] = useState("allow")
  const [systemProxyId, setSystemProxyId] = useState("direct")

  useEffect(() => {
    if (!settings.data) return
    setWebsockets(settings.data.upstream_websockets)
    setRoutingStrategy(settings.data.routing_strategy || "round-robin")
    setUnpricedPolicy(settings.data.unpriced_model_policy || "allow")
    setSystemProxyId(settings.data.system_proxy_id || "direct")
  }, [settings.data])

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!settings.data) return
    const form = new FormData(event.currentTarget)
    setPending(true)
    try {
      await api("/api/admin/runtime/settings", {
        method: "PATCH",
        body: JSON.stringify({
          ...settings.data,
          routing_strategy: routingStrategy,
          unpriced_model_policy: unpricedPolicy,
          system_proxy_id: systemProxyId === "direct" ? "" : systemProxyId,
          credential_failure_threshold: Number(
            form.get("credential_failure_threshold") || 3
          ),
          upstream_websockets: websockets,
        }),
      })
      toast.success("设置已保存")
      await settings.reload()
    } catch (cause) {
      toast.error(errorMessage(cause, "保存失败"))
    } finally {
      setPending(false)
    }
  }

  async function createProxy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    try {
      await postJSON("/api/admin/proxies", {
        name: String(form.get("name") ?? ""),
        url: String(form.get("url") ?? ""),
      })
      setProxyOpen(false)
      toast.success("代理已添加")
      await proxies.reload()
    } catch (cause) {
      toast.error(errorMessage(cause, "添加失败"))
    } finally {
      setPending(false)
    }
  }

  async function testProxy(id: string) {
    try {
      const result = await postJSON<ProxyTestResult>(
        `/api/admin/proxies/${id}/test`,
        {}
      )
      toast[result.ok ? "success" : "error"](
        result.ok
          ? `${result.ip || "已连通"} · ${result.latency_ms}ms`
          : result.error || "测试失败"
      )
    } catch (cause) {
      toast.error(errorMessage(cause, "测试失败"))
    }
  }

  async function removeProxy(id: string) {
    if (!window.confirm("删除代理后，引用它的账户会改为直连。")) return
    try {
      await deleteRequest(`/api/admin/proxies/${id}`)
      toast.success("代理已删除")
      await proxies.reload()
    } catch (cause) {
      toast.error(errorMessage(cause, "删除失败"))
    }
  }

  if (settings.loading && proxies.loading) return <LoadingState />

  return (
    <Page title="系统设置" description="凭据调度、系统代理和进程边界。">
      <Tabs
        variant="underline"
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: "runtime", label: "运行时" },
          { value: "proxies", label: "代理" },
        ]}
      />
      {tab === "runtime" ? (
        settings.error && !settings.data ? (
          <ErrorState
            message={settings.error}
            onRetry={() => void settings.reload(true)}
          />
        ) : settings.data ? (
          <Surface>
            <form
              className="flex max-w-xl flex-col gap-4"
              onSubmit={saveSettings}
            >
              <Select
                label="调度策略"
                value={routingStrategy}
                onValueChange={(value) =>
                  setRoutingStrategy(value ?? "round-robin")
                }
                items={{
                  "round-robin": "轮询",
                  fill: "填满再切",
                }}
              />
              <Select
                label="未定价模型"
                value={unpricedPolicy}
                onValueChange={(value) => setUnpricedPolicy(value ?? "allow")}
                items={{ allow: "允许", deny: "拒绝" }}
              />
              <Select
                label="系统代理"
                value={systemProxyId}
                onValueChange={(value) => setSystemProxyId(value ?? "direct")}
                items={{
                  direct: "直连",
                  ...Object.fromEntries(
                    proxies.data.map((item) => [item.id, item.name])
                  ),
                }}
              />
              <Field label="凭据失败阈值">
                <Input
                  name="credential_failure_threshold"
                  type="number"
                  defaultValue={settings.data.credential_failure_threshold}
                />
              </Field>
              <Switch
                label="上游 WebSocket"
                checked={websockets}
                onCheckedChange={setWebsockets}
              />
              <Button type="submit" variant="primary" loading={pending}>
                保存
              </Button>
            </form>
          </Surface>
        ) : (
          <LoadingState />
        )
      ) : (
        <Surface
          title={
            <div className="flex items-center justify-between">
              <span>出站代理</span>
              <Button
                size="sm"
                variant="primary"
                onClick={() => setProxyOpen(true)}
              >
                添加
              </Button>
            </div>
          }
        >
          {proxies.error && proxies.data.length === 0 ? (
            <ErrorState
              message={proxies.error}
              onRetry={() => void proxies.reload(true)}
            />
          ) : (
            <DataTable
              columns={["名称", "端点", "占用", ""]}
              empty={<EmptyState title="还没有代理" />}
              rows={proxies.data.map((item) => (
                <tr
                  key={item.id}
                  className="border-b border-kumo-hairline last:border-0"
                >
                  <td className="px-3 py-2">{item.name}</td>
                  <td className="px-3 py-2 font-mono text-[0.9em]">
                    {item.endpoint}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {item.account_use}
                    {item.system_use ? " · 系统" : ""}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void testProxy(item.id)}
                      >
                        测试
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary-destructive"
                        onClick={() => void removeProxy(item.id)}
                      >
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            />
          )}
        </Surface>
      )}

      <Dialog.Root open={proxyOpen} onOpenChange={setProxyOpen}>
        <Dialog>
          <Dialog.Title>添加代理</Dialog.Title>
          <form className="mt-4 flex flex-col gap-4" onSubmit={createProxy}>
            <Field label="名称">
              <Input name="name" required />
            </Field>
            <SensitiveInput
              label="代理地址"
              name="url"
              required
              description="认证信息不会返回浏览器。"
            />
            <div className="flex justify-end gap-2">
              <Dialog.Close
                render={<Button variant="secondary">取消</Button>}
              />
              <Button type="submit" variant="primary" loading={pending}>
                保存
              </Button>
            </div>
          </form>
        </Dialog>
      </Dialog.Root>
    </Page>
  )
}

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react"
import { ExternalLinkIcon, KeyRoundIcon, PlugIcon, RefreshCwIcon, SaveIcon, TerminalIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { QuotaSnapshot } from "@/components/quota-snapshot"
import { ApiError, api, deleteRequest, postJSON, type ParentSubscriptionView, type ProviderAccount } from "@/lib/api"

type OAuthProvider = "codex" | "anthropic" | "antigravity" | "kimi" | "xai"
type OAuthStart = {
  status: string
  url: string
  state: string
  provider: OAuthProvider
  label: string
  flow?: "device"
  user_code?: string
  expires_in?: number
}
type ProviderSettings = { request_retry: number; max_retry_interval: number; routing_strategy: string }

const oauthProviders: Array<{ id: OAuthProvider; label: string; description: string }> = [
  { id: "codex", label: "OpenAI Codex", description: "ChatGPT/Codex OAuth" },
  { id: "anthropic", label: "Anthropic", description: "Claude OAuth / setup token" },
  { id: "antigravity", label: "Antigravity", description: "Google Antigravity OAuth" },
  { id: "kimi", label: "Kimi", description: "Moonshot Kimi OAuth" },
  { id: "xai", label: "xAI", description: "Grok/xAI OAuth" },
]

const providerConfigs = [
  { path: "gemini-api-key", label: "Gemini API Key" },
  { path: "interactions-api-key", label: "Interactions API Key" },
  { path: "claude-api-key", label: "Claude API Key" },
  { path: "codex-api-key", label: "Codex API Key" },
  { path: "xai-api-key", label: "xAI API Key" },
  { path: "vertex-api-key", label: "Vertex API Key" },
  { path: "openai-compatibility", label: "OpenAI-compatible 端点" },
  { path: "oauth-model-alias", label: "OAuth 模型别名" },
  { path: "oauth-excluded-models", label: "OAuth 排除模型" },
  { path: "proxy-url", label: "全局上游代理" },
  { path: "ws-auth", label: "WebSocket 鉴权" },
  { path: "force-model-prefix", label: "强制模型前缀" },
  { path: "debug", label: "调试日志" },
  { path: "logging-to-file", label: "文件日志" },
  { path: "usage-statistics-enabled", label: "CPA 用量统计" },
  { path: "quota-exceeded/switch-project", label: "额度耗尽切换项目" },
  { path: "quota-exceeded/switch-preview-model", label: "额度耗尽切换预览模型" },
  { path: "plugins", label: "已安装插件", readOnly: true },
  { path: "plugin-store", label: "插件市场", readOnly: true },
  { path: "api-key-usage", label: "CPA Key 用量", readOnly: true },
  { path: "usage-queue", label: "用量事件队列", readOnly: true },
] as const

function isRoutingStrategy(value: unknown): value is ProviderSettings["routing_strategy"] {
  return value === "round-robin" || value === "fill-first"
}

function isProviderConfigPath(value: unknown): value is string {
  return typeof value === "string" && providerConfigs.some((item) => item.path === value)
}

export function ProvidersView() {
  const [accounts, setAccounts] = useState<ProviderAccount[]>([])
  const [parents, setParents] = useState<ParentSubscriptionView[]>([])
  const [loading, setLoading] = useState(true)
  const [oauth, setOAuth] = useState<OAuthStart | null>(null)
  const [pending, setPending] = useState(false)
  const [settings, setSettings] = useState<ProviderSettings | null>(null)
  const [gatewayKeys, setGatewayKeys] = useState("")
  const [configYAML, setConfigYAML] = useState("")
  const [advancedResult, setAdvancedResult] = useState("")
  const [configPath, setConfigPath] = useState<string>(providerConfigs[0].path)
  const [providerJSON, setProviderJSON] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [value, config, keys, parentValue] = await Promise.all([
        api<{ files: ProviderAccount[] }>("/api/admin/providers/accounts"),
        api<ProviderSettings>("/api/admin/providers/settings"),
        api<{ "api-keys": string[] }>("/api/admin/cpa/api-keys"),
        api<{ items: ParentSubscriptionView[] }>("/api/admin/subscriptions/parents"),
      ])
      setAccounts(value.files ?? [])
      setParents(parentValue.items ?? [])
      setSettings(config)
      setGatewayKeys((keys["api-keys"] ?? []).join("\n"))
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "无法读取 CPA 凭据")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => void load(), [load])

  const parentByCredential = useMemo(() => {
    const result = new Map<string, ParentSubscriptionView>()
    for (const parent of parents) {
      for (const key of [parent.item.cpa_auth_index, parent.item.cpa_auth_id, parent.item.cpa_auth_name]) {
        if (key) result.set(key, parent)
      }
    }
    return result
  }, [parents])

  async function syncQuota(parentID: string) {
    setPending(true)
    try {
      await postJSON(`/api/admin/subscriptions/parents/${parentID}/quota/sync`, {})
      toast.success("上游额度已刷新")
      await load()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "额度刷新失败")
    } finally {
      setPending(false)
    }
  }

  async function beginOAuth(provider: OAuthProvider) {
    setPending(true)
    try {
      const definition = oauthProviders.find((item) => item.id === provider)!
      const value = await postJSON<Omit<OAuthStart, "provider" | "label">>(`/api/admin/providers/${provider}/oauth`, {})
      setOAuth({ ...value, provider, label: definition.label })
      window.open(value.url, "_blank", "noopener,noreferrer")
      if (value.flow === "device") toast.info(value.user_code ? `设备验证码：${value.user_code}` : "请在授权页完成设备验证")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "无法启动 OAuth 登录")
    } finally {
      setPending(false)
    }
  }

  async function completeOAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!oauth) return
    const form = new FormData(event.currentTarget)
    setPending(true)
    try {
      if (oauth.flow !== "device") {
        try {
          await postJSON("/api/admin/providers/oauth/callback", {
            provider: oauth.provider,
            state: oauth.state,
            redirect_url: String(form.get("redirect_url") ?? ""),
          })
        } catch (cause) {
          // CPA returns 409 when a duplicated browser callback reaches a flow
          // that has already completed. The status endpoint is authoritative.
          if (!(cause instanceof ApiError) || cause.status !== 409) throw cause
        }
      }
      for (let attempt = 0; attempt < 60; attempt++) {
        const status = await api<{ status: string; error?: string }>(
          `/api/admin/providers/oauth/status?state=${encodeURIComponent(oauth.state)}`,
        )
        if (status.status === "ok") {
          toast.success(`${oauth.label} 账户已统一接入`)
          setOAuth(null)
          await load()
          return
        }
        if (status.status === "error") throw new Error(status.error || "OAuth 登录失败")
        await new Promise((resolve) => window.setTimeout(resolve, 2000))
      }
      toast.info("授权仍在处理，可稍后刷新账户列表")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "无法完成 OAuth 登录")
    } finally {
      setPending(false)
    }
  }

  async function toggle(account: ProviderAccount) {
    try {
      await api(`/api/admin/providers/accounts/${encodeURIComponent(account.name)}`, {
        method: "PATCH",
        body: JSON.stringify({ disabled: !account.disabled }),
      })
      await load()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "更新失败")
    }
  }

  async function remove(account: ProviderAccount) {
    if (!window.confirm(`确认从 CPA 删除凭据 ${account.name}？`)) return
    try {
      await deleteRequest(`/api/admin/providers/accounts/${encodeURIComponent(account.name)}`)
      toast.success("凭据已删除")
      await load()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "删除失败")
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    try {
      const value = await api<ProviderSettings>("/api/admin/providers/settings", {
        method: "PATCH",
        body: JSON.stringify({
          request_retry: Number(form.get("request_retry")),
          max_retry_interval: Number(form.get("max_retry_interval")),
          routing_strategy: settings?.routing_strategy,
        }),
      })
      setSettings(value)
      toast.success("CPA 运行策略已保存")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "保存失败")
    } finally {
      setPending(false)
    }
  }

  async function cpaText(path: string, init?: RequestInit) {
    const response = await fetch(`/api/admin/cpa/${path}`, { ...init, credentials: "include" })
    const text = await response.text()
    if (!response.ok) throw new Error(text || `CPA 请求失败 (${response.status})`)
    return text
  }

  async function saveGatewayKeys() {
    setPending(true)
    try {
      const keys = gatewayKeys.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
      await api("/api/admin/cpa/api-keys", { method: "PUT", body: JSON.stringify(keys) })
      toast.success("CLIProxyAPI 网关 API Keys 已保存")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "保存失败")
    } finally { setPending(false) }
  }

  async function loadYAML() {
    setPending(true)
    try { setConfigYAML(await cpaText("config.yaml")) }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : "读取配置失败") }
    finally { setPending(false) }
  }

  async function saveYAML() {
    if (!window.confirm("完整配置会立即重载 CLIProxyAPI，确认继续？")) return
    setPending(true)
    try {
      await cpaText("config.yaml", { method: "PUT", headers: { "Content-Type": "application/yaml" }, body: configYAML })
      toast.success("CLIProxyAPI 完整配置已保存")
      await load()
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : "保存配置失败") }
    finally { setPending(false) }
  }

  async function callAdvanced(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const method = String(form.get("method") || "GET")
    const path = String(form.get("path") || "").replace(/^\/+/, "")
    const body = String(form.get("body") || "").trim()
    setPending(true)
    try {
      const text = await cpaText(path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body || undefined })
      try { setAdvancedResult(JSON.stringify(JSON.parse(text), null, 2)) } catch { setAdvancedResult(text) }
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : "CPA 请求失败") }
    finally { setPending(false) }
  }

  async function loadProviderConfig(path = configPath) {
    setPending(true)
    try {
      const text = await cpaText(path)
      try { setProviderJSON(JSON.stringify(JSON.parse(text), null, 2)) } catch { setProviderJSON(text) }
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : "读取提供商配置失败") }
    finally { setPending(false) }
  }

  async function saveProviderConfig() {
    const definition = providerConfigs.find((item) => item.path === configPath)
    if (definition && "readOnly" in definition && definition.readOnly) return
    setPending(true)
    try {
      JSON.parse(providerJSON)
      await cpaText(configPath, { method: "PUT", headers: { "Content-Type": "application/json" }, body: providerJSON })
      toast.success("提供商配置已保存")
      await load()
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : "配置 JSON 无效") }
    finally { setPending(false) }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">模型账户</h1>
          <p className="text-sm text-muted-foreground">CLIProxyAPI 的凭据、协议、插件与运行配置中心。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCwIcon />刷新</Button>
          <Button onClick={() => void beginOAuth("codex")} disabled={pending}>{pending ? <Spinner /> : <PlugIcon />}连接 Codex</Button>
        </div>
      </div>

      {oauth && (
        <Card>
          <CardHeader>
            <CardTitle>完成 {oauth.label} 授权</CardTitle>
            <CardDescription>{oauth.flow === "device" ? "在授权页输入设备验证码并完成登录，然后点击检查授权状态。" : "授权后复制浏览器最终跳转地址并粘贴到下方。地址只用于完成本次 OAuth。"}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={completeOAuth}>
              <FieldGroup>
                {oauth.flow === "device" ? (
                  <Field>
                    <FieldLabel>设备验证码</FieldLabel>
                    <Input readOnly value={oauth.user_code || "授权链接已包含验证码"} className="font-mono" />
                    <FieldDescription>该流程由 CPA 在后台轮询，不需要粘贴 localhost 回调地址。</FieldDescription>
                  </Field>
                ) : <Field>
                  <FieldLabel htmlFor="redirect-url">回调地址</FieldLabel>
                  <Input id="redirect-url" name="redirect_url" type="url" placeholder="http://localhost:1455/auth/callback?code=…&state=…" required />
                  <FieldDescription>若授权页尚未打开，可点击右侧重新打开。</FieldDescription>
                </Field>}
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={pending}>{pending ? <Spinner /> : null}{oauth.flow === "device" ? "检查授权状态" : "提交并验证"}</Button>
                  <Button type="button" variant="outline" onClick={() => window.open(oauth.url, "_blank", "noopener,noreferrer")}>
                    <ExternalLinkIcon />打开授权页
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setOAuth(null)}>取消</Button>
                </div>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>CPA 凭据</CardTitle>
          <CardDescription>这里只展示 CPA 返回的脱敏元数据，不读取 token 或 refresh token。</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? <div className="flex justify-center py-12"><Spinner /></div> : (
            <Table>
              <TableHeader><TableRow><TableHead>账户</TableHead><TableHead>提供商</TableHead><TableHead>上游订阅额度</TableHead><TableHead>状态</TableHead><TableHead>请求</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
              <TableBody>
                {accounts.map((account) => {
                  const parent = parentByCredential.get(account.auth_index || "") ?? parentByCredential.get(account.id || "") ?? parentByCredential.get(account.name)
                  return <TableRow key={account.auth_index || account.id || account.name}>
                    <TableCell><div className="font-medium">{account.email || account.label || account.name}</div><div className="max-w-64 truncate text-xs text-muted-foreground">{account.name}</div></TableCell>
                    <TableCell>{account.provider || account.type}</TableCell>
                    <TableCell><QuotaSnapshot snapshot={parent?.item.quota_snapshot} status={parent?.item.quota_probe_status} error={parent?.item.quota_probe_error} observedAt={parent?.item.quota_observed_at} compact /></TableCell>
                    <TableCell><Badge variant={account.disabled || account.unavailable ? "secondary" : "default"}>{account.disabled ? "已停用" : account.unavailable ? "不可用" : account.status || "可用"}</Badge></TableCell>
                    <TableCell className="text-muted-foreground">{account.success ?? 0} / {account.failed ?? 0}</TableCell>
                    <TableCell><div className="flex justify-end gap-2">{parent ? <Button size="icon-sm" variant="outline" disabled={pending} aria-label="刷新上游额度" title="刷新上游额度" onClick={() => void syncQuota(parent.item.id)}><RefreshCwIcon /></Button> : null}<Button size="sm" variant="outline" onClick={() => void toggle(account)}>{account.disabled ? "启用" : "停用"}</Button><Button size="icon-sm" variant="ghost" aria-label="删除凭据" onClick={() => void remove(account)}><Trash2Icon /></Button></div></TableCell>
                  </TableRow>
                })}
                {!accounts.length && <TableRow><TableCell colSpan={6} className="h-24 text-center text-muted-foreground">尚未接入模型账户</TableCell></TableRow>}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {settings && (
        <Card>
          <CardHeader>
            <CardTitle>CPA 运行策略</CardTitle>
            <CardDescription>常用调度参数；下方高级区域可管理 CLIProxyAPI 的完整能力。</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={saveSettings}>
              <FieldGroup className="grid gap-4 md:grid-cols-3">
                <Field>
                  <FieldLabel htmlFor="request-retry">请求重试次数</FieldLabel>
                  <Input id="request-retry" name="request_retry" type="number" min="0" max="20" defaultValue={settings.request_retry} required />
                </Field>
                <Field>
                  <FieldLabel htmlFor="retry-interval">最大重试间隔（秒）</FieldLabel>
                  <Input id="retry-interval" name="max_retry_interval" type="number" min="0" max="3600" defaultValue={settings.max_retry_interval} required />
                </Field>
                <Field>
                  <FieldLabel htmlFor="routing-strategy">凭据调度策略</FieldLabel>
                  <Select
                    value={settings.routing_strategy}
                    onValueChange={(value) => {
                      if (isRoutingStrategy(value)) {
                        setSettings({ ...settings, routing_strategy: value })
                      }
                    }}
                  >
                    <SelectTrigger id="routing-strategy" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="round-robin">轮询</SelectItem>
                        <SelectItem value="fill-first">优先填满</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <div className="md:col-span-3"><Button type="submit" disabled={pending}>{pending ? <Spinner /> : null}保存策略</Button></div>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>OAuth 与账户验证</CardTitle><CardDescription>使用 CLIProxyAPI 原生认证流程接入不同提供商。授权页完成后，将最终 localhost 回调地址粘贴到上方。</CardDescription></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {oauthProviders.map((provider) => (
            <Button key={provider.id} variant="outline" className="h-auto justify-start py-3" disabled={pending} onClick={() => void beginOAuth(provider.id)}>
              <span className="flex flex-col items-start"><span>{provider.label}</span><span className="text-xs font-normal text-muted-foreground">{provider.description}</span></span>
            </Button>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><KeyRoundIcon className="size-4" />网关 API Keys</CardTitle><CardDescription>这些 Key 用于 RelayAPI 访问 CLIProxyAPI。每行一个；生产环境至少保留一个强随机 Key，并与 CPA_API_KEY 一致。</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Textarea value={gatewayKeys} onChange={(event) => setGatewayKeys(event.target.value)} rows={5} placeholder="sk-cpa-…" className="font-mono text-xs" />
          <div><Button onClick={() => void saveGatewayKeys()} disabled={pending}><SaveIcon />保存 API Keys</Button></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>CPA 功能配置</CardTitle><CardDescription>管理原生 API Key 提供商、OpenAI-compatible 端点、模型规则、代理、WebSocket、额度切换、日志、插件与 CPA 用量。内容使用 CPA 官方 JSON 结构，可完整保留高级字段。</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select
              value={configPath}
              onValueChange={(value) => {
                if (!isProviderConfigPath(value)) return
                setConfigPath(value)
                setProviderJSON("")
                void loadProviderConfig(value)
              }}
            >
              <SelectTrigger className="w-full sm:w-72"><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>{providerConfigs.map((item) => <SelectItem key={item.path} value={item.path}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
            <Button variant="outline" onClick={() => void loadProviderConfig()} disabled={pending}>读取配置</Button>
            <Button onClick={() => void saveProviderConfig()} disabled={pending || !providerJSON || Boolean(providerConfigs.find((item) => item.path === configPath && "readOnly" in item && item.readOnly))}><SaveIcon />保存配置</Button>
          </div>
          <Textarea value={providerJSON} onChange={(event) => setProviderJSON(event.target.value)} rows={14} spellCheck={false} placeholder="选择配置类型后点击读取配置" className="font-mono text-xs" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>完整 CPA 配置</CardTitle><CardDescription>直接编辑 config.yaml，可配置所有协议提供商、模型映射、OAuth 排除/别名、代理、插件和日志。敏感字段仅对管理员可见。</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex gap-2"><Button variant="outline" onClick={() => void loadYAML()} disabled={pending}>读取 YAML</Button><Button onClick={() => void saveYAML()} disabled={pending || !configYAML}><SaveIcon />保存并重载</Button></div>
          <Textarea value={configYAML} onChange={(event) => setConfigYAML(event.target.value)} rows={18} spellCheck={false} placeholder="点击“读取 YAML”加载当前配置" className="font-mono text-xs" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><TerminalIcon className="size-4" />高级管理接口</CardTitle><CardDescription>调用任意 /v0/management 路径，覆盖 Gemini、Claude、Codex、XAI、Vertex、OpenAI-compatible、插件市场、日志、模型别名及未来新增能力。</CardDescription></CardHeader>
        <CardContent>
          <form onSubmit={callAdvanced} className="flex flex-col gap-3">
            <div className="grid gap-3 md:grid-cols-[10rem_1fr]">
              <Select name="method" defaultValue="GET"><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => <SelectItem key={method} value={method}>{method}</SelectItem>)}</SelectGroup></SelectContent></Select>
              <Input name="path" required placeholder="例如 claude-api-key、plugins 或 oauth-model-alias" className="font-mono" />
            </div>
            <Textarea name="body" rows={7} spellCheck={false} placeholder={'可选 JSON 请求体，例如 {"value": true}'} className="font-mono text-xs" />
            <div><Button type="submit" disabled={pending}>{pending ? <Spinner /> : <TerminalIcon />}执行</Button></div>
            {advancedResult && <Textarea readOnly value={advancedResult} rows={12} className="font-mono text-xs" />}
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

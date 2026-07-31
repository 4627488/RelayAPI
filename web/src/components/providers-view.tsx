import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react"
import {
  ActivityIcon,
  BoxesIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CloudCogIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  Layers3Icon,
  PlugIcon,
  RefreshCwIcon,
  RouteIcon,
  SaveIcon,
  SearchIcon,
  ServerCogIcon,
  Settings2Icon,
  ShieldCheckIcon,
  TerminalIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { QuotaSnapshot } from "@/components/quota-snapshot"
import { AddProviderAccountDialog, type AddProviderMode, type OAuthProvider } from "@/components/add-provider-account-dialog"
import { ApiError, api, deleteRequest, postJSON, type ParentSubscriptionView, type ProviderAccount } from "@/lib/api"

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

function isRoutingStrategy(value: unknown): value is ProviderSettings["routing_strategy"] {
  return value === "round-robin" || value === "fill-first"
}

function accountName(account: ProviderAccount) {
  return account.email || account.label || account.name
}

function accountHealthy(account: ProviderAccount) {
  return !account.disabled && !account.unavailable
}

function accountState(account: ProviderAccount) {
  if (account.disabled) return { label: "已停用", tone: "secondary" as const }
  if (account.unavailable) return { label: "不可用", tone: "destructive" as const }
  return { label: account.status || "运行正常", tone: "default" as const }
}

function collectModelNames(value: unknown, result = new Set<string>(), acceptString = true) {
  if (typeof value === "string") {
    if (acceptString && value.trim()) result.add(value.trim())
    return result
  }
  if (Array.isArray(value)) {
    for (const item of value) collectModelNames(item, result, acceptString)
    return result
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (["model", "id", "name"].includes(key) && typeof item === "string") {
        result.add(item)
      } else if (["models", "data", "items"].includes(key)) {
        collectModelNames(item, result, true)
      } else if (item && typeof item === "object") {
        collectModelNames(item, result, false)
      }
    }
  }
  return result
}

export function ProvidersView() {
  const [accounts, setAccounts] = useState<ProviderAccount[]>([])
  const [parents, setParents] = useState<ParentSubscriptionView[]>([])
  const [loading, setLoading] = useState(true)
  const [oauth, setOAuth] = useState<OAuthStart | null>(null)
  const [pending, setPending] = useState(false)
  const [settings, setSettings] = useState<ProviderSettings | null>(null)
  const [proxyURL, setProxyURL] = useState("")
  const [gatewayKeys, setGatewayKeys] = useState("")
  const [configYAML, setConfigYAML] = useState("")
  const [advancedResult, setAdvancedResult] = useState("")
  const [accountWarning, setAccountWarning] = useState("")
  const [search, setSearch] = useState("")
  const [providerFilter, setProviderFilter] = useState("all")
  const [statusFilter, setStatusFilter] = useState("all")
  const [sourceFilter, setSourceFilter] = useState("all")
  const [selectedAccount, setSelectedAccount] = useState<ProviderAccount | null>(null)
  const [accountModels, setAccountModels] = useState<string[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  const [connectProvider, setConnectProvider] = useState<OAuthProvider>("codex")
  const [connectMode, setConnectMode] = useState<AddProviderMode>("oauth")

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [accountResult, settingsResult, keysResult, parentResult, proxyResult] = await Promise.allSettled([
        api<{ files: ProviderAccount[]; warning?: string }>("/api/admin/providers/accounts"),
        api<ProviderSettings>("/api/admin/providers/settings"),
        api<{ "api-keys": string[] }>("/api/admin/cpa/api-keys"),
        api<{ items: ParentSubscriptionView[] }>("/api/admin/subscriptions/parents"),
        api<{ "proxy-url": string }>("/api/admin/cpa/proxy-url"),
      ])
      if (accountResult.status === "fulfilled") {
        setAccounts(accountResult.value.files ?? [])
        setAccountWarning(accountResult.value.warning ?? "")
      } else {
        toast.error(accountResult.reason instanceof Error ? accountResult.reason.message : "无法读取模型账户")
      }
      if (settingsResult.status === "fulfilled") setSettings(settingsResult.value)
      if (keysResult.status === "fulfilled") setGatewayKeys((keysResult.value["api-keys"] ?? []).join("\n"))
      if (parentResult.status === "fulfilled") setParents(parentResult.value.items ?? [])
      if (proxyResult.status === "fulfilled") setProxyURL(proxyResult.value["proxy-url"] ?? "")
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

  const providers = useMemo(
    () => [...new Set(accounts.map((account) => account.provider || account.type).filter(Boolean))].sort(),
    [accounts],
  )
  const overview = useMemo(() => {
    const healthy = accounts.filter(accountHealthy).length
    const disabled = accounts.filter((account) => account.disabled).length
    const unavailable = accounts.filter((account) => account.unavailable && !account.disabled).length
    const success = accounts.reduce((total, account) => total + (account.success ?? 0), 0)
    const failed = accounts.reduce((total, account) => total + (account.failed ?? 0), 0)
    const oauthCount = accounts.filter((account) => account.source !== "config").length
    const configCount = accounts.length - oauthCount
    const linked = accounts.filter((account) => {
      const keys = [account.auth_index, account.id, account.name].filter(Boolean) as string[]
      return keys.some((key) => parentByCredential.has(key))
    }).length
    return {
      healthy,
      disabled,
      unavailable,
      success,
      failed,
      oauthCount,
      configCount,
      linked,
      successRate: success + failed > 0 ? (success / (success + failed)) * 100 : 0,
    }
  }, [accounts, parentByCredential])
  const filteredAccounts = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return accounts.filter((account) => {
      const provider = account.provider || account.type || ""
      if (providerFilter !== "all" && provider !== providerFilter) return false
      if (sourceFilter !== "all" && (account.source || "oauth") !== sourceFilter) return false
      if (statusFilter === "healthy" && !accountHealthy(account)) return false
      if (statusFilter === "disabled" && !account.disabled) return false
      if (statusFilter === "unavailable" && !account.unavailable) return false
      if (!needle) return true
      return [accountName(account), account.name, provider, account.auth_index, account.status_message]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle))
    })
  }, [accounts, providerFilter, search, sourceFilter, statusFilter])

  const selectedParent = useMemo(() => {
    if (!selectedAccount) return undefined
    return parentByCredential.get(selectedAccount.auth_index || "")
      ?? parentByCredential.get(selectedAccount.id || "")
      ?? parentByCredential.get(selectedAccount.name)
  }, [parentByCredential, selectedAccount])

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

  async function beginOAuth(provider: OAuthProvider, proxyURL = "") {
    setPending(true)
    try {
      const definition = oauthProviders.find((item) => item.id === provider)!
      const value = await postJSON<Omit<OAuthStart, "provider" | "label">>(`/api/admin/providers/${provider}/oauth`, { proxy_url: proxyURL })
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

  function openConnect(provider: OAuthProvider = "codex", mode: AddProviderMode = "oauth") {
    setConnectProvider(provider)
    setConnectMode(mode)
    setConnectOpen(true)
  }

  async function inspectAccount(account: ProviderAccount) {
    setSelectedAccount(account)
    setAccountModels(account.models ?? [])
    if (account.source === "config") {
      setModelsLoading(false)
      return
    }
    setModelsLoading(true)
    try {
      const value = await api<unknown>(`/api/admin/providers/accounts/${encodeURIComponent(account.name)}/models`)
      setAccountModels([...collectModelNames(value)].sort())
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "无法读取账户模型")
    } finally {
      setModelsLoading(false)
    }
  }

  async function toggle(account: ProviderAccount) {
    try {
      await api(`/api/admin/providers/accounts/${encodeURIComponent(account.name)}`, {
        method: "PATCH",
        body: JSON.stringify({ disabled: !account.disabled }),
      })
      await load()
      if (selectedAccount?.name === account.name) setSelectedAccount(null)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "更新失败")
    }
  }

  async function remove(account: ProviderAccount) {
    if (!window.confirm(`确认从 CPA 删除“${accountName(account)}”？此操作会立即停止该账户的路由能力。`)) return
    try {
      await deleteRequest(`/api/admin/providers/accounts/${encodeURIComponent(account.name)}`)
      toast.success("凭据已删除")
      await load()
      if (selectedAccount?.name === account.name) setSelectedAccount(null)
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

  async function saveProxyURL(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = proxyURL.trim()
    if (!value) {
      toast.error("请输入代理地址；如需停用代理，请使用“清除代理”")
      return
    }
    if (value !== "direct" && value !== "none" && !/^(socks5h?|https?):\/\//i.test(value)) {
      toast.error("代理地址需使用 socks5://、socks5h://、http://、https://，或填写 direct")
      return
    }
    setPending(true)
    try {
      await api("/api/admin/cpa/proxy-url", { method: "PUT", body: JSON.stringify({ value }) })
      setProxyURL(value)
      toast.success("CPA 全局代理已保存；请重新发起尚未完成的 OAuth 验证")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "代理保存失败")
    } finally {
      setPending(false)
    }
  }

  async function clearProxyURL() {
    if (!window.confirm("确认清除 CPA 全局代理？后续出站请求将改为使用服务器默认网络。")) return
    setPending(true)
    try {
      await api("/api/admin/cpa/proxy-url", { method: "DELETE" })
      setProxyURL("")
      toast.success("CPA 全局代理已清除")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "代理清除失败")
    } finally {
      setPending(false)
    }
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

  return (
    <div className="flex flex-col gap-6">
      <Card className="relative overflow-hidden border-primary/15 bg-gradient-to-br from-primary/10 via-card to-card">
        <div className="pointer-events-none absolute -top-24 -right-20 size-72 rounded-full bg-primary/10 blur-3xl" />
        <CardContent className="relative flex flex-col gap-5 py-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-2xl space-y-3">
            <Badge variant="outline" className="bg-background/70">
              <CloudCogIcon /> CLIProxyAPI Control Plane
            </Badge>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">模型账户</h1>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                集中管理凭据健康度、上游额度、协议接入、调度策略与插件运行配置。
              </p>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5"><ShieldCheckIcon className="size-3.5 text-emerald-500" />敏感令牌由 CPA 托管</span>
              <span className="flex items-center gap-1.5"><RouteIcon className="size-3.5 text-primary" />支持多凭据路由</span>
              <span className="flex items-center gap-1.5"><BoxesIcon className="size-3.5 text-primary" />协议与插件统一配置</span>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button variant="outline" className="bg-background/70" onClick={() => void load()} disabled={loading}>
              {loading ? <Spinner /> : <RefreshCwIcon />}刷新状态
            </Button>
            <Button onClick={() => openConnect("codex")} disabled={pending}>
              {pending ? <Spinner /> : <PlugIcon />}添加账户
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardContent className="flex items-center justify-between py-5">
            <div><p className="text-xs text-muted-foreground">已接入账户</p><p className="mt-1 text-2xl font-semibold tabular-nums">{accounts.length}</p><p className="mt-1 text-xs text-muted-foreground">{overview.oauthCount} OAuth · {overview.configCount} Key/端点</p></div>
            <div className="rounded-xl bg-primary/10 p-3 text-primary"><Layers3Icon className="size-5" /></div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between py-5">
            <div><p className="text-xs text-muted-foreground">运行正常</p><p className="mt-1 text-2xl font-semibold tabular-nums">{overview.healthy}</p><p className="mt-1 text-xs text-muted-foreground">{overview.disabled} 停用 · {overview.unavailable} 异常</p></div>
            <div className="rounded-xl bg-emerald-500/10 p-3 text-emerald-600"><CheckCircle2Icon className="size-5" /></div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between py-5">
            <div><p className="text-xs text-muted-foreground">OAuth 请求成功率</p><p className="mt-1 text-2xl font-semibold tabular-nums">{overview.successRate.toFixed(1)}%</p><p className="mt-1 text-xs text-muted-foreground">{overview.success.toLocaleString()} 成功 · {overview.failed.toLocaleString()} 失败</p></div>
            <div className="rounded-xl bg-sky-500/10 p-3 text-sky-600"><ActivityIcon className="size-5" /></div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between py-5">
            <div><p className="text-xs text-muted-foreground">提供商覆盖</p><p className="mt-1 text-2xl font-semibold tabular-nums">{providers.length}</p><p className="mt-1 text-xs text-muted-foreground">{overview.linked} 个账户已关联订阅额度</p></div>
            <div className="rounded-xl bg-violet-500/10 p-3 text-violet-600"><BoxesIcon className="size-5" /></div>
          </CardContent>
        </Card>
      </div>

      {oauth && (
        <Card className="border-primary/30">
          <CardHeader className="border-b bg-primary/5">
            <div className="flex items-start gap-3">
              <div className="rounded-lg bg-primary/10 p-2 text-primary"><PlugIcon className="size-4" /></div>
              <div><CardTitle>完成 {oauth.label} 授权</CardTitle><CardDescription>{oauth.flow === "device" ? "在授权页输入设备验证码并完成登录，然后检查授权状态。" : "授权后复制浏览器最终跳转地址并粘贴到下方。地址只用于完成本次 OAuth。"}</CardDescription></div>
            </div>
          </CardHeader>
          <CardContent className="pt-5">
            <form onSubmit={completeOAuth}>
              <FieldGroup>
                {oauth.flow === "device" ? (
                  <Field>
                    <FieldLabel>设备验证码</FieldLabel>
                    <Input readOnly value={oauth.user_code || "授权链接已包含验证码"} className="font-mono text-base tracking-widest" />
                    <FieldDescription>该流程由 CPA 在后台轮询，不需要粘贴 localhost 回调地址。</FieldDescription>
                  </Field>
                ) : (
                  <Field>
                    <FieldLabel htmlFor="redirect-url">回调地址</FieldLabel>
                    <Input id="redirect-url" name="redirect_url" type="url" placeholder="http://localhost:1455/auth/callback?code=…&state=…" required />
                    <FieldDescription>若授权页尚未打开，可点击右侧重新打开。</FieldDescription>
                  </Field>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={pending}>{pending ? <Spinner /> : null}{oauth.flow === "device" ? "检查授权状态" : "提交并验证"}</Button>
                  <Button type="button" variant="outline" onClick={() => window.open(oauth.url, "_blank", "noopener,noreferrer")}><ExternalLinkIcon />打开授权页</Button>
                  <Button type="button" variant="ghost" onClick={() => setOAuth(null)}>取消</Button>
                </div>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      )}

      {accountWarning && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span>{accountWarning}。OAuth 账户仍可管理，但 Key 账户列表可能不完整。</span>
        </div>
      )}

      <Tabs defaultValue="accounts" className="gap-4">
        <TabsList className="grid h-auto w-full grid-cols-3 gap-1 p-1 lg:w-fit">
          <TabsTrigger value="accounts" className="px-3 py-1.5"><Layers3Icon />账户中心</TabsTrigger>
          <TabsTrigger value="runtime" className="px-3 py-1.5"><ServerCogIcon />运行策略</TabsTrigger>
          <TabsTrigger value="advanced" className="px-3 py-1.5"><Settings2Icon />高级配置</TabsTrigger>
        </TabsList>

        <TabsContent value="accounts" className="space-y-4">
          <Card>
            <CardContent className="flex flex-col gap-3 py-4 lg:flex-row lg:items-center">
              <InputGroup className="lg:max-w-md">
                <InputGroupAddon><SearchIcon /></InputGroupAddon>
                <InputGroupInput value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索邮箱、凭据名、提供商或状态…" />
              </InputGroup>
              <div className="grid grid-cols-2 gap-2 sm:flex">
                <Select value={sourceFilter} onValueChange={(value) => { if (value) setSourceFilter(value) }}>
                  <SelectTrigger className="w-full sm:w-40"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup><SelectItem value="all">全部账户类型</SelectItem><SelectItem value="oauth">OAuth 订阅</SelectItem><SelectItem value="config">API Key / 端点</SelectItem></SelectGroup></SelectContent>
                </Select>
                <Select value={providerFilter} onValueChange={(value) => { if (value) setProviderFilter(value) }}>
                  <SelectTrigger className="w-full sm:w-44"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup><SelectItem value="all">全部提供商</SelectItem>{providers.map((provider) => <SelectItem key={provider} value={provider}>{provider}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
                <Select value={statusFilter} onValueChange={(value) => { if (value) setStatusFilter(value) }}>
                  <SelectTrigger className="w-full sm:w-36"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup><SelectItem value="all">全部状态</SelectItem><SelectItem value="healthy">运行正常</SelectItem><SelectItem value="disabled">已停用</SelectItem><SelectItem value="unavailable">不可用</SelectItem></SelectGroup></SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground lg:ml-auto">显示 {filteredAccounts.length} / {accounts.length} 个账户</p>
            </CardContent>
          </Card>

          {loading ? (
            <Card><CardContent className="flex justify-center py-20"><Spinner /></CardContent></Card>
          ) : filteredAccounts.length ? (
            <div className="grid gap-4 xl:grid-cols-2">
              {filteredAccounts.map((account) => {
                const parent = parentByCredential.get(account.auth_index || "") ?? parentByCredential.get(account.id || "") ?? parentByCredential.get(account.name)
                const state = accountState(account)
                const total = (account.success ?? 0) + (account.failed ?? 0)
                const successRate = total ? ((account.success ?? 0) / total) * 100 : 0
                return (
                  <Card key={account.auth_index || account.id || account.name} className="overflow-hidden transition-colors hover:border-primary/30">
                    <CardHeader className="border-b bg-muted/20">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-3">
                          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-background text-sm font-semibold uppercase text-primary shadow-sm">
                            {(account.provider || account.type || "?").slice(0, 2)}
                          </div>
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <CardTitle className="truncate">{accountName(account)}</CardTitle>
                              <Badge variant="outline" className="shrink-0">{account.source === "config" ? account.type || "API Key" : "OAuth"}</Badge>
                            </div>
                            <CardDescription className="mt-1 truncate font-mono text-xs">{account.source === "config" ? account.base_url || account.config_path : account.name}</CardDescription>
                          </div>
                        </div>
                        <Badge variant={state.tone}>{state.label}</Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-5 pt-5">
                      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                        <div><p className="text-xs text-muted-foreground">提供商</p><p className="mt-1 font-medium">{account.provider || account.type || "未知"}</p></div>
                        <div><p className="text-xs text-muted-foreground">凭据类型</p><p className="mt-1 font-medium">{account.source === "config" ? account.type || "API Key" : "OAuth 订阅"}</p></div>
                        <div className="col-span-2 sm:col-span-1"><p className="text-xs text-muted-foreground">{account.source === "config" ? "模型配置" : "额度关联"}</p><p className="mt-1 font-medium">{account.source === "config" ? `${account.models?.length ?? 0} 个模型` : parent ? parent.item.name : "尚未关联"}</p></div>
                      </div>
                      {account.source === "config" ? (
                        <div className="rounded-lg border bg-muted/15 p-3">
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                            <span><span className="text-muted-foreground">Key 数量：</span><span className="font-medium">{account.key_count || 1}</span></span>
                            {account.prefix && <span><span className="text-muted-foreground">模型前缀：</span><span className="font-mono font-medium">{account.prefix}</span></span>}
                          </div>
                          <div className="mt-3 flex flex-wrap gap-1.5">
                            {account.models?.length ? account.models.slice(0, 6).map((model) => <Badge key={model} variant="outline" className="font-mono font-normal">{model}</Badge>) : <span className="text-xs text-muted-foreground">使用 CPA 提供商默认模型能力</span>}
                            {(account.models?.length ?? 0) > 6 && <Badge variant="secondary">+{(account.models?.length ?? 0) - 6}</Badge>}
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="space-y-2">
                            <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">请求成功率</span><span className="font-medium tabular-nums">{successRate.toFixed(1)}% · {account.success ?? 0}/{total}</span></div>
                            <Progress value={successRate} />
                          </div>
                          <div className="rounded-lg border bg-muted/15 p-3">
                            <div className="mb-2 flex items-center justify-between"><span className="text-xs font-medium">上游订阅额度</span>{parent && <Badge variant="outline">{parent.item.capacity_mode}</Badge>}</div>
                            <QuotaSnapshot snapshot={parent?.item.quota_snapshot} status={parent?.item.quota_probe_status} error={parent?.item.quota_probe_error} observedAt={parent?.item.quota_observed_at} compact />
                          </div>
                        </>
                      )}
                      {account.status_message && (
                        <div className="flex gap-2 rounded-lg bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
                          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" /><span>{account.status_message}</span>
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
                        {account.can_inspect !== false && <Button size="sm" variant="outline" onClick={() => void inspectAccount(account)}>查看详情<ChevronRightIcon /></Button>}
                        {parent && <Button size="sm" variant="outline" disabled={pending} onClick={() => void syncQuota(parent.item.id)}><RefreshCwIcon />同步额度</Button>}
                        <div className="ml-auto flex gap-2">
                          {account.can_toggle !== false && <Button size="sm" variant="outline" onClick={() => void toggle(account)}>{account.disabled ? "启用" : "停用"}</Button>}
                          {account.can_delete !== false && <Button size="icon-sm" variant="ghost" aria-label={`删除 ${accountName(account)}`} onClick={() => void remove(account)}><Trash2Icon /></Button>}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          ) : (
            <Card>
              <CardContent className="py-14">
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><SearchIcon /></EmptyMedia>
                    <EmptyTitle>{accounts.length ? "没有符合筛选条件的账户" : "尚未接入模型账户"}</EmptyTitle>
                    <EmptyDescription>{accounts.length ? "尝试清除搜索词或切换筛选条件。" : "通过 OAuth 或提供商 API Key 接入第一个上游账户。"}</EmptyDescription>
                  </EmptyHeader>
                  {!accounts.length && <Button onClick={() => openConnect("codex")}><PlugIcon />接入账户</Button>}
                </Empty>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="runtime" className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
            {settings && (
              <Card>
                <CardHeader><CardTitle className="flex items-center gap-2"><RouteIcon className="size-4" />CPA 运行策略</CardTitle><CardDescription>设置失败重试和多凭据调度方式，保存后立即生效。</CardDescription></CardHeader>
                <CardContent>
                  <form onSubmit={saveSettings}>
                    <FieldGroup className="grid gap-4 md:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor="request-retry">请求重试次数</FieldLabel>
                        <Input id="request-retry" name="request_retry" type="number" min="0" max="20" defaultValue={settings.request_retry} required />
                        <FieldDescription>单次请求允许切换凭据重试的最大次数。</FieldDescription>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="retry-interval">最大重试间隔（秒）</FieldLabel>
                        <Input id="retry-interval" name="max_retry_interval" type="number" min="0" max="3600" defaultValue={settings.max_retry_interval} required />
                        <FieldDescription>控制退避上限，避免故障账户被高频重试。</FieldDescription>
                      </Field>
                      <Field className="md:col-span-2">
                        <FieldLabel htmlFor="routing-strategy">凭据调度策略</FieldLabel>
                        <Select value={settings.routing_strategy} onValueChange={(value) => { if (isRoutingStrategy(value)) setSettings({ ...settings, routing_strategy: value }) }}>
                          <SelectTrigger id="routing-strategy" className="w-full"><SelectValue /></SelectTrigger>
                          <SelectContent><SelectGroup><SelectItem value="round-robin">轮询：均匀分散请求</SelectItem><SelectItem value="fill-first">优先填满：集中使用首选凭据</SelectItem></SelectGroup></SelectContent>
                        </Select>
                      </Field>
                      <div className="md:col-span-2"><Button type="submit" disabled={pending}>{pending ? <Spinner /> : <SaveIcon />}保存运行策略</Button></div>
                    </FieldGroup>
                  </form>
                </CardContent>
              </Card>
            )}
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><KeyRoundIcon className="size-4" />网关 API Keys</CardTitle><CardDescription>RelayAPI 访问 CLIProxyAPI 使用的 Key。每行一个，并与 CPA_API_KEY 保持一致。</CardDescription></CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Textarea value={gatewayKeys} onChange={(event) => setGatewayKeys(event.target.value)} rows={8} placeholder="sk-cpa-…" className="font-mono text-xs" />
                <div className="flex items-center justify-between gap-3"><p className="text-xs text-muted-foreground">{gatewayKeys.split(/\r?\n/).filter((item) => item.trim()).length} 个 Key</p><Button onClick={() => void saveGatewayKeys()} disabled={pending}><SaveIcon />保存 Keys</Button></div>
              </CardContent>
            </Card>
            <Card className="xl:col-span-2">
              <CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheckIcon className="size-4" />CPA 全局代理</CardTitle><CardDescription>用于 OAuth 换取令牌、账户验证及 CPA 的其他出站请求。请在发起 OAuth 前配置。</CardDescription></CardHeader>
              <CardContent>
                <form onSubmit={saveProxyURL}>
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="global-proxy-url">代理地址</FieldLabel>
                      <Input id="global-proxy-url" value={proxyURL} onChange={(event) => setProxyURL(event.target.value)} placeholder="socks5://用户名:密码@代理地址:1080" autoComplete="off" spellCheck={false} className="font-mono" />
                      <FieldDescription>支持 socks5://、socks5h://、http://、https://；填写 direct 可强制直连。代理凭据会保存到 CPA 配置。</FieldDescription>
                    </Field>
                    <div className="flex flex-wrap gap-2">
                      <Button type="submit" disabled={pending}>{pending ? <Spinner /> : <SaveIcon />}保存全局代理</Button>
                      <Button type="button" variant="outline" onClick={() => void clearProxyURL()} disabled={pending || !proxyURL}><Trash2Icon />清除代理</Button>
                    </div>
                  </FieldGroup>
                </form>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="advanced" className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><CloudCogIcon className="size-4" />原始 CPA 配置</CardTitle><CardDescription>仅用于迁移和故障排查。日常账户接入请使用顶部“添加账户”；保存 YAML 会立即重载 CLIProxyAPI。</CardDescription></CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex gap-2"><Button variant="outline" onClick={() => void loadYAML()} disabled={pending}>读取 YAML</Button><Button onClick={() => void saveYAML()} disabled={pending || !configYAML}><SaveIcon />保存并重载</Button></div>
                <Textarea value={configYAML} onChange={(event) => setConfigYAML(event.target.value)} rows={18} spellCheck={false} placeholder="点击“读取 YAML”加载当前配置" className="font-mono text-xs" />
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><TerminalIcon className="size-4" />诊断管理接口</CardTitle><CardDescription>面向故障排查调用任意 /v0/management 路径，不作为日常账户配置入口。</CardDescription></CardHeader>
              <CardContent>
                <form onSubmit={callAdvanced} className="flex flex-col gap-3">
                  <div className="grid gap-3 md:grid-cols-[9rem_1fr]">
                    <Select name="method" defaultValue="GET"><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => <SelectItem key={method} value={method}>{method}</SelectItem>)}</SelectGroup></SelectContent></Select>
                    <Input name="path" required placeholder="例如 plugins 或 oauth-model-alias" className="font-mono" />
                  </div>
                  <Textarea name="body" rows={7} spellCheck={false} placeholder={'可选 JSON 请求体，例如 {"value": true}'} className="font-mono text-xs" />
                  <div><Button type="submit" disabled={pending}>{pending ? <Spinner /> : <TerminalIcon />}执行请求</Button></div>
                  {advancedResult && <Textarea readOnly value={advancedResult} rows={12} className="font-mono text-xs" />}
                </form>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      <AddProviderAccountDialog
        key={`${connectProvider}:${connectMode}`}
        open={connectOpen}
        onOpenChange={setConnectOpen}
        initialOAuthProvider={connectProvider}
        initialMode={connectMode}
        onStartOAuth={(provider, proxyURL) => void beginOAuth(provider, proxyURL)}
        onSaved={() => load()}
      />

      <Dialog open={Boolean(selectedAccount)} onOpenChange={(open) => { if (!open) setSelectedAccount(null) }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          {selectedAccount && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <div className="flex size-11 items-center justify-center rounded-xl border bg-muted/30 font-semibold uppercase text-primary">
                    {(selectedAccount.provider || selectedAccount.type || "?").slice(0, 2)}
                  </div>
                  <div className="min-w-0"><DialogTitle className="truncate text-lg">{accountName(selectedAccount)}</DialogTitle><DialogDescription className="truncate font-mono text-xs">{selectedAccount.name}</DialogDescription></div>
                  <Badge className="ml-auto" variant={accountState(selectedAccount).tone}>{accountState(selectedAccount).label}</Badge>
                </div>
              </DialogHeader>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">提供商</p><p className="mt-1 font-medium">{selectedAccount.provider || selectedAccount.type || "未知"}</p></div>
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{selectedAccount.source === "config" ? "凭据类型" : "Auth Index"}</p><p className="mt-1 truncate font-mono text-xs">{selectedAccount.source === "config" ? selectedAccount.type || "API Key" : selectedAccount.auth_index || selectedAccount.id || "—"}</p></div>
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{selectedAccount.source === "config" ? "Key 数量" : "累计请求"}</p><p className="mt-1 font-medium tabular-nums">{selectedAccount.source === "config" ? selectedAccount.key_count || 1 : ((selectedAccount.success ?? 0) + (selectedAccount.failed ?? 0)).toLocaleString()}</p></div>
              </div>
              {selectedAccount.source === "config" ? (
                <div className="grid gap-3 rounded-xl border bg-muted/15 p-4 sm:grid-cols-2">
                  <div><p className="text-xs text-muted-foreground">Base URL</p><p className="mt-1 break-all font-mono text-xs">{selectedAccount.base_url || "CPA 提供商默认端点"}</p></div>
                  <div><p className="text-xs text-muted-foreground">模型前缀</p><p className="mt-1 font-mono text-xs">{selectedAccount.prefix || "未设置"}</p></div>
                </div>
              ) : (
                <div className="rounded-xl border bg-muted/15 p-4">
                  <div className="mb-3 flex items-center justify-between"><p className="font-medium">上游额度与订阅</p>{selectedParent && <Badge variant="outline">{selectedParent.item.name}</Badge>}</div>
                  <QuotaSnapshot snapshot={selectedParent?.item.quota_snapshot} status={selectedParent?.item.quota_probe_status} error={selectedParent?.item.quota_probe_error} observedAt={selectedParent?.item.quota_observed_at} />
                </div>
              )}
              <div>
                <div className="mb-3 flex items-center justify-between"><div><p className="font-medium">可用模型</p><p className="text-xs text-muted-foreground">{selectedAccount.source === "config" ? "此 Key/端点显式配置的模型；为空时使用 CPA 默认能力。" : "由 CLIProxyAPI 实时返回的账户模型能力。"}</p></div><Badge variant="secondary">{accountModels.length}</Badge></div>
                {modelsLoading ? (
                  <div className="flex justify-center rounded-xl border py-10"><Spinner /></div>
                ) : accountModels.length ? (
                  <div className="flex max-h-56 flex-wrap content-start gap-2 overflow-y-auto rounded-xl border bg-muted/10 p-3">
                    {accountModels.map((model) => <Badge key={model} variant="outline" className="font-mono font-normal">{model}</Badge>)}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{selectedAccount.source === "config" ? "未显式配置模型，运行时使用 CPA 提供商默认模型能力" : "CPA 未返回该账户的模型列表"}</div>
                )}
              </div>
              <div className="flex flex-wrap gap-2 border-t pt-4">
                {selectedParent && <Button variant="outline" disabled={pending} onClick={() => void syncQuota(selectedParent.item.id)}><RefreshCwIcon />同步额度</Button>}
                {selectedAccount.can_toggle !== false && <Button variant="outline" onClick={() => void toggle(selectedAccount)}>{selectedAccount.disabled ? "启用账户" : "停用账户"}</Button>}
                {selectedAccount.can_delete !== false && <Button variant="ghost" className="ml-auto text-destructive hover:text-destructive" onClick={() => void remove(selectedAccount)}><Trash2Icon />删除账户</Button>}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

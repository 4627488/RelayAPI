import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react"
import {
  ActivityIcon,
  CheckIcon,
  CircleCheckIcon,
  ExternalLinkIcon,
  FileJson2Icon,
  KeyRoundIcon,
  Link2Icon,
  NetworkIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  InfoBar,
  PageHeader,
  SearchField,
  StatStrip,
} from "@/components/workspace-ui"
import { Textarea } from "@/components/ui/textarea"
import { QuotaSnapshot } from "@/components/quota-snapshot"
import {
  api,
  deleteRequest,
  postJSON,
  type OutboundProxy,
  type ProviderAccount,
  type ProviderAccountTestResult,
} from "@/lib/api"
import { dateTime } from "@/lib/format"

const oauthProviders = [
  { value: "codex", label: "OpenAI Codex", detail: "ChatGPT / Codex 订阅账户" },
  { value: "kimi", label: "Kimi", detail: "使用设备码连接" },
  { value: "xai", label: "xAI", detail: "使用设备码连接" },
]

const apiKeyProviders = [
  { value: "openai", label: "OpenAI" },
  { value: "aliyun-bailian", label: "阿里云百炼" },
  { value: "openai-compatibility", label: "OpenAI 兼容接口" },
  { value: "codex", label: "Codex API Key" },
  { value: "xai", label: "xAI" },
]

const importProviders = [
  ...new Set([...apiKeyProviders.map((item) => item.value), "kimi"]),
]

type OAuthStart = {
  status: string
  url: string
  state: string
  flow: "callback" | "device"
  user_code?: string
  expires_in?: number
}
type OAuthStatus = {
  status: "waiting" | "authorized" | "error"
  provider?: string
  email?: string
  suggested_name?: string
  error?: string
}
type ConnectMode = "oauth" | "api_key" | "import"
type ProviderAccountUpdate = {
  name: string
  models: string[]
  base_url?: string
  websockets?: boolean
  proxy_id: string
  api_key?: string
  headers?: Record<string, string>
  document?: Record<string, unknown>
}

function displayName(account: ProviderAccount) {
  return account.label || account.email || account.name
}
function providerLabel(provider: string) {
  return (
    [...oauthProviders, ...apiKeyProviders].find(
      (item) => item.value === provider
    )?.label ?? provider
  )
}
function sourceLabel(account: ProviderAccount) {
  if (account.auth_kind === "oauth" || account.source === "oauth")
    return "OAuth"
  if (account.auth_kind === "api_key" || account.source === "api_key")
    return "API Key"
  return "导入"
}

function isOAuthAccount(account: ProviderAccount) {
  return account.auth_kind === "oauth" || account.source === "oauth"
}

function accountKey(account: ProviderAccount) {
  return account.id || account.name
}

function accountStatus(account: ProviderAccount) {
  if (account.disabled)
    return { label: "已停用", variant: "secondary" as const }
  if (account.unavailable) {
    if (account.quota_exceeded) {
      return { label: "额度冷却", variant: "destructive" as const }
    }
    if (account.status === "cooldown") {
      return { label: "故障冷却", variant: "destructive" as const }
    }
    return { label: "暂不可用", variant: "secondary" as const }
  }
  return { label: "可用", variant: "outline" as const }
}

function publishedModels(account: ProviderAccount) {
  return account.models ?? []
}

function modelSummary(account: ProviderAccount) {
  const models = publishedModels(account)
  if (!models.length) return { primary: "未发布", extra: "" }
  if (models.length === 1) return { primary: models[0], extra: "" }
  return { primary: models[0], extra: `另 ${models.length - 1} 个` }
}

function quotaSummary(account: ProviderAccount) {
  if (account.quota_exceeded) {
    return account.quota_recover_at
      ? `${dateTime(account.quota_recover_at)} 后可重试`
      : "上游已限流"
  }
  const snapshot = account.quota_snapshot
  const windows =
    snapshot && "windows" in snapshot && Array.isArray(snapshot.windows)
      ? snapshot.windows
      : []
  const window = windows.find((item) => typeof item.used_percent === "number")
  if (window && typeof window.used_percent === "number") {
    const label = window.label || window.kind || "额度"
    return `${label} ${Math.round(window.used_percent)}%`
  }
  if (account.quota_probe_status === "unsupported") return "上游无自动额度"
  if (account.quota_probe_status === "error") {
    return account.quota_probe_error || "额度探测失败"
  }
  if (account.success || account.failed) {
    return `${account.success ?? 0} 成功 / ${account.failed ?? 0} 失败`
  }
  return "尚未探测"
}

function normalizedOAuthProvider(provider: string) {
  const value = provider.trim().toLowerCase()
  if (value === "openai") return "codex"
  if (value === "grok" || value === "x.ai") return "xai"
  return value
}

export function ProvidersView() {
  const [accounts, setAccounts] = useState<ProviderAccount[]>([])
  const [proxies, setProxies] = useState<OutboundProxy[]>([])
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [syncingQuota, setSyncingQuota] = useState(false)
  const [search, setSearch] = useState("")
  const [provider, setProvider] = useState("all")
  const [connectOpen, setConnectOpen] = useState(false)
  const [reauthenticating, setReauthenticating] =
    useState<ProviderAccount | null>(null)
  const [selected, setSelected] = useState<ProviderAccount | null>(null)
  const [testing, setTesting] = useState<ProviderAccount | null>(null)
  const [testResults, setTestResults] = useState<
    Record<string, ProviderAccountTestResult>
  >({})
  const [deleting, setDeleting] = useState<ProviderAccount | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [result, proxyResult] = await Promise.all([
        api<{ files: ProviderAccount[] }>("/api/admin/providers/accounts"),
        api<{ items: OutboundProxy[] }>("/api/admin/proxies"),
      ])
      setAccounts(result.files ?? [])
      setProxies(proxyResult.items ?? [])
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "无法读取模型账户")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])
  const providerOptions = useMemo(
    () => [...new Set(accounts.map((item) => item.provider))].sort(),
    [accounts]
  )
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return accounts.filter(
      (item) =>
        (provider === "all" || item.provider === provider) &&
        (!needle ||
          [
            displayName(item),
            item.name,
            item.provider,
            ...(item.models ?? []),
          ].some((part) => part.toLowerCase().includes(needle)))
    )
  }, [accounts, provider, search])
  const enabled = accounts.filter(
    (item) => !item.disabled && !item.unavailable
  ).length
  const modelCount = new Set(accounts.flatMap((item) => item.models ?? [])).size

  async function toggle(account: ProviderAccount, disabled: boolean) {
    setPending(true)
    try {
      await api(
        `/api/admin/providers/accounts/${encodeURIComponent(account.id || account.name)}`,
        { method: "PATCH", body: JSON.stringify({ disabled }) }
      )
      toast.success(disabled ? "账户已停用" : "账户已启用")
      setSelected(null)
      await load()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "更新失败")
    } finally {
      setPending(false)
    }
  }

  async function syncQuota() {
    setSyncingQuota(true)
    try {
      await postJSON("/api/admin/subscriptions/sync", {})
      const result = await postJSON<{
        items: Array<{ status: string; supported: boolean }>
      }>("/api/admin/subscriptions/quota/sync", {})
      const supported = (result.items ?? []).filter(
        (item) => item.supported && item.status !== "error"
      ).length
      const failed = (result.items ?? []).filter(
        (item) => item.status === "error"
      ).length
      toast.success(
        failed
          ? `额度已刷新：${supported} 个账户可读取，${failed} 个失败`
          : `额度已刷新：${supported} 个账户可读取`
      )
      await load()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "额度刷新失败")
    } finally {
      setSyncingQuota(false)
    }
  }

  async function saveAccount(
    account: ProviderAccount,
    value: ProviderAccountUpdate
  ) {
    if (!value.name.trim() || !value.models.length) {
      toast.error("账户名称和至少一个公开模型为必填项")
      return
    }
    setPending(true)
    try {
      await api(
        `/api/admin/providers/accounts/${encodeURIComponent(account.id || account.name)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ ...value, name: value.name.trim() }),
        }
      )
      toast.success("账户设置已保存")
      setSelected(null)
      await load()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "保存失败")
    } finally {
      setPending(false)
    }
  }

  async function remove() {
    if (!deleting) return
    setPending(true)
    try {
      await deleteRequest(
        `/api/admin/providers/accounts/${encodeURIComponent(deleting.id || deleting.name)}`
      )
      toast.success("账户已删除")
      setDeleting(null)
      setSelected(null)
      await load()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "删除失败")
    } finally {
      setPending(false)
    }
  }

  if (loading)
    return (
      <div className="flex min-h-56 items-center justify-center">
        <Spinner />
      </div>
    )

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="模型管理"
        actions={
          <>
            <Button
              variant="outline"
              disabled={syncingQuota}
              onClick={() => void syncQuota()}
            >
              {syncingQuota ? (
                <Spinner />
              ) : (
                <RefreshCwIcon data-icon="inline-start" />
              )}
              刷新额度
            </Button>
            <Button
              onClick={() => {
                setReauthenticating(null)
                setConnectOpen(true)
              }}
            >
              <PlusIcon data-icon="inline-start" />
              连接账户
            </Button>
          </>
        }
      />

      <StatStrip
        className="grid-cols-3"
        items={[
          { label: "账户", value: accounts.length },
          { label: "可用", value: enabled },
          { label: "公开模型", value: modelCount },
        ]}
      />

      <InfoBar icon={ShieldCheckIcon}>
        一行一个上游账户。发布模型决定对外目录；测试会向该账户发一次最短推理，不走用户计费。
      </InfoBar>

      <div className="flex flex-col gap-3 sm:flex-row">
        <SearchField
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onClear={() => setSearch("")}
          placeholder="搜索账户或模型"
          className="flex-1"
        />
        <Select
          items={[
            { value: "all", label: "全部提供商" },
            ...providerOptions.map((item) => ({
              value: item,
              label: providerLabel(item),
            })),
          ]}
          value={provider}
          onValueChange={(next) => {
            if (next) setProvider(next)
          }}
        >
          <SelectTrigger className="w-full sm:w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">全部提供商</SelectItem>
              {providerOptions.map((item) => (
                <SelectItem key={item} value={item}>
                  {providerLabel(item)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      {filtered.length ? (
        <Card>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>账户</TableHead>
                  <TableHead>提供商</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>公开模型</TableHead>
                  <TableHead>额度</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((account) => {
                  const status = accountStatus(account)
                  const models = modelSummary(account)
                  const lastTest = testResults[accountKey(account)]
                  const proxyName = account.proxy_configured
                    ? (proxies.find((item) => item.id === account.proxy_id)
                        ?.name ?? "独立代理")
                    : "直连"
                  return (
                    <TableRow key={accountKey(account)}>
                      <TableCell className="max-w-56 whitespace-normal">
                        <p className="truncate font-medium">
                          {displayName(account)}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {account.email || account.name}
                          {` · ${proxyName}`}
                        </p>
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        <p>{providerLabel(account.provider)}</p>
                        <p className="text-xs text-muted-foreground">
                          {sourceLabel(account)}
                          {account.plan_type ? ` · ${account.plan_type}` : ""}
                        </p>
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        <Badge
                          title={account.status_message}
                          variant={status.variant}
                        >
                          {status.label}
                        </Badge>
                        {lastTest ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            测试 {lastTest.ok ? "通过" : "失败"} ·{" "}
                            {lastTest.latency_ms} ms
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="max-w-64 whitespace-normal">
                        <p
                          className={
                            publishedModels(account).length
                              ? "truncate font-mono text-xs"
                              : "text-xs text-muted-foreground"
                          }
                          title={publishedModels(account).join("\n")}
                        >
                          {models.primary}
                        </p>
                        {models.extra ? (
                          <p className="text-xs text-muted-foreground">
                            {models.extra}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="max-w-48 text-xs whitespace-normal text-muted-foreground">
                        {quotaSummary(account)}
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="inline-flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={
                              account.disabled ||
                              !publishedModels(account).length
                            }
                            title={
                              account.disabled
                                ? "启用后才能测试"
                                : publishedModels(account).length
                                  ? undefined
                                  : "先发布至少一个模型"
                            }
                            onClick={() => setTesting(account)}
                          >
                            <ActivityIcon data-icon="inline-start" />
                            测试
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setSelected(account)}
                          >
                            管理
                          </Button>
                        </span>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-12">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <KeyRoundIcon />
                </EmptyMedia>
                <EmptyTitle>
                  {accounts.length ? "没有匹配的账户" : "还没有模型账户"}
                </EmptyTitle>
                <EmptyDescription>
                  {accounts.length
                    ? "调整搜索或提供商筛选。"
                    : "连接 OAuth 账户或 API Key 后即可开始路由。"}
                </EmptyDescription>
              </EmptyHeader>
              {!accounts.length ? (
                <Button
                  onClick={() => {
                    setReauthenticating(null)
                    setConnectOpen(true)
                  }}
                >
                  <PlusIcon />
                  连接账户
                </Button>
              ) : null}
            </Empty>
          </CardContent>
        </Card>
      )}

      <ConnectAccountDialog
        open={connectOpen || Boolean(reauthenticating)}
        reauthAccount={reauthenticating}
        onOpenChange={(open) => {
          setConnectOpen(open)
          if (!open) setReauthenticating(null)
        }}
        onSaved={load}
        proxies={proxies}
      />
      <ManageAccountDialog
        account={selected}
        pending={pending}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
        onSave={saveAccount}
        onToggle={toggle}
        onDelete={setDeleting}
        onReauthenticate={(account) => {
          setSelected(null)
          setReauthenticating(account)
        }}
        onTest={(account) => {
          setSelected(null)
          setTesting(account)
        }}
        lastTest={selected ? testResults[accountKey(selected)] : undefined}
        proxies={proxies}
      />
      <TestAccountDialog
        account={testing}
        onOpenChange={(open) => {
          if (!open) setTesting(null)
        }}
        onResult={(account, result) => {
          setTestResults((current) => ({
            ...current,
            [accountKey(account)]: result,
          }))
        }}
      />

      <AlertDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              删除“{deleting ? displayName(deleting) : ""}”？
            </AlertDialogTitle>
            <AlertDialogDescription>
              该账户会从加密数据库和模型路由中立即移除，此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={() => void remove()}
            >
              删除账户
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function ConnectAccountDialog({
  open,
  reauthAccount,
  onOpenChange,
  onSaved,
  proxies,
}: {
  open: boolean
  reauthAccount: ProviderAccount | null
  onOpenChange: (open: boolean) => void
  onSaved: () => Promise<void>
  proxies: OutboundProxy[]
}) {
  const [mode, setMode] = useState<ConnectMode>("oauth")
  const [provider, setProvider] = useState("codex")
  const [pending, setPending] = useState(false)
  const [oauth, setOAuth] = useState<OAuthStart | null>(null)
  const [oauthStatus, setOAuthStatus] = useState<OAuthStatus | null>(null)
  const [callbackURL, setCallbackURL] = useState("")
  const [name, setName] = useState("")
  const [document, setDocument] = useState('{\n  "type": "codex"\n}')
  const [proxyID, setProxyID] = useState("")

  const cancelOAuth = useCallback(async (state: string) => {
    try {
      await deleteRequest(
        `/api/admin/providers/oauth/sessions/${encodeURIComponent(state)}`
      )
    } catch {
      /* session may already be complete */
    }
  }, [])

  function reset() {
    setMode("oauth")
    setProvider("codex")
    setPending(false)
    setOAuth(null)
    setOAuthStatus(null)
    setCallbackURL("")
    setName("")
    setProxyID("")
  }

  function close(next: boolean) {
    if (!next && oauth?.state) void cancelOAuth(oauth.state)
    if (!next) reset()
    onOpenChange(next)
  }

  useEffect(() => {
    if (!open || !reauthAccount) return
    setMode("oauth")
    setProvider(normalizedOAuthProvider(reauthAccount.provider))
    setName(displayName(reauthAccount))
    setProxyID(reauthAccount.proxy_id ?? "")
  }, [open, reauthAccount])

  useEffect(() => {
    if (
      !open ||
      !oauth?.state ||
      oauthStatus?.status === "authorized" ||
      oauthStatus?.status === "error"
    )
      return
    let active = true
    const poll = async () => {
      try {
        const result = await api<OAuthStatus>(
          `/api/admin/providers/oauth/sessions/${encodeURIComponent(oauth.state)}`
        )
        if (!active) return
        setOAuthStatus(result)
        if (result.status === "authorized" && !reauthAccount)
          setName(
            result.suggested_name || result.email || providerLabel(provider)
          )
      } catch (cause) {
        if (active)
          setOAuthStatus({
            status: "error",
            error: cause instanceof Error ? cause.message : "授权状态读取失败",
          })
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 1500)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [oauth?.state, oauthStatus?.status, open, provider, reauthAccount])

  async function startOAuth() {
    setPending(true)
    try {
      const result = await api<OAuthStart>(
        "/api/admin/providers/oauth/sessions",
        {
          method: "POST",
          body: JSON.stringify({
            provider,
            ...(reauthAccount
              ? { credential_id: reauthAccount.id || reauthAccount.name }
              : {}),
          }),
        }
      )
      setOAuth(result)
      setOAuthStatus({ status: "waiting" })
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "无法创建授权链接")
    } finally {
      setPending(false)
    }
  }

  async function submitCallback() {
    if (!oauth || !callbackURL.trim()) return
    setPending(true)
    try {
      await api(
        `/api/admin/providers/oauth/sessions/${encodeURIComponent(oauth.state)}/callback`,
        {
          method: "POST",
          body: JSON.stringify({ redirect_url: callbackURL.trim() }),
        }
      )
      toast.success("回调已接收，正在完成连接")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "回调地址无效")
    } finally {
      setPending(false)
    }
  }

  async function finalizeOAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!oauth) return
    if (!name.trim()) {
      toast.error("账户名称必填")
      return
    }
    setPending(true)
    try {
      await api(
        `/api/admin/providers/oauth/sessions/${encodeURIComponent(oauth.state)}/finalize`,
        {
          method: "POST",
          body: JSON.stringify({ name: name.trim(), proxy_id: proxyID }),
        }
      )
      setOAuth(null)
      toast.success(reauthAccount ? "OAuth 账户已重新认证" : "OAuth 账户已连接")
      onOpenChange(false)
      reset()
      await onSaved()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "保存账户失败")
    } finally {
      setPending(false)
    }
  }

  async function submitCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    let body: Record<string, unknown>
    if (mode === "api_key") {
      body = {
        method: "api_key",
        name: String(form.get("name") ?? ""),
        provider,
        api_key: String(form.get("api_key") ?? ""),
        base_url: String(form.get("base_url") ?? ""),
        proxy_id: proxyID,
      }
    } else {
      let parsed: unknown
      try {
        parsed = JSON.parse(document)
      } catch {
        toast.error("凭据文档不是有效 JSON")
        return
      }
      body = {
        method: "import",
        name: String(form.get("name") ?? ""),
        provider,
        document: parsed,
        proxy_id: proxyID,
      }
    }
    setPending(true)
    try {
      await api("/api/admin/providers/accounts", {
        method: "POST",
        body: JSON.stringify(body),
      })
      toast.success(mode === "api_key" ? "API Key 账户已添加" : "凭据已导入")
      onOpenChange(false)
      reset()
      await onSaved()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "添加失败")
    } finally {
      setPending(false)
    }
  }

  const selectedOAuth = oauthProviders.find((item) => item.value === provider)

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {reauthAccount ? "重新认证 OAuth 账户" : "连接模型账户"}
          </DialogTitle>
          <DialogDescription>
            {reauthAccount
              ? `为 ${displayName(reauthAccount)} 更新 OAuth 登录，不改变已有订阅分配。`
              : "选择最适合该账户的连接方式。OAuth 不需要手动复制令牌。"}
          </DialogDescription>
        </DialogHeader>

        {oauthStatus?.status === "authorized" ? (
          <form id="finalize-oauth" onSubmit={finalizeOAuth}>
            <FieldGroup>
              <Alert>
                <CheckIcon />
                <AlertTitle>授权完成</AlertTitle>
                <AlertDescription>
                  {oauthStatus.email
                    ? `已连接 ${oauthStatus.email}`
                    : "账户身份已验证。"}{" "}
                  保存后按账户类型建立模型目录。
                </AlertDescription>
              </Alert>
              <Field>
                <FieldLabel htmlFor="oauth-account-name">账户名称</FieldLabel>
                <Input
                  id="oauth-account-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
              </Field>
              <Field>
                <FieldLabel>账户代理</FieldLabel>
                <Select
                  items={[
                    { value: "direct", label: "不使用代理（直连）" },
                    ...proxies.map((item) => ({
                      value: item.id,
                      label: `${item.name} · ${item.endpoint}`,
                    })),
                  ]}
                  value={proxyID || "direct"}
                  onValueChange={(next) =>
                    setProxyID(next === "direct" || !next ? "" : next)
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="direct">不使用代理（直连）</SelectItem>
                      {proxies.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name} · {item.endpoint}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  应用于此账户后续的推理、令牌刷新、模型发现和额度查询。
                </FieldDescription>
              </Field>
            </FieldGroup>
          </form>
        ) : oauth ? (
          <div className="flex flex-col gap-5">
            <div className="rounded-lg border p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-medium">{selectedOAuth?.label}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {oauth.flow === "device"
                      ? "在提供商页面输入设备码并确认授权。"
                      : "在新页面登录并确认授权。"}
                  </p>
                </div>
                {oauthStatus?.status === "error" ? (
                  <Badge variant="destructive">失败</Badge>
                ) : (
                  <Badge variant="secondary">等待授权</Badge>
                )}
              </div>
              {oauth.user_code ? (
                <div className="mt-4 rounded-md bg-muted px-4 py-3 text-center font-mono text-xl font-semibold tracking-widest">
                  {oauth.user_code}
                </div>
              ) : null}
              <Button
                className="mt-4 w-full"
                onClick={() =>
                  window.open(oauth.url, "_blank", "noopener,noreferrer")
                }
              >
                <ExternalLinkIcon />
                打开授权页面
              </Button>
            </div>
            {oauth.flow === "callback" ? (
              <Field>
                <FieldLabel htmlFor="oauth-callback">回调地址</FieldLabel>
                <Input
                  id="oauth-callback"
                  value={callbackURL}
                  onChange={(event) => setCallbackURL(event.target.value)}
                  placeholder="http://localhost:1455/auth/callback?code=...&state=..."
                />
                <FieldDescription>
                  如果授权后浏览器显示无法访问
                  localhost，复制地址栏中的完整地址粘贴到这里。
                </FieldDescription>
                <Button
                  variant="outline"
                  disabled={pending || !callbackURL.trim()}
                  onClick={() => void submitCallback()}
                >
                  提交回调地址
                </Button>
              </Field>
            ) : null}
            {oauthStatus?.status === "error" ? (
              <Alert variant="destructive">
                <AlertTitle>授权未完成</AlertTitle>
                <AlertDescription>
                  {oauthStatus.error || "请取消后重试。"}
                </AlertDescription>
              </Alert>
            ) : (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner />
                正在等待提供商确认…
              </div>
            )}
          </div>
        ) : reauthAccount ? (
          <Alert>
            <RefreshCwIcon />
            <AlertTitle>原位更新授权</AlertTitle>
            <AlertDescription>
              完成登录后会替换过期令牌，并保留账户设置、模型范围和所有子订阅。
            </AlertDescription>
          </Alert>
        ) : (
          <Tabs
            value={mode}
            onValueChange={(value) => {
              const next = value as ConnectMode
              setMode(next)
              setProvider(
                next === "oauth"
                  ? "codex"
                  : next === "api_key"
                    ? "openai"
                    : "codex"
              )
            }}
          >
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="oauth">
                <Link2Icon />
                OAuth
              </TabsTrigger>
              <TabsTrigger value="api_key">
                <KeyRoundIcon />
                API Key
              </TabsTrigger>
              <TabsTrigger value="import">
                <FileJson2Icon />
                导入
              </TabsTrigger>
            </TabsList>
            <TabsContent value="oauth" className="mt-5 flex flex-col gap-5">
              <Field>
                <FieldLabel>提供商</FieldLabel>
                <Select
                  items={oauthProviders}
                  value={provider}
                  onValueChange={(next) => {
                    if (next) setProvider(next)
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {oauthProviders.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>{selectedOAuth?.detail}</FieldDescription>
              </Field>
              <Alert>
                <Link2Icon />
                <AlertTitle>推荐连接方式</AlertTitle>
                <AlertDescription>
                  Relay
                  创建一次性授权会话。授权完成后你仍可检查账户名称和模型范围，再决定保存。
                </AlertDescription>
              </Alert>
            </TabsContent>
            <TabsContent value="api_key" className="mt-5">
              <form id="connect-api-key" onSubmit={submitCredential}>
                <CredentialFields
                  provider={provider}
                  setProvider={setProvider}
                  mode="api_key"
                  proxies={proxies}
                  proxyID={proxyID}
                  setProxyID={setProxyID}
                />
              </form>
            </TabsContent>
            <TabsContent value="import" className="mt-5">
              <form id="import-credential" onSubmit={submitCredential}>
                <CredentialFields
                  provider={provider}
                  setProvider={setProvider}
                  mode="import"
                  document={document}
                  setDocument={setDocument}
                  proxies={proxies}
                  proxyID={proxyID}
                  setProxyID={setProxyID}
                />
              </form>
            </TabsContent>
          </Tabs>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            取消
          </Button>
          {oauthStatus?.status === "authorized" ? (
            <Button type="submit" form="finalize-oauth" disabled={pending}>
              {pending ? <Spinner /> : <CheckIcon />}保存账户
            </Button>
          ) : oauth ? null : mode === "oauth" ? (
            <Button disabled={pending} onClick={() => void startOAuth()}>
              {pending ? <Spinner /> : <Link2Icon />}
              {reauthAccount ? "开始重新认证" : "生成授权链接"}
            </Button>
          ) : (
            <Button
              type="submit"
              form={
                mode === "api_key" ? "connect-api-key" : "import-credential"
              }
              disabled={pending}
            >
              {pending ? <Spinner /> : <PlusIcon />}
              {mode === "api_key" ? "添加账户" : "验证并导入"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CredentialFields({
  provider,
  setProvider,
  mode,
  document,
  setDocument,
  proxies,
  proxyID,
  setProxyID,
}: {
  provider: string
  setProvider: (value: string) => void
  mode: "api_key" | "import"
  document?: string
  setDocument?: (value: string) => void
  proxies: OutboundProxy[]
  proxyID: string
  setProxyID: (value: string) => void
}) {
  const options =
    mode === "api_key"
      ? apiKeyProviders
      : importProviders.map((value) => ({ value, label: providerLabel(value) }))
  return (
    <FieldGroup>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${mode}-name`}>账户名称</FieldLabel>
          <Input
            id={`${mode}-name`}
            name="name"
            required
            placeholder="例如 主账户"
          />
        </Field>
        <Field>
          <FieldLabel>提供商</FieldLabel>
          <Select
            items={options}
            value={provider}
            onValueChange={(next) => {
              if (next) setProvider(next)
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {options.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Alert>
        <RefreshCwIcon />
        <AlertTitle>模型目录来自上游</AlertTitle>
        <AlertDescription>
          连接成功后自动读取该凭据的模型目录，再到“管理”里勾选要对外发布的范围。
        </AlertDescription>
      </Alert>
      {mode === "api_key" ? (
        <>
          <Field>
            <FieldLabel htmlFor="api-key">API Key</FieldLabel>
            <Input
              id="api-key"
              name="api_key"
              type="password"
              autoComplete="off"
              required
              placeholder="sk-…"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="base-url">接口地址（可选）</FieldLabel>
            <Input
              id="base-url"
              name="base_url"
              type="url"
              placeholder={
                provider === "aliyun-bailian"
                  ? "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
                  : "https://api.example.com/v1"
              }
            />
            <FieldDescription>
              {provider === "aliyun-bailian"
                ? "留空使用百炼北京公共端点；其他地域、业务空间或 Token Plan 请填写对应 Base URL。"
                : "OpenAI 可留空；兼容服务填写其 Base URL。"}
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel>账户代理</FieldLabel>
            <Select
              items={[
                { value: "direct", label: "不使用代理（直连）" },
                ...proxies.map((item) => ({
                  value: item.id,
                  label: `${item.name} · ${item.endpoint}`,
                })),
              ]}
              value={proxyID || "direct"}
              onValueChange={(next) =>
                setProxyID(next === "direct" || !next ? "" : next)
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="direct">不使用代理（直连）</SelectItem>
                  {proxies.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name} · {item.endpoint}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              只影响这个模型账户；未选择时始终直连，不会继承系统代理。
            </FieldDescription>
          </Field>
        </>
      ) : (
        <>
          <Field>
            <FieldLabel htmlFor="credential-document">凭据 JSON</FieldLabel>
            <Textarea
              id="credential-document"
              value={document}
              onChange={(event) => setDocument?.(event.target.value)}
              rows={10}
              required
              spellCheck={false}
              className="font-mono text-xs"
            />
            <FieldDescription>
              用于导入 Codex、Kimi、xAI、OpenAI 或百炼凭据。OAuth 账户请使用
              OAuth 标签页。
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel>账户代理</FieldLabel>
            <Select
              items={[
                { value: "direct", label: "不使用代理（直连）" },
                ...proxies.map((item) => ({
                  value: item.id,
                  label: `${item.name} · ${item.endpoint}`,
                })),
              ]}
              value={proxyID || "direct"}
              onValueChange={(next) =>
                setProxyID(next === "direct" || !next ? "" : next)
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="direct">不使用代理（直连）</SelectItem>
                  {proxies.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name} · {item.endpoint}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              导入文档中的旧代理字段会被移除，以这里选择的代理条目为准。
            </FieldDescription>
          </Field>
        </>
      )}
    </FieldGroup>
  )
}

function ManageAccountDialog({
  account,
  pending,
  onOpenChange,
  onSave,
  onToggle,
  onDelete,
  onReauthenticate,
  onTest,
  lastTest,
  proxies,
}: {
  account: ProviderAccount | null
  pending: boolean
  onOpenChange: (open: boolean) => void
  onSave: (
    account: ProviderAccount,
    value: ProviderAccountUpdate
  ) => Promise<void>
  onToggle: (account: ProviderAccount, disabled: boolean) => Promise<void>
  onDelete: (account: ProviderAccount) => void
  onReauthenticate: (account: ProviderAccount) => void
  onTest: (account: ProviderAccount) => void
  lastTest?: ProviderAccountTestResult
  proxies: OutboundProxy[]
}) {
  const [name, setName] = useState("")
  const [baseURL, setBaseURL] = useState("")
  const [websockets, setWebsockets] = useState(false)
  const [proxyID, setProxyID] = useState("")
  const [apiKey, setAPIKey] = useState("")
  const [headersText, setHeadersText] = useState("{}")
  const [headersDirty, setHeadersDirty] = useState(false)
  const [documentText, setDocumentText] = useState("")
  const [candidates, setCandidates] = useState<string[]>([])
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const [modelSearch, setModelSearch] = useState("")
  const [modelLoading, setModelLoading] = useState(false)

  const loadModels = useCallback(
    async (target: ProviderAccount, announce: boolean) => {
      setModelLoading(true)
      try {
        const result = await api<{
          models: string[]
          source: string
          warning?: string
        }>(
          `/api/admin/providers/accounts/${encodeURIComponent(target.id || target.name)}/models`
        )
        const nextCandidates = result.models ?? []
        const current = new Set(target.models ?? [])
        const retained = nextCandidates.filter((model) => current.has(model))
        setCandidates(nextCandidates)
        setSelectedModels(retained.length ? retained : nextCandidates)
        if (announce) {
          if (result.warning)
            toast.warning("已返回缓存目录", {
              description: result.warning,
            })
          else
            toast.success(
              result.source === "upstream"
                ? "已从上游枚举模型"
                : "已读取模型目录"
            )
        }
      } catch (cause) {
        setCandidates([])
        setSelectedModels([])
        toast.error(cause instanceof Error ? cause.message : "无法获取模型目录")
      } finally {
        setModelLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    if (!account) return
    setName(displayName(account))
    setBaseURL(account.base_url ?? "")
    setWebsockets(account.websockets ?? false)
    setProxyID(account.proxy_id ?? "")
    setAPIKey("")
    setHeadersText("{}")
    setHeadersDirty(false)
    setDocumentText("")
    setModelSearch("")
    setCandidates(account.models ?? [])
    setSelectedModels(account.models ?? [])
    if (!account.disabled) void loadModels(account, false)
  }, [account, loadModels])

  const visibleModels = useMemo(() => {
    const needle = modelSearch.trim().toLowerCase()
    return needle
      ? candidates.filter((model) => model.toLowerCase().includes(needle))
      : candidates
  }, [candidates, modelSearch])

  function toggleModel(model: string, checked: boolean) {
    setSelectedModels((current) =>
      checked ? [...current, model] : current.filter((item) => item !== model)
    )
  }

  function save() {
    if (!account) return
    let headers: Record<string, string> | undefined
    let document: Record<string, unknown> | undefined
    if (headersDirty) {
      try {
        const parsed = JSON.parse(headersText) as unknown
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
          throw new Error()
        const entries = Object.entries(parsed)
        if (entries.some(([, value]) => typeof value !== "string"))
          throw new Error()
        headers = Object.fromEntries(entries) as Record<string, string>
      } catch {
        toast.error("自定义请求头必须是 JSON 对象")
        return
      }
    }
    if (documentText.trim()) {
      try {
        const parsed = JSON.parse(documentText) as unknown
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
          throw new Error()
        document = parsed as Record<string, unknown>
      } catch {
        toast.error("替换凭据必须是有效的 JSON 对象")
        return
      }
    }
    void onSave(account, {
      name,
      models: selectedModels,
      ...(["codex", "xai", "grok"].includes(account.provider.toLowerCase())
        ? { websockets }
        : {}),
      proxy_id: proxyID,
      ...(account.auth_kind !== "oauth" ? { base_url: baseURL.trim() } : {}),
      ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      ...(headersDirty ? { headers } : {}),
      ...(document ? { document } : {}),
    })
  }
  return (
    <Dialog open={Boolean(account)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {account ? (
          <>
            <DialogHeader>
              <DialogTitle>管理账户</DialogTitle>
              <DialogDescription>
                {providerLabel(account.provider)} · {sourceLabel(account)}
              </DialogDescription>
            </DialogHeader>
            <Tabs defaultValue="general">
              <TabsList className="w-full">
                <TabsTrigger value="general">
                  <ShieldCheckIcon />
                  常规
                </TabsTrigger>
                <TabsTrigger value="connection">
                  <NetworkIcon />
                  连接
                </TabsTrigger>
                <TabsTrigger value="advanced">
                  <FileJson2Icon />
                  高级
                </TabsTrigger>
              </TabsList>
              <TabsContent value="general">
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="manage-account-name">
                      账户名称
                    </FieldLabel>
                    <Input
                      id="manage-account-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                    {account.email ? (
                      <FieldDescription>
                        授权账户：{account.email}
                      </FieldDescription>
                    ) : null}
                  </Field>
                  {isOAuthAccount(account) || account.quota_snapshot ? (
                    <Field>
                      <FieldLabel>账户额度</FieldLabel>
                      <QuotaSnapshot
                        snapshot={account.quota_snapshot}
                        status={account.quota_probe_status}
                        error={account.quota_probe_error}
                        observedAt={account.quota_observed_at}
                      />
                      {lastTest ? (
                        <FieldDescription>
                          上次测试 {lastTest.ok ? "通过" : "失败"} ·{" "}
                          {lastTest.model} · {lastTest.latency_ms} ms
                        </FieldDescription>
                      ) : null}
                    </Field>
                  ) : lastTest ? (
                    <Field>
                      <FieldLabel>上次测试</FieldLabel>
                      <FieldDescription>
                        {lastTest.ok ? "通过" : "失败"} · {lastTest.model} ·{" "}
                        {lastTest.latency_ms} ms
                      </FieldDescription>
                    </Field>
                  ) : null}
                  <Field>
                    <div className="flex items-center justify-between gap-3">
                      <FieldLabel htmlFor="manage-model-search">
                        公开模型
                      </FieldLabel>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={modelLoading || account.disabled}
                        onClick={() => void loadModels(account, true)}
                      >
                        {modelLoading ? (
                          <Spinner data-icon="inline-start" />
                        ) : (
                          <RefreshCwIcon data-icon="inline-start" />
                        )}
                        刷新
                      </Button>
                    </div>
                    <Input
                      id="manage-model-search"
                      value={modelSearch}
                      onChange={(event) => setModelSearch(event.target.value)}
                      placeholder="筛选模型"
                      disabled={modelLoading || account.disabled}
                    />
                    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span>
                        已选择 {selectedModels.length} / {candidates.length}
                      </span>
                      <div className="flex gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          disabled={!candidates.length || account.disabled}
                          onClick={() => setSelectedModels(candidates)}
                        >
                          全选
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          disabled={!selectedModels.length || account.disabled}
                          onClick={() => setSelectedModels([])}
                        >
                          清空
                        </Button>
                      </div>
                    </div>
                    <FieldGroup className="max-h-64 overflow-y-auto rounded-lg border p-3">
                      {modelLoading ? (
                        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                          <Spinner />
                          读取模型目录…
                        </div>
                      ) : visibleModels.length ? (
                        visibleModels.map((model, index) => {
                          const id = `upstream-model-${index}`
                          return (
                            <Field key={model} orientation="horizontal">
                              <Checkbox
                                id={id}
                                checked={selectedModels.includes(model)}
                                disabled={account.disabled}
                                onCheckedChange={(checked) =>
                                  toggleModel(model, checked)
                                }
                              />
                              <FieldLabel
                                htmlFor={id}
                                className="font-mono text-xs font-normal"
                              >
                                {model}
                              </FieldLabel>
                            </Field>
                          )
                        })
                      ) : (
                        <p className="py-8 text-center text-sm text-muted-foreground">
                          {account.disabled
                            ? "账户已停用；启用后才能刷新模型目录"
                            : "没有匹配的模型"}
                        </p>
                      )}
                    </FieldGroup>
                    <FieldDescription>
                      公开范围独立于凭据本身；保存后立即重建模型路由。
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              </TabsContent>
              <TabsContent value="connection">
                <FieldGroup>
                  <Field
                    data-disabled={account.auth_kind === "oauth" || undefined}
                  >
                    <FieldLabel htmlFor="manage-base-url">
                      上游接口地址
                    </FieldLabel>
                    <Input
                      id="manage-base-url"
                      type="url"
                      className="font-mono"
                      value={baseURL}
                      onChange={(event) => setBaseURL(event.target.value)}
                      placeholder="https://api.example.com/v1"
                      disabled={account.auth_kind === "oauth"}
                      spellCheck={false}
                    />
                    <FieldDescription>
                      {account.auth_kind === "oauth"
                        ? "OAuth 端点由提供商固定，避免令牌被发送到非预期地址。"
                        : "留空使用提供商默认端点；修改后会重新加载该账户。"}
                    </FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel>账户代理</FieldLabel>
                    <Select
                      items={[
                        { value: "direct", label: "不使用代理（直连）" },
                        ...proxies.map((item) => ({
                          value: item.id,
                          label: `${item.name} · ${item.endpoint}`,
                        })),
                      ]}
                      value={proxyID || "direct"}
                      onValueChange={(next) =>
                        setProxyID(next === "direct" || !next ? "" : next)
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
                      该选择用于此账户的推理、模型发现、令牌刷新与额度查询；未选择时明确直连。
                    </FieldDescription>
                  </Field>
                  {["codex", "xai", "grok"].includes(
                    account.provider.toLowerCase()
                  ) ? (
                    <Field orientation="horizontal">
                      <FieldContent>
                        <FieldTitle>上游 WebSocket</FieldTitle>
                        <FieldDescription>
                          对该账户启用原生多轮 Responses WebSocket；HTTP 与 SSE
                          不受影响。
                        </FieldDescription>
                      </FieldContent>
                      <Switch
                        id="manage-websockets"
                        checked={websockets}
                        onCheckedChange={setWebsockets}
                        aria-label="上游 WebSocket"
                      />
                    </Field>
                  ) : null}
                  {account.auth_kind === "api_key" ? (
                    <Field>
                      <FieldLabel htmlFor="manage-api-key">
                        轮换 API Key
                      </FieldLabel>
                      <Input
                        id="manage-api-key"
                        type="password"
                        value={apiKey}
                        onChange={(event) => setAPIKey(event.target.value)}
                        placeholder="留空保持现有 Key"
                        autoComplete="new-password"
                      />
                      <FieldDescription>
                        仅在填写时替换；现有 Key 永远不会返回浏览器。
                      </FieldDescription>
                    </Field>
                  ) : null}
                </FieldGroup>
              </TabsContent>
              <TabsContent value="advanced">
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="manage-headers">
                      替换自定义请求头
                    </FieldLabel>
                    <Textarea
                      id="manage-headers"
                      value={headersText}
                      onChange={(event) => {
                        setHeadersText(event.target.value)
                        setHeadersDirty(true)
                      }}
                      rows={6}
                      className="font-mono text-xs"
                      spellCheck={false}
                    />
                    <FieldDescription>
                      {account.custom_header_names?.length
                        ? `当前已配置：${account.custom_header_names.join("、")}。值不会回显；编辑后将整体替换。`
                        : 'JSON 对象，例如 {"X-Tenant":"tenant-a"}；不编辑则保持现状。'}
                    </FieldDescription>
                    {headersDirty ? (
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setHeadersText("{}")}
                        >
                          清除全部请求头
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setHeadersText("{}")
                            setHeadersDirty(false)
                          }}
                        >
                          保留原配置
                        </Button>
                      </div>
                    ) : null}
                  </Field>
                  {account.can_replace_document ? (
                    <Field>
                      <FieldLabel htmlFor="manage-document">
                        替换完整凭据 JSON
                      </FieldLabel>
                      <Textarea
                        id="manage-document"
                        value={documentText}
                        onChange={(event) =>
                          setDocumentText(event.target.value)
                        }
                        rows={9}
                        className="font-mono text-xs"
                        spellCheck={false}
                        placeholder="留空保持现有加密凭据"
                      />
                      <FieldDescription>
                        用于更新导入凭据、服务账户或其他高级字段。上方连接设置会覆盖同名
                        JSON 字段。
                      </FieldDescription>
                    </Field>
                  ) : (
                    <Alert>
                      <ShieldCheckIcon />
                      <AlertTitle>OAuth 凭据由 Relay 管理</AlertTitle>
                      <AlertDescription>
                        OAuth
                        令牌会自动刷新；掉登录或需要更换授权身份时，可使用下方“重新认证”。
                      </AlertDescription>
                    </Alert>
                  )}
                </FieldGroup>
              </TabsContent>
            </Tabs>
            <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => onDelete(account)}
                >
                  <Trash2Icon />
                  删除
                </Button>
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => void onToggle(account, !account.disabled)}
                >
                  {account.disabled ? "启用" : "停用"}
                </Button>
                {isOAuthAccount(account) ? (
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => onReauthenticate(account)}
                  >
                    <RefreshCwIcon data-icon="inline-start" />
                    重新认证
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  disabled={
                    pending ||
                    account.disabled ||
                    !publishedModels(account).length
                  }
                  onClick={() => onTest(account)}
                >
                  <ActivityIcon data-icon="inline-start" />
                  测试
                </Button>
              </div>
              <Button
                disabled={pending || modelLoading || !selectedModels.length}
                onClick={save}
              >
                {pending ? <Spinner /> : <CheckIcon />}保存更改
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function TestAccountDialog({
  account,
  onOpenChange,
  onResult,
}: {
  account: ProviderAccount | null
  onOpenChange: (open: boolean) => void
  onResult: (
    account: ProviderAccount,
    result: ProviderAccountTestResult
  ) => void
}) {
  const models = account ? publishedModels(account) : []
  const [model, setModel] = useState("")
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<ProviderAccountTestResult | null>(null)

  useEffect(() => {
    if (!account) {
      setModel("")
      setPending(false)
      setResult(null)
      return
    }
    setModel(publishedModels(account)[0] ?? "")
    setPending(false)
    setResult(null)
  }, [account])

  async function run() {
    if (!account || !model) return
    setPending(true)
    try {
      const next = await api<ProviderAccountTestResult>(
        `/api/admin/providers/accounts/${encodeURIComponent(accountKey(account))}/test`,
        { method: "POST", body: JSON.stringify({ model }) }
      )
      setResult(next)
      onResult(account, next)
      if (next.ok) {
        toast.success(`${model} 可用，${next.latency_ms} ms`)
      } else {
        toast.error(next.error || `${model} 测试失败`)
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "测试失败"
      const failed: ProviderAccountTestResult = {
        ok: false,
        model,
        provider: account.provider,
        status_code: 0,
        latency_ms: 0,
        error: message,
      }
      setResult(failed)
      onResult(account, failed)
      toast.error(message)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={Boolean(account)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>测试模型</DialogTitle>
          <DialogDescription>
            {account
              ? `${displayName(account)} · ${providerLabel(account.provider)}`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel>公开模型</FieldLabel>
            <Select
              items={models.map((item) => ({ value: item, label: item }))}
              value={model}
              onValueChange={(next) => {
                if (next) setModel(next)
              }}
            >
              <SelectTrigger className="w-full font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {models.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              向该账户发送一次最短非流式请求。不经过用户计费，但会真实打到上游。
            </FieldDescription>
          </Field>
          {result ? (
            <div className="rounded-lg border px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {result.ok ? <CircleCheckIcon /> : <TriangleAlertIcon />}
                  {result.ok ? "通过" : "失败"}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {result.status_code || "—"} · {result.latency_ms} ms
                </p>
              </div>
              <p className="mt-2 font-mono text-xs wrap-break-word text-muted-foreground">
                {result.preview || result.error || "上游没有返回可读内容"}
              </p>
            </div>
          ) : null}
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button disabled={pending || !model} onClick={() => void run()}>
            {pending ? <Spinner /> : <ActivityIcon />}
            {result ? "再测一次" : "发送测试"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

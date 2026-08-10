import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react"
import {
  CheckIcon,
  ExternalLinkIcon,
  FileJson2Icon,
  KeyRoundIcon,
  Link2Icon,
  NetworkIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
  Trash2Icon,
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
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { QuotaSnapshot } from "@/components/quota-snapshot"
import { api, deleteRequest, postJSON, type ProviderAccount } from "@/lib/api"
import { dateTime } from "@/lib/format"

const oauthProviders = [
  { value: "codex", label: "OpenAI Codex", detail: "ChatGPT / Codex 订阅账户" },
  { value: "claude", label: "Claude", detail: "Anthropic OAuth 账户" },
  {
    value: "antigravity",
    label: "Antigravity",
    detail: "Google Antigravity 账户",
  },
  { value: "kimi", label: "Kimi", detail: "使用设备码连接" },
  { value: "xai", label: "xAI", detail: "使用设备码连接" },
]

const apiKeyProviders = [
  { value: "openai", label: "OpenAI" },
  { value: "aliyun-bailian", label: "阿里云百炼" },
  { value: "openai-compatibility", label: "OpenAI 兼容接口" },
  { value: "claude", label: "Claude" },
  { value: "gemini", label: "Gemini" },
  { value: "gemini-interactions", label: "Gemini Interactions" },
  { value: "aistudio", label: "Google AI Studio" },
  { value: "codex", label: "Codex API Key" },
  { value: "xai", label: "xAI" },
]

const importProviders = [
  ...new Set([
    ...apiKeyProviders.map((item) => item.value),
    "vertex",
    "antigravity",
    "kimi",
  ]),
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

export function ProvidersView() {
  const [accounts, setAccounts] = useState<ProviderAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [syncingQuota, setSyncingQuota] = useState(false)
  const [search, setSearch] = useState("")
  const [provider, setProvider] = useState("all")
  const [connectOpen, setConnectOpen] = useState(false)
  const [selected, setSelected] = useState<ProviderAccount | null>(null)
  const [deleting, setDeleting] = useState<ProviderAccount | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api<{ files: ProviderAccount[] }>(
        "/api/admin/providers/accounts"
      )
      setAccounts(result.files ?? [])
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
    name: string,
    models: string[]
  ) {
    if (!name.trim() || !models.length) {
      toast.error("账户名称和至少一个 CPA 模型为必填项")
      return
    }
    setPending(true)
    try {
      await api(
        `/api/admin/providers/accounts/${encodeURIComponent(account.id || account.name)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ name: name.trim(), models }),
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">模型账户</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            连接订阅账户或 API Key，并控制它们可以承载的模型。
          </p>
        </div>
        <div className="flex gap-2">
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
          <Button onClick={() => setConnectOpen(true)}>
            <PlusIcon data-icon="inline-start" />
            连接账户
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border bg-border">
        {[
          ["账户", accounts.length],
          ["可用", enabled],
          ["公开模型", modelCount],
        ].map(([label, value]) => (
          <div key={label} className="bg-background px-4 py-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
          </div>
        ))}
      </div>

      <Alert>
        <ShieldCheckIcon />
        <AlertTitle>Relay 托管凭据</AlertTitle>
        <AlertDescription>
          OAuth 授权后和 API Key
          均整体加密保存。页面只展示账户元数据，不会返回令牌明文。
        </AlertDescription>
      </Alert>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索账户或模型"
            className="pl-9"
          />
        </div>
        <Select
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
        <div className="grid gap-3 lg:grid-cols-2">
          {filtered.map((account) => (
            <Card
              key={account.id || account.name}
              className="transition-colors hover:border-foreground/20"
            >
              <CardHeader>
                <div className="min-w-0">
                  <div className="mb-1.5 flex items-center gap-2">
                    <CardTitle className="truncate text-base">
                      {displayName(account)}
                    </CardTitle>
                    <Badge variant="outline">{sourceLabel(account)}</Badge>
                    {account.plan_type ? (
                      <Badge variant="secondary">{account.plan_type}</Badge>
                    ) : null}
                  </div>
                  <CardDescription>
                    {providerLabel(account.provider)}
                  </CardDescription>
                </div>
                <CardAction>
                  <Badge
                    title={account.status_message}
                    variant={
                      account.disabled || account.unavailable
                        ? "secondary"
                        : "default"
                    }
                  >
                    {account.disabled
                      ? "已停用"
                      : account.unavailable
                        ? account.quota_exceeded
                          ? "额度冷却"
                          : "暂不可用"
                        : "可用"}
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {isOAuthAccount(account) ? (
                  <section
                    className="flex flex-col gap-2"
                    aria-label="OAuth 账户额度"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium">账户额度</p>
                      {account.quota_exceeded ? (
                        <Badge variant="destructive">
                          {account.quota_recover_at
                            ? `${dateTime(account.quota_recover_at)} 后重试`
                            : "CPA 已限流"}
                        </Badge>
                      ) : null}
                    </div>
                    <QuotaSnapshot
                      compact
                      snapshot={account.quota_snapshot}
                      status={account.quota_probe_status}
                      error={account.quota_probe_error}
                      observedAt={account.quota_observed_at}
                    />
                    {account.last_refreshed_at ||
                    account.success ||
                    account.failed ? (
                      <p className="text-xs text-muted-foreground">
                        {account.last_refreshed_at
                          ? `令牌刷新于 ${dateTime(account.last_refreshed_at)}`
                          : "CPA 运行时"}
                        {" · "}请求 {account.success ?? 0} 成功 /{" "}
                        {account.failed ?? 0} 失败
                      </p>
                    ) : null}
                  </section>
                ) : null}
                <div className="flex flex-wrap gap-1.5">
                  {(account.models ?? []).slice(0, 5).map((model) => (
                    <Badge
                      key={model}
                      variant="outline"
                      className="font-mono font-normal"
                    >
                      {model}
                    </Badge>
                  ))}
                  {(account.models?.length ?? 0) > 5 ? (
                    <Badge variant="secondary">
                      +{(account.models?.length ?? 0) - 5}
                    </Badge>
                  ) : null}
                  {!(account.models?.length ?? 0) ? (
                    <span className="text-xs text-muted-foreground">
                      CPA 尚未同步可用模型
                    </span>
                  ) : null}
                </div>
              </CardContent>
              <CardFooter className="flex min-h-12 gap-3 text-xs text-muted-foreground">
                {account.email ? (
                  <span className="truncate">{account.email}</span>
                ) : null}
                {account.proxy_configured ? (
                  <span className="flex items-center gap-1">
                    <NetworkIcon className="size-3" />
                    独立代理
                  </span>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={() => setSelected(account)}
                >
                  管理
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
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
                <Button onClick={() => setConnectOpen(true)}>
                  <PlusIcon />
                  连接账户
                </Button>
              ) : null}
            </Empty>
          </CardContent>
        </Card>
      )}

      <ConnectAccountDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onSaved={load}
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
  onOpenChange,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => Promise<void>
}) {
  const [mode, setMode] = useState<ConnectMode>("oauth")
  const [provider, setProvider] = useState("codex")
  const [pending, setPending] = useState(false)
  const [oauth, setOAuth] = useState<OAuthStart | null>(null)
  const [oauthStatus, setOAuthStatus] = useState<OAuthStatus | null>(null)
  const [callbackURL, setCallbackURL] = useState("")
  const [name, setName] = useState("")
  const [document, setDocument] = useState('{\n  "type": "vertex"\n}')

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
  }

  function close(next: boolean) {
    if (!next && oauth?.state) void cancelOAuth(oauth.state)
    if (!next) reset()
    onOpenChange(next)
  }

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
        if (result.status === "authorized")
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
  }, [oauth?.state, oauthStatus?.status, open, provider])

  async function startOAuth() {
    setPending(true)
    try {
      const result = await api<OAuthStart>(
        "/api/admin/providers/oauth/sessions",
        { method: "POST", body: JSON.stringify({ provider }) }
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
        { method: "POST", body: JSON.stringify({ name: name.trim() }) }
      )
      setOAuth(null)
      toast.success("OAuth 账户已连接")
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
          <DialogTitle>连接模型账户</DialogTitle>
          <DialogDescription>
            选择最适合该账户的连接方式。OAuth 不需要手动复制令牌。
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
                  保存后将由 CPA 按账户类型建立模型目录。
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
            </FieldGroup>
          </form>
        ) : oauth ? (
          <div className="space-y-5">
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
                    : "vertex"
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
            <TabsContent value="oauth" className="mt-5 space-y-5">
              <Field>
                <FieldLabel>提供商</FieldLabel>
                <Select
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
              {pending ? <Spinner /> : <Link2Icon />}生成授权链接
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
}: {
  provider: string
  setProvider: (value: string) => void
  mode: "api_key" | "import"
  document?: string
  setDocument?: (value: string) => void
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
        <AlertTitle>模型由 CPA 提供</AlertTitle>
        <AlertDescription>
          连接成功后自动读取该凭据的模型目录，再到“管理账户”中勾选公开范围。
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
        </>
      ) : (
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
            用于 Vertex 服务账户或迁移现有 CPA 凭据。OAuth 账户请使用 OAuth
            标签页。
          </FieldDescription>
        </Field>
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
}: {
  account: ProviderAccount | null
  pending: boolean
  onOpenChange: (open: boolean) => void
  onSave: (
    account: ProviderAccount,
    name: string,
    models: string[]
  ) => Promise<void>
  onToggle: (account: ProviderAccount, disabled: boolean) => Promise<void>
  onDelete: (account: ProviderAccount) => void
}) {
  const [name, setName] = useState("")
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
            toast.warning("CPA 已返回缓存目录", { description: result.warning })
          else
            toast.success(
              result.source === "cpa_upstream"
                ? "已由 CPA 从上游枚举模型"
                : "已读取 CPA 模型目录"
            )
        }
      } catch (cause) {
        setCandidates([])
        setSelectedModels([])
        toast.error(
          cause instanceof Error ? cause.message : "无法从 CPA 获取模型"
        )
      } finally {
        setModelLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    if (!account) return
    setName(displayName(account))
    setModelSearch("")
    setCandidates([])
    setSelectedModels([])
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
  return (
    <Dialog open={Boolean(account)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        {account ? (
          <>
            <DialogHeader>
              <DialogTitle>管理账户</DialogTitle>
              <DialogDescription>
                {providerLabel(account.provider)} · {sourceLabel(account)}
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="manage-account-name">账户名称</FieldLabel>
                <Input
                  id="manage-account-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field>
                <div className="flex items-center justify-between gap-3">
                  <FieldLabel htmlFor="manage-model-search">
                    CPA 模型目录
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
                  placeholder="筛选 CPA 模型"
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
                      disabled={!candidates.length}
                      onClick={() => setSelectedModels(candidates)}
                    >
                      全选
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={!selectedModels.length}
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
                      读取 CPA 模型目录…
                    </div>
                  ) : visibleModels.length ? (
                    visibleModels.map((model, index) => {
                      const id = `cpa-model-${index}`
                      return (
                        <Field key={model} orientation="horizontal">
                          <Checkbox
                            id={id}
                            checked={selectedModels.includes(model)}
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
                        ? "启用账户后可读取 CPA 模型目录"
                        : "CPA 没有返回匹配模型"}
                    </p>
                  )}
                </FieldGroup>
                <FieldDescription>
                  这里只能勾选 CPA 为该凭据返回的模型；保存后重建公开路由。
                </FieldDescription>
              </Field>
              {account.email ||
              account.base_url ||
              account.prefix ||
              account.proxy_configured ? (
                <div className="grid gap-3 rounded-lg border p-4 text-sm sm:grid-cols-2">
                  {account.email ? (
                    <div>
                      <p className="text-xs text-muted-foreground">授权账户</p>
                      <p className="mt-1 break-all">{account.email}</p>
                    </div>
                  ) : null}
                  {account.base_url ? (
                    <div>
                      <p className="text-xs text-muted-foreground">接口地址</p>
                      <p className="mt-1 break-all">{account.base_url}</p>
                    </div>
                  ) : null}
                  {account.prefix ? (
                    <div>
                      <p className="text-xs text-muted-foreground">模型前缀</p>
                      <p className="mt-1 font-mono">{account.prefix}</p>
                    </div>
                  ) : null}
                  {account.proxy_configured ? (
                    <div>
                      <p className="text-xs text-muted-foreground">网络</p>
                      <p className="mt-1">使用账户独立代理</p>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </FieldGroup>
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
              </div>
              <Button
                disabled={pending || modelLoading || !selectedModels.length}
                onClick={() => void onSave(account, name, selectedModels)}
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

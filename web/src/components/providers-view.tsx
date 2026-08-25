import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertDialog } from "@astryxdesign/core/AlertDialog"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList"
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog"
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu"
import { EmptyState } from "@astryxdesign/core/EmptyState"
import { FormLayout } from "@astryxdesign/core/FormLayout"
import {
  HStack,
  Layout,
  LayoutContent,
  LayoutFooter,
  VStack,
} from "@astryxdesign/core/Layout"
import { Selector } from "@astryxdesign/core/Selector"
import { Spinner } from "@astryxdesign/core/Spinner"
import { Switch } from "@astryxdesign/core/Switch"
import { Tab, TabList } from "@astryxdesign/core/TabList"
import { Table, pixel, proportional } from "@astryxdesign/core/Table"
import { Text } from "@astryxdesign/core/Text"
import { TextArea } from "@astryxdesign/core/TextArea"
import { TextInput } from "@astryxdesign/core/TextInput"
import { Token } from "@astryxdesign/core/Token"
import { useToast } from "@astryxdesign/core/Toast"
import {
  ActivityIcon,
  ExternalLinkIcon,
  FileJson2Icon,
  KeyRoundIcon,
  Link2Icon,
  MoreHorizontalIcon,
  NetworkIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react"

import { LoadErrorView } from "@/components/load-error-view"
import { LoadingView } from "@/components/loading-view"
import {
  CopyField,
  CountBadge,
  MetricGrid,
  PageHeader,
  SearchField,
  SectionCard,
  StatusLabel,
} from "@/components/page-kit"
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

type AccountStatus = {
  label: string
  tone: "success" | "warning" | "error" | "neutral"
}

interface AccountRow extends Record<string, unknown> {
  id: string
  name: string
  email: string
  provider: string
  source: string
  plan: string
  status: AccountStatus
  statusMessage: string
  modelsPrimary: string
  modelsExtra: number
  lastTest?: ProviderAccountTestResult
  account: ProviderAccount
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

function accountStatus(account: ProviderAccount): AccountStatus {
  if (account.disabled) return { label: "已停用", tone: "neutral" }
  if (account.unavailable) {
    if (account.quota_exceeded) return { label: "额度冷却", tone: "warning" }
    if (account.status === "cooldown")
      return { label: "故障冷却", tone: "error" }
    return { label: "暂不可用", tone: "neutral" }
  }
  return { label: "可用", tone: "success" }
}

function publishedModels(account: ProviderAccount) {
  return account.models ?? []
}

function modelSummary(account: ProviderAccount) {
  const models = publishedModels(account)
  if (!models.length) return { primary: "未发布", extra: 0 }
  if (models.length === 1) return { primary: models[0], extra: 0 }
  return { primary: models[0], extra: models.length - 1 }
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

function proxyOptions(proxies: OutboundProxy[]) {
  return [
    { value: "direct", label: "不使用代理（直连）" },
    ...proxies.map((item) => ({
      value: item.id,
      label: `${item.name} · ${item.endpoint}`,
    })),
  ]
}

function proxyName(account: ProviderAccount, proxies: OutboundProxy[]) {
  if (!account.proxy_configured) return "直连"
  return proxies.find((item) => item.id === account.proxy_id)?.name ?? "独立代理"
}

export function ProvidersView() {
  const toast = useToast()
  const [accounts, setAccounts] = useState<ProviderAccount[]>([])
  const [proxies, setProxies] = useState<OutboundProxy[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
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
    setLoadError("")
    try {
      const [result, proxyResult] = await Promise.all([
        api<{ files: ProviderAccount[] }>("/api/admin/providers/accounts"),
        api<{ items: OutboundProxy[] }>("/api/admin/proxies"),
      ])
      setAccounts(result.files ?? [])
      setProxies(proxyResult.items ?? [])
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "无法读取模型账户"
      setLoadError(message)
      toast({ type: "error", body: message })
    } finally {
      setLoading(false)
    }
  }, [toast])

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
  const rows: AccountRow[] = filtered.map((account) => {
    const models = modelSummary(account)
    return {
      id: accountKey(account),
      name: displayName(account),
      email: [account.email, proxyName(account, proxies)]
        .filter(Boolean)
        .join(" · "),
      provider: providerLabel(account.provider),
      source: sourceLabel(account),
      plan: account.plan_type ?? "",
      status: accountStatus(account),
      statusMessage: account.status_message ?? "",
      modelsPrimary: models.primary,
      modelsExtra: models.extra,
      lastTest: testResults[accountKey(account)],
      account,
    }
  })

  async function toggle(account: ProviderAccount, disabled: boolean) {
    setPending(true)
    try {
      await api(
        `/api/admin/providers/accounts/${encodeURIComponent(account.id || account.name)}`,
        { method: "PATCH", body: JSON.stringify({ disabled }) }
      )
      toast({ body: disabled ? "账户已停用" : "账户已启用" })
      setSelected(null)
      await load()
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "更新失败",
      })
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
      toast({
        body: failed
          ? `额度已刷新：${supported} 个账户可读取，${failed} 个失败`
          : `额度已刷新：${supported} 个账户可读取`,
      })
      await load()
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "额度刷新失败",
      })
    } finally {
      setSyncingQuota(false)
    }
  }

  async function saveAccount(
    account: ProviderAccount,
    value: ProviderAccountUpdate
  ) {
    if (!value.name.trim() || !value.models.length) {
      toast({ type: "error", body: "账户名称和至少一个公开模型为必填项" })
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
      toast({ body: "账户设置已保存" })
      setSelected(null)
      await load()
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "保存失败",
      })
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
      toast({ body: "账户已删除" })
      setDeleting(null)
      setSelected(null)
      await load()
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "删除失败",
      })
    } finally {
      setPending(false)
    }
  }

  function openConnect() {
    setReauthenticating(null)
    setConnectOpen(true)
  }

  if (loading) return <LoadingView />
  if (loadError && accounts.length === 0) {
    return <LoadErrorView message={loadError} onRetry={() => void load()} />
  }

  return (
    <VStack gap={4}>
      <PageHeader
        title="模型账户"
        actions={
          <>
            <Button
              label="刷新额度"
              icon={<RefreshCwIcon />}
              isLoading={syncingQuota}
              onClick={() => void syncQuota()}
            />
            <Button
              label="连接账户"
              variant="primary"
              icon={<PlusIcon />}
              onClick={openConnect}
            />
          </>
        }
      />

      <MetricGrid
        items={[
          { label: "账户", value: accounts.length },
          { label: "可用", value: enabled },
          { label: "公开模型", value: modelCount },
        ]}
      />

      {loadError ? (
        <Banner
          status="error"
          title="账户列表可能已过期"
          description={loadError}
          collapsible={false}
        />
      ) : null}

      <SectionCard
        title="上游账户"
        description="一行一个上游账户。发布模型决定对外目录；测试会向该账户发一次最短推理，不走用户计费。"
        actions={
          <HStack gap={3} wrap="wrap" vAlign="end">
            <SearchField
              value={search}
              onChange={setSearch}
              placeholder="搜索账户或模型"
            />
            <Selector
              label="提供商"
              isLabelHidden
              value={provider}
              onChange={setProvider}
              options={[
                { value: "all", label: "全部提供商" },
                ...providerOptions.map((item) => ({
                  value: item,
                  label: providerLabel(item),
                })),
              ]}
            />
          </HStack>
        }
      >
        {rows.length ? (
          <Table
            data={rows}
            idKey="id"
            density="compact"
            hasHover
            verticalAlign="top"
            columns={[
              {
                key: "name",
                header: "账户",
                width: proportional(1.4),
                renderCell: (row) => (
                  <VStack gap={0}>
                    <Text weight="semibold">{row.name}</Text>
                    <Text color="secondary" type="supporting">
                      {row.email}
                    </Text>
                  </VStack>
                ),
              },
              {
                key: "provider",
                header: "提供商",
                width: proportional(1),
                renderCell: (row) => (
                  <VStack gap={1}>
                    <Text>{row.provider}</Text>
                    <HStack gap={1} wrap="wrap" vAlign="center">
                      <Token label={row.source} color="gray" />
                      {row.plan ? <Token label={row.plan} color="gray" /> : null}
                    </HStack>
                  </VStack>
                ),
              },
              {
                key: "status",
                header: "状态",
                width: pixel(160),
                renderCell: (row) => (
                  <VStack gap={1}>
                    <StatusLabel
                      tone={row.status.tone}
                      label={row.status.label}
                    />
                    {row.statusMessage ? (
                      <Text color="secondary" type="supporting">
                        {row.statusMessage}
                      </Text>
                    ) : null}
                    {row.lastTest ? (
                      <Text color="secondary" type="supporting">
                        测试 {row.lastTest.ok ? "通过" : "失败"} ·{" "}
                        {row.lastTest.latency_ms} ms
                      </Text>
                    ) : null}
                  </VStack>
                ),
              },
              {
                key: "modelsPrimary",
                header: "公开模型",
                width: proportional(1),
                renderCell: (row) => (
                  <HStack gap={2} wrap="wrap" vAlign="center">
                    <Text
                      type={
                        publishedModels(row.account).length ? "code" : undefined
                      }
                      color={
                        publishedModels(row.account).length
                          ? undefined
                          : "secondary"
                      }
                    >
                      {row.modelsPrimary}
                    </Text>
                    {row.modelsExtra ? (
                      <CountBadge value={`+${row.modelsExtra}`} />
                    ) : null}
                  </HStack>
                ),
              },
              {
                key: "quota",
                header: "额度",
                width: proportional(1.2),
                renderCell: (row) =>
                  row.account.quota_exceeded ? (
                    <Text color="secondary" type="supporting">
                      {quotaSummary(row.account)}
                    </Text>
                  ) : (
                    <QuotaSnapshot
                      snapshot={row.account.quota_snapshot}
                      status={row.account.quota_probe_status}
                      error={row.account.quota_probe_error}
                      observedAt={row.account.quota_observed_at}
                      compact
                    />
                  ),
              },
              {
                key: "actions",
                header: "操作",
                width: pixel(72),
                align: "end",
                renderCell: (row) => {
                  const canTest =
                    !row.account.disabled &&
                    publishedModels(row.account).length > 0
                  return (
                    <DropdownMenu
                      hasChevron={false}
                      alignment="end"
                      button={{
                        label: `操作 ${row.name}`,
                        variant: "ghost",
                        isIconOnly: true,
                        icon: <MoreHorizontalIcon />,
                      }}
                      items={[
                        {
                          label: "连接测试",
                          icon: <ActivityIcon />,
                          isDisabled: !canTest,
                          onClick: () => setTesting(row.account),
                        },
                        {
                          label: "管理",
                          icon: <ShieldCheckIcon />,
                          onClick: () => setSelected(row.account),
                        },
                        {
                          label: row.account.disabled ? "启用" : "停用",
                          isDisabled: pending,
                          onClick: () =>
                            void toggle(row.account, !row.account.disabled),
                        },
                        { type: "divider" },
                        {
                          label: "删除",
                          variant: "destructive",
                          icon: <Trash2Icon />,
                          onClick: () => setDeleting(row.account),
                        },
                      ]}
                    />
                  )
                },
              },
            ]}
          />
        ) : (
          <EmptyState
            title={accounts.length ? "没有匹配的账户" : "还没有模型账户"}
            description={
              accounts.length
                ? "调整搜索或提供商筛选。"
                : "连接 OAuth 账户或 API Key 后即可开始路由。"
            }
            icon={<KeyRoundIcon />}
            actions={
              accounts.length ? undefined : (
                <Button
                  label="连接账户"
                  variant="primary"
                  icon={<PlusIcon />}
                  onClick={openConnect}
                />
              )
            }
          />
        )}
      </SectionCard>

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
        onDelete={(account) => {
          setSelected(null)
          setDeleting(account)
        }}
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
        isOpen={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
        title={`删除“${deleting ? displayName(deleting) : ""}”？`}
        description="该账户会从加密数据库和模型路由中立即移除，此操作无法撤销。"
        actionLabel="删除账户"
        cancelLabel="取消"
        isActionLoading={pending}
        onAction={() => void remove()}
      />
    </VStack>
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
  const toast = useToast()
  const [mode, setMode] = useState<ConnectMode>("oauth")
  const [provider, setProvider] = useState("codex")
  const [pending, setPending] = useState(false)
  const [oauth, setOAuth] = useState<OAuthStart | null>(null)
  const [oauthStatus, setOAuthStatus] = useState<OAuthStatus | null>(null)
  const [callbackURL, setCallbackURL] = useState("")
  const [name, setName] = useState("")
  const [apiKey, setAPIKey] = useState("")
  const [baseURL, setBaseURL] = useState("")
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
    setAPIKey("")
    setBaseURL("")
    setDocument('{\n  "type": "codex"\n}')
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
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "无法创建授权链接",
      })
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
      toast({ body: "回调已接收，正在完成连接" })
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "回调地址无效",
      })
    } finally {
      setPending(false)
    }
  }

  async function finalizeOAuth() {
    if (!oauth) return
    if (!name.trim()) {
      toast({ type: "error", body: "账户名称必填" })
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
      toast({
        body: reauthAccount ? "OAuth 账户已重新认证" : "OAuth 账户已连接",
      })
      onOpenChange(false)
      reset()
      await onSaved()
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "保存账户失败",
      })
    } finally {
      setPending(false)
    }
  }

  async function submitCredential() {
    let body: Record<string, unknown>
    if (mode === "api_key") {
      body = {
        method: "api_key",
        name,
        provider,
        api_key: apiKey,
        base_url: baseURL,
        proxy_id: proxyID,
      }
    } else {
      let parsed: unknown
      try {
        parsed = JSON.parse(document)
      } catch {
        toast({ type: "error", body: "凭据文档不是有效 JSON" })
        return
      }
      body = {
        method: "import",
        name,
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
      toast({
        body: mode === "api_key" ? "API Key 账户已添加" : "凭据已导入",
      })
      onOpenChange(false)
      reset()
      await onSaved()
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "添加失败",
      })
    } finally {
      setPending(false)
    }
  }

  const selectedOAuth = oauthProviders.find((item) => item.value === provider)
  const authorized = oauthStatus?.status === "authorized"

  return (
    <Dialog
      isOpen={open}
      onOpenChange={close}
      width={720}
      purpose="form"
    >
      <Layout
        height="auto"
        header={
          <DialogHeader
            title={reauthAccount ? "重新认证 OAuth 账户" : "连接模型账户"}
            subtitle={
              reauthAccount
                ? `为 ${displayName(reauthAccount)} 更新 OAuth 登录，不改变已有订阅分配。`
                : "选择最适合该账户的连接方式。OAuth 不需要手动复制令牌。"
            }
            onOpenChange={close}
          />
        }
        content={
          <LayoutContent>
            {authorized ? (
              <FormLayout>
                <Banner
                  status="success"
                  title="授权完成"
                  description={
                    oauthStatus.email
                      ? `已连接 ${oauthStatus.email}。保存后按账户类型建立模型目录。`
                      : "账户身份已验证。保存后按账户类型建立模型目录。"
                  }
                  collapsible={false}
                />
                <TextInput
                  label="账户名称"
                  value={name}
                  onChange={setName}
                  isRequired
                />
                <Selector
                  label="账户代理"
                  value={proxyID || "direct"}
                  onChange={(next) =>
                    setProxyID(next === "direct" || !next ? "" : next)
                  }
                  options={proxyOptions(proxies)}
                  description="应用于此账户后续的推理、令牌刷新、模型发现和额度查询。"
                />
              </FormLayout>
            ) : oauth ? (
              <VStack gap={4}>
                <Banner
                  status={oauthStatus?.status === "error" ? "error" : "info"}
                  title={selectedOAuth?.label ?? providerLabel(provider)}
                  description={
                    oauth.flow === "device"
                      ? "在提供商页面输入设备码并确认授权。"
                      : "在新页面登录并确认授权。"
                  }
                  icon={<Link2Icon />}
                  endContent={
                    <Token
                      label={
                        oauthStatus?.status === "error" ? "失败" : "等待授权"
                      }
                      color={oauthStatus?.status === "error" ? "red" : "gray"}
                    />
                  }
                  collapsible={false}
                />
                {oauth.user_code ? (
                  <CopyField
                    id="oauth-user-code"
                    label="设备码"
                    value={oauth.user_code}
                  />
                ) : null}
                <Button
                  label="打开授权页面"
                  variant="primary"
                  icon={<ExternalLinkIcon />}
                  href={oauth.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  width="100%"
                />
                {oauth.flow === "callback" ? (
                  <FormLayout>
                    <TextInput
                      label="回调地址"
                      value={callbackURL}
                      onChange={setCallbackURL}
                      placeholder="http://localhost:1455/auth/callback?code=...&state=..."
                      description="如果授权后浏览器显示无法访问 localhost，复制地址栏中的完整地址粘贴到这里。"
                    />
                    <Button
                      label="提交回调地址"
                      isDisabled={pending || !callbackURL.trim()}
                      isLoading={pending}
                      onClick={() => void submitCallback()}
                    />
                  </FormLayout>
                ) : null}
                {oauthStatus?.status === "error" ? (
                  <Banner
                    status="error"
                    title="授权未完成"
                    description={oauthStatus.error || "请取消后重试。"}
                    collapsible={false}
                  />
                ) : (
                  <HStack gap={2} vAlign="center">
                    <Spinner label="正在等待提供商确认…" />
                  </HStack>
                )}
              </VStack>
            ) : reauthAccount ? (
              <Banner
                status="info"
                title="原位更新授权"
                description="完成登录后会替换过期令牌，并保留账户设置、模型范围和所有子订阅。"
                icon={<RefreshCwIcon />}
                collapsible={false}
              />
            ) : (
              <VStack gap={4}>
                <TabList
                  value={mode}
                  onChange={(value) => {
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
                  layout="fill"
                  hasDivider
                  role="tablist"
                >
                  <Tab
                    value="oauth"
                    label="OAuth"
                    icon={<Link2Icon />}
                    panelId="connect-oauth"
                  />
                  <Tab
                    value="api_key"
                    label="API Key"
                    icon={<KeyRoundIcon />}
                    panelId="connect-api-key"
                  />
                  <Tab
                    value="import"
                    label="导入"
                    icon={<FileJson2Icon />}
                    panelId="connect-import"
                  />
                </TabList>
                {mode === "oauth" ? (
                  <VStack gap={4} id="connect-oauth">
                    <Selector
                      label="提供商"
                      value={provider}
                      onChange={setProvider}
                      options={oauthProviders.map((item) => ({
                        value: item.value,
                        label: item.label,
                        description: item.detail,
                      }))}
                      description={selectedOAuth?.detail}
                    />
                    <Banner
                      status="info"
                      title="推荐连接方式"
                      description="Relay 创建一次性授权会话。授权完成后你仍可检查账户名称和模型范围，再决定保存。"
                      icon={<Link2Icon />}
                      collapsible={false}
                    />
                  </VStack>
                ) : null}
                {mode === "api_key" ? (
                  <VStack gap={0} id="connect-api-key">
                    <CredentialFields
                      provider={provider}
                      setProvider={setProvider}
                      mode="api_key"
                      name={name}
                      setName={setName}
                      apiKey={apiKey}
                      setAPIKey={setAPIKey}
                      baseURL={baseURL}
                      setBaseURL={setBaseURL}
                      proxies={proxies}
                      proxyID={proxyID}
                      setProxyID={setProxyID}
                    />
                  </VStack>
                ) : null}
                {mode === "import" ? (
                  <VStack gap={0} id="connect-import">
                    <CredentialFields
                      provider={provider}
                      setProvider={setProvider}
                      mode="import"
                      name={name}
                      setName={setName}
                      document={document}
                      setDocument={setDocument}
                      proxies={proxies}
                      proxyID={proxyID}
                      setProxyID={setProxyID}
                    />
                  </VStack>
                ) : null}
              </VStack>
            )}
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack hAlign="end" gap={2} wrap="wrap">
              <Button label="取消" onClick={() => close(false)} />
              {authorized ? (
                <Button
                  label="保存账户"
                  variant="primary"
                  isLoading={pending}
                  onClick={() => void finalizeOAuth()}
                />
              ) : oauth ? null : mode === "oauth" ? (
                <Button
                  label={reauthAccount ? "开始重新认证" : "生成授权链接"}
                  variant="primary"
                  icon={<Link2Icon />}
                  isLoading={pending}
                  onClick={() => void startOAuth()}
                />
              ) : (
                <Button
                  label={mode === "api_key" ? "添加账户" : "验证并导入"}
                  variant="primary"
                  icon={<PlusIcon />}
                  isLoading={pending}
                  onClick={() => void submitCredential()}
                />
              )}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}

function CredentialFields({
  provider,
  setProvider,
  mode,
  name,
  setName,
  apiKey,
  setAPIKey,
  baseURL,
  setBaseURL,
  document,
  setDocument,
  proxies,
  proxyID,
  setProxyID,
}: {
  provider: string
  setProvider: (value: string) => void
  mode: "api_key" | "import"
  name: string
  setName: (value: string) => void
  apiKey?: string
  setAPIKey?: (value: string) => void
  baseURL?: string
  setBaseURL?: (value: string) => void
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
    <FormLayout>
      <FormLayout direction="horizontal">
        <TextInput
          label="账户名称"
          value={name}
          onChange={setName}
          isRequired
          placeholder="例如 主账户"
        />
        <Selector
          label="提供商"
          value={provider}
          onChange={setProvider}
          options={options}
        />
      </FormLayout>
      <Banner
        status="info"
        title="模型目录来自上游"
        description="连接成功后自动读取该凭据的模型目录，再到“管理”里勾选要对外发布的范围。"
        icon={<RefreshCwIcon />}
        collapsible={false}
      />
      {mode === "api_key" ? (
        <>
          <TextInput
            label="API Key"
            type="password"
            value={apiKey ?? ""}
            onChange={(value) => setAPIKey?.(value)}
            isRequired
            placeholder="sk-…"
          />
          <TextInput
            label="接口地址"
            value={baseURL ?? ""}
            onChange={(value) => setBaseURL?.(value)}
            isOptional
            placeholder={
              provider === "aliyun-bailian"
                ? "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
                : "https://api.example.com/v1"
            }
            description={
              provider === "aliyun-bailian"
                ? "留空使用百炼北京公共端点；其他地域、业务空间或 Token Plan 请填写对应 Base URL。"
                : "OpenAI 可留空；兼容服务填写其 Base URL。"
            }
          />
          <Selector
            label="账户代理"
            value={proxyID || "direct"}
            onChange={(next) =>
              setProxyID(next === "direct" || !next ? "" : next)
            }
            options={proxyOptions(proxies)}
            description="只影响这个模型账户；未选择时始终直连，不会继承系统代理。"
          />
        </>
      ) : (
        <>
          <TextArea
            label="凭据 JSON"
            value={document ?? ""}
            onChange={(value) => setDocument?.(value)}
            rows={10}
            isRequired
            hasSpellCheck={false}
            description="用于导入 Codex、Kimi、xAI、OpenAI 或百炼凭据。OAuth 账户请使用 OAuth 标签页。"
          />
          <Selector
            label="账户代理"
            value={proxyID || "direct"}
            onChange={(next) =>
              setProxyID(next === "direct" || !next ? "" : next)
            }
            options={proxyOptions(proxies)}
            description="导入文档中的旧代理字段会被移除，以这里选择的代理条目为准。"
          />
        </>
      )}
    </FormLayout>
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
  const toast = useToast()
  const [tab, setTab] = useState("general")
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
            toast({
              body: `已返回缓存目录：${result.warning}`,
            })
          else
            toast({
              body:
                result.source === "upstream"
                  ? "已从上游枚举模型"
                  : "已读取模型目录",
            })
        }
      } catch (cause) {
        setCandidates([])
        setSelectedModels([])
        toast({
          type: "error",
          body: cause instanceof Error ? cause.message : "无法获取模型目录",
        })
      } finally {
        setModelLoading(false)
      }
    },
    [toast]
  )

  useEffect(() => {
    if (!account) return
    setTab("general")
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
        toast({ type: "error", body: "自定义请求头必须是 JSON 对象" })
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
        toast({ type: "error", body: "替换凭据必须是有效的 JSON 对象" })
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
    <Dialog
      isOpen={Boolean(account)}
      onOpenChange={onOpenChange}
      width={720}
      purpose="form"
    >
      <Layout
        height="auto"
        header={
          <DialogHeader
            title="管理账户"
            subtitle={
              account
                ? `${providerLabel(account.provider)} · ${sourceLabel(account)}`
                : undefined
            }
            onOpenChange={onOpenChange}
          />
        }
        content={
          <LayoutContent>
            {account ? (
              <VStack gap={4}>
                <TabList
                  value={tab}
                  onChange={setTab}
                  layout="fill"
                  hasDivider
                  role="tablist"
                >
                  <Tab
                    value="general"
                    label="常规"
                    icon={<ShieldCheckIcon />}
                    panelId="manage-general"
                  />
                  <Tab
                    value="connection"
                    label="连接"
                    icon={<NetworkIcon />}
                    panelId="manage-connection"
                  />
                  <Tab
                    value="advanced"
                    label="高级"
                    icon={<FileJson2Icon />}
                    panelId="manage-advanced"
                  />
                </TabList>
                {tab === "general" ? (
                  <VStack gap={4} id="manage-general">
                    <FormLayout>
                      <TextInput
                        label="账户名称"
                        value={name}
                        onChange={setName}
                        description={
                          account.email
                            ? `授权账户：${account.email}`
                            : undefined
                        }
                      />
                    </FormLayout>
                    {isOAuthAccount(account) || account.quota_snapshot ? (
                      <VStack gap={2}>
                        <Text weight="semibold">账户额度</Text>
                        <QuotaSnapshot
                          snapshot={account.quota_snapshot}
                          status={account.quota_probe_status}
                          error={account.quota_probe_error}
                          observedAt={account.quota_observed_at}
                        />
                        {lastTest ? (
                          <Text color="secondary" type="supporting">
                            上次测试 {lastTest.ok ? "通过" : "失败"} ·{" "}
                            {lastTest.model} · {lastTest.latency_ms} ms
                          </Text>
                        ) : null}
                      </VStack>
                    ) : lastTest ? (
                      <VStack gap={1}>
                        <Text weight="semibold">上次测试</Text>
                        <Text color="secondary">
                          {lastTest.ok ? "通过" : "失败"} · {lastTest.model} ·{" "}
                          {lastTest.latency_ms} ms
                        </Text>
                      </VStack>
                    ) : null}
                    <VStack gap={3}>
                      <HStack hAlign="between" vAlign="center" gap={3}>
                        <Text weight="semibold">公开模型</Text>
                        <Button
                          label="刷新"
                          size="sm"
                          icon={<RefreshCwIcon />}
                          isLoading={modelLoading}
                          isDisabled={account.disabled}
                          tooltip={
                            account.disabled
                              ? "账户已停用；启用后才能刷新模型目录"
                              : undefined
                          }
                          onClick={() => void loadModels(account, true)}
                        />
                      </HStack>
                      <SearchField
                        value={modelSearch}
                        onChange={setModelSearch}
                        placeholder="筛选模型"
                      />
                      <HStack hAlign="between" vAlign="center" gap={3}>
                        <Text color="secondary" type="supporting">
                          已选择 {selectedModels.length} / {candidates.length}
                        </Text>
                        <HStack gap={2}>
                          <Button
                            label="全选"
                            size="sm"
                            variant="ghost"
                            isDisabled={!candidates.length || account.disabled}
                            onClick={() => setSelectedModels(candidates)}
                          />
                          <Button
                            label="清空"
                            size="sm"
                            variant="ghost"
                            isDisabled={
                              !selectedModels.length || account.disabled
                            }
                            onClick={() => setSelectedModels([])}
                          />
                        </HStack>
                      </HStack>
                      {modelLoading ? (
                        <HStack gap={2} vAlign="center">
                          <Spinner label="读取模型目录…" />
                        </HStack>
                      ) : visibleModels.length ? (
                        <CheckboxList
                          label="公开模型"
                          isLabelHidden
                          value={selectedModels}
                          onChange={setSelectedModels}
                          isDisabled={account.disabled}
                          disabledMessage="账户已停用；启用后才能刷新模型目录"
                          density="compact"
                          description="公开范围独立于凭据本身；保存后立即重建模型路由。"
                        >
                          {visibleModels.map((model) => (
                            <CheckboxListItem
                              key={model}
                              value={model}
                              label={model}
                            />
                          ))}
                        </CheckboxList>
                      ) : (
                        <Text color="secondary">
                          {account.disabled
                            ? "账户已停用；启用后才能刷新模型目录"
                            : "没有匹配的模型"}
                        </Text>
                      )}
                    </VStack>
                  </VStack>
                ) : null}
                {tab === "connection" ? (
                  <VStack gap={0} id="manage-connection">
                    <FormLayout>
                      <TextInput
                        label="上游接口地址"
                        value={baseURL}
                        onChange={setBaseURL}
                        placeholder="https://api.example.com/v1"
                        isDisabled={account.auth_kind === "oauth"}
                        disabledMessage="OAuth 端点由提供商固定，避免令牌被发送到非预期地址。"
                        description={
                          account.auth_kind === "oauth"
                            ? "OAuth 端点由提供商固定，避免令牌被发送到非预期地址。"
                            : "留空使用提供商默认端点；修改后会重新加载该账户。"
                        }
                      />
                      <Selector
                        label="账户代理"
                        value={proxyID || "direct"}
                        onChange={(next) =>
                          setProxyID(next === "direct" || !next ? "" : next)
                        }
                        options={proxyOptions(proxies)}
                        description="该选择用于此账户的推理、模型发现、令牌刷新与额度查询；未选择时明确直连。"
                      />
                      {["codex", "xai", "grok"].includes(
                        account.provider.toLowerCase()
                      ) ? (
                        <Switch
                          label="上游 WebSocket"
                          value={websockets}
                          onChange={setWebsockets}
                          labelPosition="start"
                          labelSpacing="spread"
                          width="100%"
                          description="对该账户启用原生多轮 Responses WebSocket；HTTP 与 SSE 不受影响。"
                        />
                      ) : null}
                      {account.auth_kind === "api_key" ? (
                        <TextInput
                          label="轮换 API Key"
                          type="password"
                          value={apiKey}
                          onChange={setAPIKey}
                          placeholder="留空保持现有 Key"
                          description="仅在填写时替换；现有 Key 永远不会返回浏览器。"
                        />
                      ) : null}
                    </FormLayout>
                  </VStack>
                ) : null}
                {tab === "advanced" ? (
                  <VStack gap={4} id="manage-advanced">
                    <FormLayout>
                      <TextArea
                        label="替换自定义请求头"
                        value={headersText}
                        onChange={(value) => {
                          setHeadersText(value)
                          setHeadersDirty(true)
                        }}
                        rows={6}
                        hasSpellCheck={false}
                        description={
                          account.custom_header_names?.length
                            ? `当前已配置：${account.custom_header_names.join("、")}。值不会回显；编辑后将整体替换。`
                            : 'JSON 对象，例如 {"X-Tenant":"tenant-a"}；不编辑则保持现状。'
                        }
                      />
                      {headersDirty ? (
                        <HStack gap={2} wrap="wrap">
                          <Button
                            label="清除全部请求头"
                            onClick={() => setHeadersText("{}")}
                          />
                          <Button
                            label="保留原配置"
                            variant="ghost"
                            onClick={() => {
                              setHeadersText("{}")
                              setHeadersDirty(false)
                            }}
                          />
                        </HStack>
                      ) : null}
                      {account.can_replace_document ? (
                        <TextArea
                          label="替换完整凭据 JSON"
                          value={documentText}
                          onChange={setDocumentText}
                          rows={9}
                          hasSpellCheck={false}
                          placeholder="留空保持现有加密凭据"
                          description="用于更新导入凭据、服务账户或其他高级字段。上方连接设置会覆盖同名 JSON 字段。"
                        />
                      ) : (
                        <Banner
                          status="info"
                          title="OAuth 凭据由 Relay 管理"
                          description="OAuth 令牌会自动刷新；掉登录或需要更换授权身份时，可使用下方“重新认证”。"
                          icon={<ShieldCheckIcon />}
                          collapsible={false}
                        />
                      )}
                    </FormLayout>
                  </VStack>
                ) : null}
              </VStack>
            ) : null}
          </LayoutContent>
        }
        footer={
          account ? (
            <LayoutFooter>
              <HStack hAlign="between" vAlign="center" gap={2} wrap="wrap">
                <HStack gap={2} wrap="wrap">
                  <Button
                    label="删除"
                    variant="destructive"
                    icon={<Trash2Icon />}
                    onClick={() => onDelete(account)}
                  />
                  <Button
                    label={account.disabled ? "启用" : "停用"}
                    isDisabled={pending}
                    onClick={() => void onToggle(account, !account.disabled)}
                  />
                  {isOAuthAccount(account) ? (
                    <Button
                      label="重新认证"
                      icon={<RefreshCwIcon />}
                      isDisabled={pending}
                      onClick={() => onReauthenticate(account)}
                    />
                  ) : null}
                  <Button
                    label="测试"
                    icon={<ActivityIcon />}
                    isDisabled={
                      pending ||
                      account.disabled ||
                      !publishedModels(account).length
                    }
                    tooltip={
                      account.disabled
                        ? "启用后才能测试"
                        : publishedModels(account).length
                          ? undefined
                          : "先发布至少一个模型"
                    }
                    onClick={() => onTest(account)}
                  />
                </HStack>
                <Button
                  label="保存更改"
                  variant="primary"
                  isLoading={pending}
                  isDisabled={modelLoading || !selectedModels.length}
                  onClick={save}
                />
              </HStack>
            </LayoutFooter>
          ) : undefined
        }
      />
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
  const toast = useToast()
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
        toast({ body: `${model} 可用，${next.latency_ms} ms` })
      } else {
        toast({ type: "error", body: next.error || `${model} 测试失败` })
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
      toast({ type: "error", body: message })
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      isOpen={Boolean(account)}
      onOpenChange={onOpenChange}
      width={520}
      purpose="form"
    >
      <Layout
        height="auto"
        header={
          <DialogHeader
            title="测试模型"
            subtitle={
              account
                ? `${displayName(account)} · ${providerLabel(account.provider)}`
                : undefined
            }
            onOpenChange={onOpenChange}
          />
        }
        content={
          <LayoutContent>
            <FormLayout>
              <Selector
                label="公开模型"
                value={model}
                onChange={setModel}
                options={models.map((item) => ({ value: item, label: item }))}
                hasSearch={models.length > 8}
                description="向该账户发送一次最短非流式请求。不经过用户计费，但会真实打到上游。"
              />
              {result ? (
                <Banner
                  status={result.ok ? "success" : "error"}
                  title={result.ok ? "通过" : "失败"}
                  description={`${result.status_code || "—"} · ${result.latency_ms} ms`}
                  collapsible={false}
                >
                  <Text type="code">
                    {result.preview || result.error || "上游没有返回可读内容"}
                  </Text>
                </Banner>
              ) : null}
            </FormLayout>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack hAlign="end" gap={2}>
              <Button label="关闭" onClick={() => onOpenChange(false)} />
              <Button
                label={result ? "再测一次" : "发送测试"}
                variant="primary"
                icon={<ActivityIcon />}
                isLoading={pending}
                isDisabled={!model}
                onClick={() => void run()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}

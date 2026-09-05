import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Activity01Icon,
  KeyRoundIcon,
  PlusIcon,
  RefreshCwIcon,
} from "@hugeicons/core-free-icons"
import { toast } from "@/components/ui/toast"

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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { PageHeader, SearchField } from "@/components/workspace-ui"
import {
  accountKey,
  accountStatus,
  displayName,
  modelSummary,
  providerLabel,
  publishedModels,
  quotaSummary,
  sourceLabel,
  type ProviderAccountUpdate,
} from "@/components/providers/provider-helpers"
import {
  api,
  deleteRequest,
  postJSON,
  type OutboundProxy,
  type ProviderAccount,
  type ProviderAccountTestResult,
} from "@/lib/api"

const ConnectAccountDialog = lazy(() =>
  import("@/components/providers/connect-account-dialog").then((module) => ({
    default: module.ConnectAccountDialog,
  }))
)
const ManageAccountDialog = lazy(() =>
  import("@/components/providers/manage-account-dialog").then((module) => ({
    default: module.ManageAccountDialog,
  }))
)
const TestAccountDialog = lazy(() =>
  import("@/components/providers/test-account-dialog").then((module) => ({
    default: module.TestAccountDialog,
  }))
)

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
      toast.add({
        title: cause instanceof Error ? cause.message : "无法读取模型账户",
        type: "error",
      })
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
  async function toggle(account: ProviderAccount, disabled: boolean) {
    setPending(true)
    try {
      await api(
        `/api/admin/providers/accounts/${encodeURIComponent(account.id || account.name)}`,
        { method: "PATCH", body: JSON.stringify({ disabled }) }
      )
      toast.add({
        title: disabled ? "账户已停用" : "账户已启用",
        type: "success",
      })
      setSelected(null)
      await load()
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "更新失败",
        type: "error",
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
      toast.add({
        title: failed
          ? `额度已刷新：${supported} 个账户可读取，${failed} 个失败`
          : `额度已刷新：${supported} 个账户可读取`,
        type: "success",
      })
      await load()
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "额度刷新失败",
        type: "error",
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
      toast.add({ title: "账户名称和至少一个公开模型为必填项", type: "error" })
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
      toast.add({ title: "账户设置已保存", type: "success" })
      setSelected(null)
      await load()
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "保存失败",
        type: "error",
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
      toast.add({ title: "账户已删除", type: "success" })
      setDeleting(null)
      setSelected(null)
      await load()
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "删除失败",
        type: "error",
      })
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
    <div className="flex flex-col gap-4">
      <PageHeader
        title="模型账户"
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
                <HugeiconsIcon
                  strokeWidth={2}
                  icon={RefreshCwIcon}
                  data-icon="inline-start"
                />
              )}
              刷新额度
            </Button>
            <Button
              onClick={() => {
                setReauthenticating(null)
                setConnectOpen(true)
              }}
            >
              <HugeiconsIcon
                strokeWidth={2}
                icon={PlusIcon}
                data-icon="inline-start"
              />
              连接账户
            </Button>
          </>
        }
      />

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
                          {[account.email, proxyName]
                            .filter(Boolean)
                            .join(" · ")}
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
                            <HugeiconsIcon
                              strokeWidth={2}
                              icon={Activity01Icon}
                              data-icon="inline-start"
                            />
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
                  <HugeiconsIcon strokeWidth={2} icon={KeyRoundIcon} />
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
                  <HugeiconsIcon strokeWidth={2} icon={PlusIcon} />
                  连接账户
                </Button>
              ) : null}
            </Empty>
          </CardContent>
        </Card>
      )}

      <Suspense fallback={null}>
        {connectOpen || reauthenticating ? (
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
        ) : null}
        {selected ? (
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
            lastTest={testResults[accountKey(selected)]}
            proxies={proxies}
          />
        ) : null}
        {testing ? (
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
        ) : null}
      </Suspense>

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

import {
  Fragment,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react"
import {
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/workspace-ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyContent,
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
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { LoadingView } from "@/components/loading-view"
import { LoadErrorView } from "@/components/load-error-view"
import { ModelSelector } from "@/components/model-selector"
import {
  ApiKeyModelAliasEditor,
  type ModelAliasPreset,
  type ModelAliasDraft,
} from "@/components/api-key-model-alias-editor"
import type { Page } from "@/lib/routes"
import {
  api,
  deleteRequest,
  postJSON,
  type ApiKey,
  type ChildSubscription,
  type RequestLog,
  type Session,
  type UsageReport,
} from "@/lib/api"
import { dateTime, money } from "@/lib/format"
import { copyText } from "@/lib/clipboard"
import { useAsyncResource } from "@/hooks/use-async-resource"

const LogsTable = lazy(() =>
  import("@/components/data-views").then((module) => ({
    default: module.LogsTable,
  }))
)
const UsageChart = lazy(() =>
  import("@/components/data-views").then((module) => ({
    default: module.UsageChart,
  }))
)
const UsageMetrics = lazy(() =>
  import("@/components/data-views").then((module) => ({
    default: module.UsageMetrics,
  }))
)
const UsageView = lazy(() =>
  import("@/components/usage-view").then((module) => ({
    default: module.UsageView,
  }))
)
const TenantSubscriptionsView = lazy(() =>
  import("@/components/subscriptions-view").then((module) => ({
    default: module.TenantSubscriptionsView,
  }))
)
const RequestLogsWorkbench = lazy(() =>
  import("@/components/request-logs-workbench").then((module) => ({
    default: module.RequestLogsWorkbench,
  }))
)
const ConnectionGuide = lazy(() =>
  import("@/components/connection-guide").then((module) => ({
    default: module.ConnectionGuide,
  }))
)

interface UserWorkspaceProps {
  page: Page
  session: Session
  onPageChange: (page: Page) => void
}

export function UserWorkspace({
  page,
  session,
  onPageChange,
}: UserWorkspaceProps) {
  const tenantModels = session.tenant?.model_allowlist ?? []
  if (page === "keys") return <KeysPage tenantModels={tenantModels} />
  if (page === "logs") return <RequestLogsWorkbench />
  if (page === "guide") return <GuidePage />
  if (page === "subscriptions") return <TenantSubscriptionsView />
  if (page === "usage") return <UsageView />
  return <UserOverview session={session} onPageChange={onPageChange} />
}

function KeysPage({ tenantModels }: { tenantModels: string[] }) {
  const loadKeys = useCallback(async () => {
    const value = await api<{ items: ApiKey[] }>("/api/keys")
    return value.items ?? []
  }, [])
  const {
    data: keys,
    loading,
    error: loadError,
    reload,
  } = useAsyncResource(loadKeys, {
    initialData: [],
    errorMessage: "无法读取密钥",
    onBackgroundError: (message) => toast.error(message),
  })

  if (loading) return <LoadingView />
  if (loadError && keys.length === 0) {
    return (
      <LoadErrorView message={loadError} onRetry={() => void reload(true)} />
    )
  }

  return (
    <KeysView
      keys={keys}
      tenantModels={tenantModels}
      onChanged={() => reload()}
    />
  )
}

function GuidePage() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="接入指南" />
      <ConnectionGuide />
    </div>
  )
}

function UserOverview({
  session,
  onPageChange,
}: {
  session: Session
  onPageChange: (page: Page) => void
}) {
  const loadOverview = useCallback(async () => {
    const [usage, logs, keys] = await Promise.all([
      api<UsageReport>("/api/usage?days=30"),
      api<{ items: RequestLog[] }>("/api/logs?limit=8"),
      api<{ items: ApiKey[] }>("/api/keys"),
    ])
    return {
      usage,
      logs: logs.items ?? [],
      keys: keys.items ?? [],
    }
  }, [])
  const {
    data: { usage, logs, keys },
    loading,
    error: loadError,
    reload,
  } = useAsyncResource(loadOverview, {
    initialData: {
      usage: null as UsageReport | null,
      logs: [] as RequestLog[],
      keys: [] as ApiKey[],
    },
    errorMessage: "无法读取数据",
    onBackgroundError: (message) => toast.error(message),
  })

  if (loading) return <LoadingView />
  if (!usage) {
    return (
      <LoadErrorView
        message={loadError || "账户数据不完整"}
        onRetry={() => void reload(true)}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="总览"
        actions={
          <dl className="flex items-baseline gap-5 text-sm">
            <div>
              <dt className="inline text-muted-foreground">余额 </dt>
              <dd className="inline font-medium tabular-nums">
                {money(session.tenant?.balance_nano_usd)}
              </dd>
            </div>
            <div>
              <dt className="inline text-muted-foreground">Keys </dt>
              <dd className="inline font-medium tabular-nums">
                {keys.filter((key) => key.enabled).length}
              </dd>
            </div>
          </dl>
        }
      />
      <UsageMetrics report={usage} />
      <UsageChart report={usage} />
      <LogsTable
        logs={logs}
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onPageChange("logs")}
          >
            全部日志
          </Button>
        }
      />
    </div>
  )
}

function KeysView({
  keys,
  tenantModels,
  onChanged,
}: {
  keys: ApiKey[]
  tenantModels: string[]
  onChanged: () => Promise<void>
}) {
  const [createOpen, setCreateOpen] = useState(false)
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null)
  const [pending, setPending] = useState(false)
  const [revealedKeys, setRevealedKeys] = useState<Record<string, string>>({})
  const [revealingKeyID, setRevealingKeyID] = useState("")
  const [modelOptions, setModelOptions] = useState<string[]>(tenantModels)
  const [selectedModels, setSelectedModels] = useState<string[]>(() => [
    ...tenantModels,
  ])
  const [modelAliases, setModelAliases] = useState<ModelAliasDraft[]>([])
  const modelSelectionTouched = useRef(false)

  useEffect(() => {
    let active = true
    void api<{ items: ChildSubscription[] }>("/api/subscriptions")
      .then((value) => {
        if (!active) return
        const now = Date.now()
        const subscriptionModels = (value.items ?? [])
          .filter(
            (item) =>
              item.enabled &&
              Date.parse(item.starts_at) <= now &&
              (!item.expires_at || Date.parse(item.expires_at) > now)
          )
          .flatMap(
            (item) =>
              item.effective_model_allowlist ?? item.model_allowlist ?? []
          )
        const source = [...tenantModels, ...subscriptionModels]
        setModelOptions(
          Array.from(
            new Set(source.map((model) => model.trim()).filter(Boolean))
          ).sort()
        )
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [tenantModels])

  useEffect(() => {
    if (createOpen && !modelSelectionTouched.current) {
      setSelectedModels([...modelOptions])
    }
  }, [createOpen, modelOptions])

  function openCreateDialog() {
    modelSelectionTouched.current = false
    setEditingKey(null)
    setSelectedModels([...modelOptions])
    setModelAliases([])
    setCreateOpen(true)
  }

  function openEditDialog(key: ApiKey) {
    modelSelectionTouched.current = true
    setEditingKey(key)
    setSelectedModels(key.model_allowlist ?? [])
    setModelAliases(
      (key.model_aliases ?? []).map((item) => ({
        ...item,
        clientId: item.id ?? crypto.randomUUID(),
      }))
    )
    setCreateOpen(true)
  }

  function changeSelectedModels(models: string[]) {
    modelSelectionTouched.current = true
    setSelectedModels(models)
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setPending(true)
    try {
      const response = await postJSON<{ item: ApiKey; key: string }>(
        "/api/keys",
        {
          name: String(data.get("name") ?? ""),
          rateLimitPerMinute: numberOrNull(data.get("rate")),
          tokenLimitDaily: numberOrNull(data.get("tokens")),
          modelAllowlist: selectedModels,
          modelAliases: modelAliases.map(({ alias, model }) => ({
            alias,
            model,
          })),
          expires_at: expiryPayload(String(data.get("expires_at") ?? "")),
        }
      )
      setRevealedKeys((current) => ({
        ...current,
        [response.item.id]: response.key,
      }))
      setCreateOpen(false)
      await onChanged()
      toast.success("API Key 已创建")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "创建失败")
    } finally {
      setPending(false)
    }
  }

  function applyModelAliasPreset(preset: ModelAliasPreset) {
    const presetAliases = new Set(
      preset.aliases.map((alias) => alias.toLowerCase())
    )
    modelSelectionTouched.current = true
    setSelectedModels((current) =>
      Array.from(
        new Set([
          ...current.filter((model) => !presetAliases.has(model.toLowerCase())),
          preset.target,
        ])
      )
    )
    setModelAliases((current) => [
      ...current.filter(
        (item) => !presetAliases.has(item.alias.trim().toLowerCase())
      ),
      ...preset.aliases.map((alias) => ({
        clientId: crypto.randomUUID(),
        alias,
        model: preset.target,
      })),
    ])
  }

  async function update(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editingKey) return
    const data = new FormData(event.currentTarget)
    setPending(true)
    try {
      await api<{ item: ApiKey }>(`/api/keys/${editingKey.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: String(data.get("name") ?? ""),
          enabled: editingKey.enabled,
          rateLimitPerMinute: numberOrNull(data.get("rate")),
          tokenLimitDaily: numberOrNull(data.get("tokens")),
          modelAllowlist: selectedModels,
          modelAliases: modelAliases.map(({ alias, model }) => ({
            alias,
            model,
          })),
          expires_at: expiryPayload(String(data.get("expires_at") ?? "")),
        }),
      })
      setCreateOpen(false)
      setEditingKey(null)
      await onChanged()
      toast.success("API Key 已更新")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "更新失败")
    } finally {
      setPending(false)
    }
  }

  async function renew(key: ApiKey) {
    try {
      await postJSON<{ item: ApiKey }>(`/api/keys/${key.id}/renew`, {
        days: 90,
      })
      await onChanged()
      toast.success(
        key.expires_at ? "API Key 已续期 90 天" : "此密钥没有到期时间，无需续期"
      )
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "续期失败")
    }
  }

  async function remove(id: string) {
    try {
      await deleteRequest(`/api/keys/${id}`)
      setRevealedKeys((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
      await onChanged()
      toast.success("API Key 已删除")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "删除失败")
    }
  }

  async function toggleReveal(key: ApiKey) {
    if (revealedKeys[key.id]) {
      setRevealedKeys((current) => {
        const next = { ...current }
        delete next[key.id]
        return next
      })
      return
    }
    setRevealingKeyID(key.id)
    try {
      const response = await api<{ key: string }>(`/api/keys/${key.id}/secret`)
      setRevealedKeys((current) => ({ ...current, [key.id]: response.key }))
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "无法读取完整密钥")
    } finally {
      setRevealingKeyID("")
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="API Keys"
        actions={
          <Button onClick={openCreateDialog}>
            <PlusIcon data-icon="inline-start" />
            创建 Key
          </Button>
        }
      />

      <Card>
        <CardContent>
          {keys.length ? (
            <Table pinEdges>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>前缀</TableHead>
                  <TableHead>最后使用</TableHead>
                  <TableHead>到期</TableHead>
                  <TableHead>模型 / 别名</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key) => (
                  <Fragment key={key.id}>
                    <TableRow>
                      <TableCell className="font-medium">{key.name}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {key.prefix}…
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {dateTime(key.last_used_at)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {key.expires_at ? dateTime(key.expires_at) : "永不过期"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {key.model_allowlist?.length
                          ? `${key.model_allowlist.length} 个模型`
                          : "全部模型"}{" "}
                        · {key.model_aliases?.length ?? 0} 个别名
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            !key.enabled || keyExpired(key)
                              ? "outline"
                              : "secondary"
                          }
                        >
                          {!key.enabled
                            ? "停用"
                            : keyExpired(key)
                              ? "已过期"
                              : "有效"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={
                            revealedKeys[key.id]
                              ? `隐藏 ${key.name}`
                              : `查看 ${key.name}`
                          }
                          title={
                            key.recoverable
                              ? "查看完整密钥"
                              : "旧版密钥无法恢复，请新建替换"
                          }
                          disabled={
                            !key.recoverable || revealingKeyID === key.id
                          }
                          onClick={() => void toggleReveal(key)}
                        >
                          {revealingKeyID === key.id ? (
                            <Spinner />
                          ) : revealedKeys[key.id] ? (
                            <EyeOffIcon />
                          ) : (
                            <EyeIcon />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`续期 ${key.name}`}
                          title={
                            key.expires_at ? "续期 90 天" : "此密钥没有到期时间"
                          }
                          disabled={!key.expires_at}
                          onClick={() => void renew(key)}
                        >
                          <RefreshCwIcon />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`编辑 ${key.name}`}
                          onClick={() => openEditDialog(key)}
                        >
                          <PencilIcon />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`删除 ${key.name}`}
                          onClick={() => void remove(key.id)}
                        >
                          <Trash2Icon />
                        </Button>
                      </TableCell>
                    </TableRow>
                    {revealedKeys[key.id] ? (
                      <TableRow>
                        <TableCell colSpan={7}>
                          <PlainKeyField
                            id={`plain-key-${key.id}`}
                            value={revealedKeys[key.id]}
                          />
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <KeyRoundIcon />
                </EmptyMedia>
                <EmptyTitle>还没有 API Key</EmptyTitle>
                <EmptyDescription>
                  创建密钥后即可调用所有已授权模型。
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button onClick={openCreateDialog}>
                  <PlusIcon data-icon="inline-start" />
                  创建第一个 Key
                </Button>
              </EmptyContent>
            </Empty>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open)
          if (!open) {
            setSelectedModels([])
            setModelAliases([])
            setEditingKey(null)
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingKey ? "编辑 API Key" : "创建 API Key"}
            </DialogTitle>
          </DialogHeader>
          <form
            id="key-form"
            key={editingKey?.id ?? "create"}
            onSubmit={editingKey ? update : create}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="key-name">名称</FieldLabel>
                <Input
                  id="key-name"
                  name="name"
                  defaultValue={editingKey?.name ?? ""}
                  placeholder="例如：开发环境"
                  required
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="key-rate">每分钟请求</FieldLabel>
                  <Input
                    id="key-rate"
                    name="rate"
                    type="number"
                    min="1"
                    defaultValue={editingKey?.rate_limit_per_minute ?? ""}
                    placeholder="不限"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="key-tokens">每日 Tokens</FieldLabel>
                  <Input
                    id="key-tokens"
                    name="tokens"
                    type="number"
                    min="1"
                    defaultValue={editingKey?.token_limit_daily ?? ""}
                    placeholder="不限"
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="key-models">模型范围</FieldLabel>
                <ModelSelector
                  id="key-models"
                  options={modelOptions}
                  value={selectedModels}
                  onChange={changeSelectedModels}
                  allLabel="全部可用模型"
                />
                <FieldDescription>不选择模型表示不限制。</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="key-expires">到期时间</FieldLabel>
                <Input
                  id="key-expires"
                  name="expires_at"
                  type="datetime-local"
                  defaultValue={localDateTime(editingKey?.expires_at)}
                />
                <FieldDescription>
                  留空表示永不过期。过期后可点续期，按当前到期时间再延长 90 天。
                </FieldDescription>
              </Field>
              <ApiKeyModelAliasEditor
                aliases={modelAliases}
                models={selectedModels.length ? selectedModels : modelOptions}
                availableModels={modelOptions}
                onChange={setModelAliases}
                onApplyPreset={applyModelAliasPreset}
              />
            </FieldGroup>
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button type="submit" form="key-form" disabled={pending}>
              {pending ? (
                <Spinner data-icon="inline-start" />
              ) : editingKey ? (
                <PencilIcon data-icon="inline-start" />
              ) : (
                <PlusIcon data-icon="inline-start" />
              )}
              {editingKey ? "保存" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function PlainKeyField({ id, value }: { id: string; value: string }) {
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={id}>完整密钥</FieldLabel>
        <InputGroup>
          <InputGroupInput
            id={id}
            readOnly
            value={value}
            className="font-mono text-xs"
          />
          <InputGroupAddon align="inline-end">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="复制密钥"
              onClick={() => {
                copyText(value)
                  .then(() => toast.success("已复制"))
                  .catch(() => toast.error("复制失败，请手动选择密钥"))
              }}
            >
              <CopyIcon />
            </Button>
          </InputGroupAddon>
        </InputGroup>
      </Field>
    </FieldGroup>
  )
}

function numberOrNull(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim()
  return text ? Number(text) : null
}

function expiryPayload(value: string) {
  const text = value.trim()
  if (!text) return ""
  return new Date(text).toISOString()
}

function localDateTime(value?: string | null) {
  if (!value) return ""
  const date = new Date(value)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function keyExpired(key: ApiKey, now = Date.now()) {
  return Boolean(key.expires_at && Date.parse(key.expires_at) <= now)
}

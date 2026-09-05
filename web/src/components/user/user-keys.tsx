import {
  Fragment,
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
  Trash2Icon,
} from "lucide-react"
import { toast } from "@/components/ui/toast"

import {
  ApiKeyModelAliasEditor,
  type ModelAliasDraft,
  type ModelAliasPreset,
} from "@/components/api-key-model-alias-editor"
import { LoadErrorView } from "@/components/load-error-view"
import { LoadingView } from "@/components/loading-view"
import { ModelSelector } from "@/components/model-selector"
import { PageHeader, SearchField } from "@/components/workspace-ui"
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  api,
  deleteRequest,
  postJSON,
  type ApiKey,
  type ChildSubscription,
} from "@/lib/api"
import { copyText } from "@/lib/clipboard"
import { dateTime } from "@/lib/format"
import { useAsyncResource } from "@/hooks/use-async-resource"

export function UserKeys({ tenantModels }: { tenantModels: string[] }) {
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
    onBackgroundError: (message) =>
      toast.add({ title: message, type: "error" }),
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
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState("all")
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
    if (createOpen && !modelSelectionTouched.current)
      setSelectedModels([...modelOptions])
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
        }
      )
      setRevealedKeys((current) => ({
        ...current,
        [response.item.id]: response.key,
      }))
      setCreateOpen(false)
      await onChanged()
      toast.add({ title: "API Key 已创建", type: "success" })
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "创建失败",
        type: "error",
      })
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
        }),
      })
      setCreateOpen(false)
      setEditingKey(null)
      await onChanged()
      toast.add({ title: "API Key 已更新", type: "success" })
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "更新失败",
        type: "error",
      })
    } finally {
      setPending(false)
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
      toast.add({ title: "API Key 已删除", type: "success" })
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "删除失败",
        type: "error",
      })
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
      toast.add({
        title: cause instanceof Error ? cause.message : "无法读取完整密钥",
        type: "error",
      })
    } finally {
      setRevealingKeyID("")
    }
  }

  const normalizedQuery = query.trim().toLowerCase()
  const filteredKeys = keys.filter((key) => {
    const matchesStatus =
      status === "all" || (status === "enabled" ? key.enabled : !key.enabled)
    const searchable = [
      key.name,
      key.prefix,
      ...(key.model_allowlist ?? []),
      ...(key.model_aliases ?? []).flatMap((item) => [item.alias, item.model]),
    ]
      .join(" ")
      .toLowerCase()
    return (
      matchesStatus &&
      (!normalizedQuery || searchable.includes(normalizedQuery))
    )
  })

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader
        title="API 密钥"
        description="创建、查看和管理用于调用模型的 API Key。"
        actions={
          <Button onClick={openCreateDialog}>
            <PlusIcon data-icon="inline-start" />
            创建密钥
          </Button>
        }
      />
      <Card className="min-w-0 overflow-hidden">
        <CardContent className="flex min-w-0 flex-col gap-4">
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <SearchField
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onClear={() => setQuery("")}
              placeholder="搜索名称、前缀、模型或别名"
              aria-label="搜索 API 密钥"
              className="w-full sm:max-w-sm"
            />
            <ToggleGroup
              value={[status]}
              onValueChange={(value) => value[0] && setStatus(value[0])}
              variant="outline"
              size="sm"
              aria-label="按状态筛选密钥"
              className="max-w-full flex-wrap"
            >
              <ToggleGroupItem value="all">
                全部 ({keys.length})
              </ToggleGroupItem>
              <ToggleGroupItem value="enabled">
                有效 ({keys.filter((key) => key.enabled).length})
              </ToggleGroupItem>
              <ToggleGroupItem value="disabled">
                停用 ({keys.filter((key) => !key.enabled).length})
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          {keys.length ? (
            filteredKeys.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>前缀</TableHead>
                    <TableHead>最后使用</TableHead>
                    <TableHead>模型 / 别名</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredKeys.map((key) => (
                    <Fragment key={key.id}>
                      <TableRow>
                        <TableCell className="font-medium">
                          <div className="flex flex-col gap-1">
                            <span>{key.name}</span>
                            <span className="text-xs font-normal text-muted-foreground sm:hidden">
                              状态：{key.enabled ? "有效" : "停用"}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {key.prefix}…
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {dateTime(key.last_used_at)}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {key.model_allowlist?.length
                            ? `${key.model_allowlist.length} 个模型`
                            : "全部模型"}{" "}
                          · {key.model_aliases?.length ?? 0} 个别名
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">
                            {key.enabled ? "有效" : "停用"}
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
                          <TableCell colSpan={6}>
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
                  <EmptyTitle>没有匹配的 API Key</EmptyTitle>
                  <EmptyDescription>
                    尝试清除搜索或切换状态筛选。
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setQuery("")
                      setStatus("all")
                    }}
                  >
                    清除筛选
                  </Button>
                </EmptyContent>
              </Empty>
            )
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
                  .then(() => toast.add({ title: "已复制", type: "success" }))
                  .catch(() =>
                    toast.add({
                      title: "复制失败，请手动选择密钥",
                      type: "error",
                    })
                  )
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

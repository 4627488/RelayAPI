import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { Button } from "@astryxdesign/core/Button"
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
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList"
import { NumberInput } from "@astryxdesign/core/NumberInput"
import { Tab, TabList } from "@astryxdesign/core/TabList"
import { Table, pixel, proportional } from "@astryxdesign/core/Table"
import { Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useToast } from "@astryxdesign/core/Toast"
import {
  EyeIcon,
  KeyRoundIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
} from "lucide-react"

import {
  ApiKeyModelAliasEditor,
  type ModelAliasDraft,
  type ModelAliasPreset,
} from "@/components/api-key-model-alias-editor"
import { ConnectionGuide } from "@/components/connection-guide"
import { LogsTable, LogsTableAction, UsageChart, UsageMetrics } from "@/components/data-views"
import { LoadErrorView } from "@/components/load-error-view"
import { LoadingView } from "@/components/loading-view"
import { ModelSelector } from "@/components/model-selector"
import { CopyField, PageFrame, StatusLabel } from "@/components/page-kit"
import { RequestLogsWorkbench } from "@/components/request-logs-workbench"
import { TenantSubscriptionsView } from "@/components/subscriptions-view"
import { UsageView } from "@/components/usage-view"
import type { Page } from "@/components/app-shell"
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
import { dateTime } from "@/lib/format"

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
  if (page === "keys" || page === "guide") {
    return (
      <KeysPage
        tenantModels={tenantModels}
        initialTab={page === "guide" ? "guide" : "keys"}
      />
    )
  }
  if (page === "logs") return <RequestLogsWorkbench />
  if (page === "usage" || page === "subscriptions") {
    return (
      <UsageHub initialTab={page === "subscriptions" ? "subscriptions" : "usage"} />
    )
  }
  return <UserOverview session={session} onPageChange={onPageChange} />
}

function UsageHub({ initialTab }: { initialTab: "usage" | "subscriptions" }) {
  const [tab, setTab] = useState(initialTab)
  const tabs = (
    <TabList
      value={tab}
      onChange={(value) => {
        if (value === "usage" || value === "subscriptions") setTab(value)
      }}
    >
      <Tab value="usage" label="用量" />
      <Tab value="subscriptions" label="订阅" />
    </TabList>
  )
  if (tab === "subscriptions") {
    return <TenantSubscriptionsView accessory={tabs} />
  }
  return <UsageView accessory={tabs} />
}

function KeysPage({
  tenantModels,
  initialTab,
}: {
  tenantModels: string[]
  initialTab: "keys" | "guide"
}) {
  const [tab, setTab] = useState(initialTab)
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")

  const load = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    setLoadError("")
    try {
      const keysValue = await api<{ items: ApiKey[] }>("/api/keys")
      setKeys(keysValue.items ?? [])
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "无法读取密钥"
      setLoadError(message)
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(true)
  }, [load])

  const tabs = (
    <TabList
      value={tab}
      onChange={(value) => {
        if (value === "keys" || value === "guide") setTab(value)
      }}
    >
      <Tab value="keys" label="密钥" />
      <Tab value="guide" label="接入" />
    </TabList>
  )

  if (loading) return <LoadingView />
  if (loadError && keys.length === 0) {
    return <LoadErrorView message={loadError} onRetry={() => void load(true)} />
  }
  if (tab === "guide") {
    return <ConnectionGuide keys={keys} tenantModels={tenantModels} accessory={tabs} />
  }
  return (
    <KeysView
      keys={keys}
      tenantModels={tenantModels}
      accessory={tabs}
      onChanged={() => load()}
    />
  )
}

function UserOverview({
  session,
  onPageChange,
}: {
  session: Session
  onPageChange: (page: Page) => void
}) {
  const toast = useToast()
  const [usage, setUsage] = useState<UsageReport | null>(null)
  const [logs, setLogs] = useState<RequestLog[]>([])
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")

  const load = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    setLoadError("")
    try {
      const [usageValue, logsValue, keysValue] = await Promise.all([
        api<UsageReport>("/api/usage?days=30"),
        api<{ items: RequestLog[] }>("/api/logs?limit=8"),
        api<{ items: ApiKey[] }>("/api/keys"),
      ])
      setUsage(usageValue)
      setLogs(logsValue.items ?? [])
      setKeys(keysValue.items ?? [])
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "无法读取数据"
      setLoadError(message)
      if (!showLoading) toast({ type: "error", body: message })
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void load(true)
  }, [load])

  if (loading) return <LoadingView />
  if (!usage) {
    return (
      <LoadErrorView
        message={loadError || "账户数据不完整"}
        onRetry={() => void load(true)}
      />
    )
  }

  return (
    <PageFrame title={session.tenant?.name || "工作台"}>
      <VStack gap={0}>
        <UsageMetrics report={usage} />
        <UsageChart report={usage} />
        <PageSectionAccount session={session} keys={keys} />
        <LogsTable
          logs={logs}
          action={<LogsTableAction onOpen={() => onPageChange("logs")} />}
        />
      </VStack>
    </PageFrame>
  )
}

function PageSectionAccount({
  session,
  keys,
}: {
  session: Session
  keys: ApiKey[]
}) {
  return (
    <VStack gap={0} padding={5}>
      <MetadataList title="账户" columns="multi">
        <MetadataListItem label="状态">
          <StatusLabel tone="success" label="正常" />
        </MetadataListItem>
        <MetadataListItem label="余额">
          {moneySafe(session.tenant?.balance_nano_usd)}
        </MetadataListItem>
        <MetadataListItem label="有效 Keys">
          {String(keys.filter((key) => key.enabled).length)}
        </MetadataListItem>
        <MetadataListItem label="模型范围">
          {session.tenant?.model_allowlist?.length
            ? `${session.tenant.model_allowlist.length} 个`
            : "全部模型"}
        </MetadataListItem>
      </MetadataList>
    </VStack>
  )
}

function moneySafe(value: number | undefined) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format((value ?? 0) / 1_000_000_000)
}

function KeysView({
  keys,
  tenantModels,
  accessory,
  onChanged,
}: {
  keys: ApiKey[]
  tenantModels: string[]
  accessory?: ReactNode
  onChanged: () => Promise<void>
}) {
  const toast = useToast()
  const [editorOpen, setEditorOpen] = useState(false)
  const [revealed, setRevealed] = useState<{ id: string; value: string } | null>(
    null
  )
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null)
  const [pending, setPending] = useState(false)
  const [name, setName] = useState("")
  const [rate, setRate] = useState<number | null>(null)
  const [tokens, setTokens] = useState<number | null>(null)
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
            (item) => item.effective_model_allowlist ?? item.model_allowlist ?? []
          )
        setModelOptions(
          Array.from(
            new Set(
              [...tenantModels, ...subscriptionModels]
                .map((model) => model.trim())
                .filter(Boolean)
            )
          ).sort()
        )
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [tenantModels])

  function openCreate() {
    modelSelectionTouched.current = false
    setEditingKey(null)
    setName("")
    setRate(null)
    setTokens(null)
    setSelectedModels([...modelOptions])
    setModelAliases([])
    setEditorOpen(true)
  }

  function openEdit(key: ApiKey) {
    modelSelectionTouched.current = true
    setEditingKey(key)
    setName(key.name)
    setRate(key.rate_limit_per_minute)
    setTokens(key.token_limit_daily)
    setSelectedModels(key.model_allowlist ?? [])
    setModelAliases(
      (key.model_aliases ?? []).map((item) => ({
        ...item,
        clientId: item.id ?? crypto.randomUUID(),
      }))
    )
    setEditorOpen(true)
  }

  async function save() {
    setPending(true)
    try {
      const payload = {
        name,
        rateLimitPerMinute: rate,
        tokenLimitDaily: tokens,
        modelAllowlist: selectedModels,
        modelAliases: modelAliases.map(({ alias, model }) => ({ alias, model })),
      }
      if (editingKey) {
        await api(`/api/keys/${editingKey.id}`, {
          method: "PUT",
          body: JSON.stringify({ ...payload, enabled: editingKey.enabled }),
        })
        toast({ body: "API Key 已更新" })
      } else {
        const response = await postJSON<{ item: ApiKey; key: string }>(
          "/api/keys",
          payload
        )
        setRevealed({ id: response.item.id, value: response.key })
        toast({ body: "API Key 已创建" })
      }
      setEditorOpen(false)
      await onChanged()
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "保存失败",
      })
    } finally {
      setPending(false)
    }
  }

  interface KeyRow extends Record<string, unknown> {
    id: string
    name: string
    prefix: string
    last_used_at: string | null
    models: string
    enabled: boolean
    recoverable: boolean
    key: ApiKey
  }

  const rows: KeyRow[] = keys.map((key) => ({
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    last_used_at: key.last_used_at,
    models: `${key.model_allowlist?.length ? `${key.model_allowlist.length} 个模型` : "全部模型"} · ${key.model_aliases?.length ?? 0} 个别名`,
    enabled: key.enabled,
    recoverable: key.recoverable,
    key,
  }))

  return (
    <>
    <PageFrame
      title="密钥"
      accessory={accessory}
      actions={
        <Button
          label="创建 Key"
          variant="primary"
          icon={<PlusIcon />}
          onClick={openCreate}
        />
      }
    >
        {rows.length ? (
          <Table
            data={rows}
            idKey="id"
            density="compact"
            hasHover
            textOverflow="truncate"
            columns={[
              { key: "name", header: "名称", width: proportional(1) },
              {
                key: "prefix",
                header: "前缀",
                width: pixel(140),
                renderCell: (row) => <Text type="code">{row.prefix}…</Text>,
              },
              {
                key: "last_used_at",
                header: "最后使用",
                width: pixel(140),
                renderCell: (row) => (
                  <Text color="secondary">{dateTime(row.last_used_at)}</Text>
                ),
              },
              { key: "models", header: "模型 / 别名", width: proportional(1) },
              {
                key: "enabled",
                header: "状态",
                width: pixel(90),
                renderCell: (row) => (
                  <StatusLabel
                    tone={row.enabled ? "success" : "neutral"}
                    label={row.enabled ? "有效" : "停用"}
                  />
                ),
              },
              {
                key: "actions",
                header: "操作",
                width: pixel(72),
                align: "end",
                renderCell: (row) => (
                  <DropdownMenu
                    hasChevron={false}
                    button={{
                      label: `操作 ${row.name}`,
                      variant: "ghost",
                      isIconOnly: true,
                      icon: <MoreHorizontalIcon />,
                    }}
                    items={[
                      {
                        label: "查看密钥",
                        icon: <EyeIcon />,
                        isDisabled: !row.recoverable,
                        onClick: () => {
                          void api<{ key: string }>(`/api/keys/${row.id}/secret`)
                            .then((response) =>
                              setRevealed({ id: row.id, value: response.key })
                            )
                            .catch((cause) =>
                              toast({
                                type: "error",
                                body:
                                  cause instanceof Error
                                    ? cause.message
                                    : "无法读取完整密钥",
                              })
                            )
                        },
                      },
                      {
                        label: "编辑",
                        icon: <PencilIcon />,
                        onClick: () => openEdit(row.key),
                      },
                      { type: "divider" },
                      {
                        label: "删除",
                        variant: "destructive",
                        onClick: () => {
                          void deleteRequest(`/api/keys/${row.id}`)
                            .then(async () => {
                              await onChanged()
                              toast({ body: "API Key 已删除" })
                            })
                            .catch((cause) =>
                              toast({
                                type: "error",
                                body:
                                  cause instanceof Error
                                    ? cause.message
                                    : "删除失败",
                              })
                            )
                        },
                      },
                    ]}
                  />
                ),
              },
            ]}
          />
        ) : (
          <EmptyState
            title="还没有 API Key"
            description="创建密钥后即可调用所有已授权模型。"
            icon={<KeyRoundIcon />}
            actions={
              <Button
                label="创建第一个 Key"
                variant="primary"
                icon={<PlusIcon />}
                onClick={openCreate}
              />
            }
          />
        )}
    </PageFrame>

      <Dialog
        isOpen={editorOpen}
        onOpenChange={setEditorOpen}
        width={640}
        purpose="form"
      >
        <Layout
          height="auto"
          header={
            <DialogHeader
              title={editingKey ? "编辑 API Key" : "创建 API Key"}
              subtitle={
                editingKey
                  ? "修改模型范围和客户端可用的模型别名。"
                  : "限制留空表示继承账户策略。创建后可随时查看完整密钥。"
              }
              onOpenChange={setEditorOpen}
            />
          }
          content={
            <LayoutContent>
              <FormLayout>
                <TextInput label="名称" value={name} onChange={setName} isRequired />
                <HStack gap={3}>
                  <NumberInput
                    label="每分钟请求"
                    value={rate ?? undefined}
                    onChange={(value) => setRate(value ?? null)}
                    isOptional
                  />
                  <NumberInput
                    label="每日 Tokens"
                    value={tokens ?? undefined}
                    onChange={(value) => setTokens(value ?? null)}
                    isOptional
                  />
                </HStack>
                <ModelSelector
                  options={modelOptions}
                  value={selectedModels}
                  onChange={(models) => {
                    modelSelectionTouched.current = true
                    setSelectedModels(models)
                  }}
                />
                <ApiKeyModelAliasEditor
                  aliases={modelAliases}
                  models={selectedModels.length ? selectedModels : modelOptions}
                  availableModels={modelOptions}
                  onChange={setModelAliases}
                  onApplyPreset={(preset: ModelAliasPreset) => {
                    const presetAliases = new Set(
                      preset.aliases.map((alias) => alias.toLowerCase())
                    )
                    setSelectedModels((current) =>
                      Array.from(
                        new Set([
                          ...current.filter(
                            (model) => !presetAliases.has(model.toLowerCase())
                          ),
                          preset.target,
                        ])
                      )
                    )
                    setModelAliases((current) => [
                      ...current.filter(
                        (item) =>
                          !presetAliases.has(item.alias.trim().toLowerCase())
                      ),
                      ...preset.aliases.map((alias) => ({
                        clientId: crypto.randomUUID(),
                        alias,
                        model: preset.target,
                      })),
                    ])
                  }}
                />
              </FormLayout>
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack hAlign="end" gap={2}>
                <Button label="取消" onClick={() => setEditorOpen(false)} />
                <Button
                  label={editingKey ? "保存" : "创建"}
                  variant="primary"
                  isLoading={pending}
                  onClick={() => void save()}
                />
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>

      <Dialog
        isOpen={Boolean(revealed)}
        onOpenChange={(open) => {
          if (!open) setRevealed(null)
        }}
        width={520}
        purpose="info"
      >
        <Layout
          height="auto"
          header={
            <DialogHeader
              title="完整密钥"
              subtitle="关闭后仍可再次查看可恢复的密钥。"
              onOpenChange={(open) => {
                if (!open) setRevealed(null)
              }}
            />
          }
          content={
            <LayoutContent>
              <CopyField
                id="revealed-key"
                label="API Key"
                value={revealed?.value ?? ""}
              />
            </LayoutContent>
          }
        />
      </Dialog>
    </>
  )
}

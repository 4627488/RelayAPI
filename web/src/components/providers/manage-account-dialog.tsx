import { useCallback, useEffect, useMemo, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Activity01Icon,
  Tick02Icon,
  FileIcon,
  MoreHorizontalIcon,
  NetworkIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Delete02Icon,
} from "@hugeicons/core-free-icons"
import { toast } from "@/components/ui/toast"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { QuotaSnapshot } from "@/components/quota-snapshot"
import {
  api,
  type OutboundProxy,
  type ProviderAccount,
  type ProviderAccountTestResult,
} from "@/lib/api"
import {
  displayName,
  isOAuthAccount,
  providerLabel,
  publishedModels,
  sourceLabel,
  type ProviderAccountUpdate,
} from "@/components/providers/provider-helpers"

export function ManageAccountDialog({
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
            toast.add({
              title: "已返回缓存目录",
              type: "warning",
              description: result.warning,
            })
          else
            toast.add({
              title:
                result.source === "upstream"
                  ? "已从上游枚举模型"
                  : "已读取模型目录",
              type: "success",
            })
        }
      } catch (cause) {
        setCandidates([])
        setSelectedModels([])
        toast.add({
          title: cause instanceof Error ? cause.message : "无法获取模型目录",
          type: "error",
        })
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
        toast.add({ title: "自定义请求头必须是 JSON 对象", type: "error" })
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
        toast.add({ title: "替换凭据必须是有效的 JSON 对象", type: "error" })
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
                  <HugeiconsIcon strokeWidth={2} icon={ShieldCheckIcon} />
                  常规
                </TabsTrigger>
                <TabsTrigger value="connection">
                  <HugeiconsIcon strokeWidth={2} icon={NetworkIcon} />
                  连接
                </TabsTrigger>
                <TabsTrigger value="advanced">
                  <HugeiconsIcon strokeWidth={2} icon={FileIcon} />
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
                          <HugeiconsIcon
                            strokeWidth={2}
                            icon={RefreshCwIcon}
                            data-icon="inline-start"
                          />
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
                    <FieldGroup className="max-h-64 overflow-y-auto p-3">
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
                      <HugeiconsIcon strokeWidth={2} icon={ShieldCheckIcon} />
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
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={
                    pending ||
                    account.disabled ||
                    !publishedModels(account).length
                  }
                  onClick={() => onTest(account)}
                >
                  <HugeiconsIcon
                    strokeWidth={2}
                    icon={Activity01Icon}
                    data-icon="inline-start"
                  />
                  测试
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="outline" />}>
                    <HugeiconsIcon
                      strokeWidth={2}
                      icon={MoreHorizontalIcon}
                      data-icon="inline-start"
                    />
                    更多
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuGroup>
                      <DropdownMenuItem
                        disabled={pending}
                        onClick={() =>
                          void onToggle(account, !account.disabled)
                        }
                      >
                        {account.disabled ? "启用账户" : "停用账户"}
                      </DropdownMenuItem>
                      {isOAuthAccount(account) ? (
                        <DropdownMenuItem
                          disabled={pending}
                          onClick={() => onReauthenticate(account)}
                        >
                          <HugeiconsIcon strokeWidth={2} icon={RefreshCwIcon} />
                          重新认证
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => onDelete(account)}
                      >
                        <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
                        删除账户
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <Button
                disabled={pending || modelLoading || !selectedModels.length}
                onClick={save}
              >
                {pending ? (
                  <Spinner />
                ) : (
                  <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} />
                )}
                保存更改
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

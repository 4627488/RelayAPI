import { useEffect, useRef, useState } from "react"
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
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { AccountStatusPanel } from "@/components/providers/account-status-panel"
import { SearchField } from "@/components/workspace-ui"
import {
  api,
  type OutboundProxy,
  type ProviderAccount,
  type ProviderAccountTestResult,
} from "@/lib/api"
import {
  accountKey,
  accountStatus,
  displayName,
  isOAuthAccount,
  providerLabel,
  sourceLabel,
  type ProviderAccountUpdate,
} from "./provider-helpers"

type Props = {
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
}
export function ManageAccountDialog(props: Props) {
  return props.account ? (
    <AccountDetails
      key={accountKey(props.account)}
      {...props}
      account={props.account}
    />
  ) : null
}
function AccountDetails({
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
}: Props & { account: ProviderAccount }) {
  const [tab, setTab] = useState("status")
  const [name, setName] = useState(displayName(account))
  const [baseURL, setBaseURL] = useState(account.base_url ?? "")
  const [proxyID, setProxyID] = useState(account.proxy_id ?? "")
  const [websockets, setWebsockets] = useState(account.websockets ?? false)
  const [selectedModels, setSelectedModels] = useState(account.models ?? [])
  const [candidates, setCandidates] = useState(account.models ?? [])
  const [query, setQuery] = useState("")
  const [catalogSource, setCatalogSource] = useState("当前已发布模型")
  const [catalogError, setCatalogError] = useState("")
  const [modelLoading, setModelLoading] = useState(false)
  const [apiKey, setAPIKey] = useState("")
  const [headerMode, setHeaderMode] = useState("keep")
  const [headers, setHeaders] = useState([{ name: "", value: "" }])
  const [documentText, setDocumentText] = useState("")
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  const oauth = isOAuthAccount(account)
  const supportsWebsocket = ["codex", "xai", "grok"].includes(
    account.provider.toLowerCase()
  )
  const status = accountStatus(account)
  const busy = pending || saving
  const modelsDirty =
    JSON.stringify([...selectedModels].sort()) !==
    JSON.stringify([...(account.models ?? [])].sort())
  const connectionDirty =
    name !== displayName(account) ||
    baseURL !== (account.base_url ?? "") ||
    proxyID !== (account.proxy_id ?? "") ||
    websockets !== (account.websockets ?? false)
  const credentialsDirty = Boolean(
    apiKey.trim() || documentText.trim() || headerMode !== "keep"
  )
  const dirty = modelsDirty || connectionDirty || credentialsDirty
  const dirtyPages = [
    modelsDirty && "模型发布",
    connectionDirty && "连接设置",
    credentialsDirty && "凭据",
  ]
    .filter(Boolean)
    .join("、")
  const currentDirty =
    tab === "models"
      ? modelsDirty
      : tab === "connection"
        ? connectionDirty
        : tab === "credentials"
          ? credentialsDirty
          : false
  const allModels = [
    ...new Map(
      [...candidates, ...selectedModels].map((model) => [
        model.toLowerCase(),
        model,
      ])
    ).values(),
  ].sort()
  const visible = allModels.filter((model) =>
    model.toLowerCase().includes(query.trim().toLowerCase())
  )
  const missing = selectedModels.filter(
    (model) =>
      !candidates.some(
        (candidate) => candidate.toLowerCase() === model.toLowerCase()
      )
  )
  function close(open: boolean) {
    if (open || busy) return
    if (dirty) setDiscardOpen(true)
    else onOpenChange(false)
  }
  async function refreshModels() {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setModelLoading(true)
    setCatalogError("")
    try {
      const result = await api<{
        models: string[]
        source: string
        warning?: string
      }>(
        `/api/admin/providers/accounts/${encodeURIComponent(accountKey(account))}/models`,
        { signal: controller.signal }
      )
      if (controller.signal.aborted) return
      setCandidates(result.models ?? [])
      setCatalogSource(
        result.source === "upstream"
          ? "上游实时目录"
          : result.source === "configured"
            ? "当前配置目录"
            : "提供商目录 / 缓存"
      )
      setCatalogError(result.warning ?? "")
    } catch (cause) {
      if (!controller.signal.aborted)
        setCatalogError(
          cause instanceof Error ? cause.message : "模型目录读取失败"
        )
    } finally {
      if (!controller.signal.aborted) setModelLoading(false)
    }
  }
  async function save() {
    setError("")
    const value: ProviderAccountUpdate = {
      name: displayName(account),
      proxy_id: account.proxy_id ?? "",
    }
    if (tab === "models") {
      if (!selectedModels.length) {
        setError("至少发布一个模型；如需停止接收请求，请停用账户。")
        return
      }
      value.models = selectedModels
    } else if (tab === "connection") {
      if (!name.trim()) {
        setError("请填写账户名称。")
        return
      }
      if (!oauth && baseURL.trim()) {
        try {
          const url = new URL(baseURL.trim())
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password
          )
            throw new Error()
        } catch {
          setError("接口地址需为有效的 HTTP(S) 地址，凭据请在凭据页填写。")
          return
        }
      }
      value.name = name.trim()
      value.proxy_id = proxyID
      if (!oauth) value.base_url = baseURL.trim()
      if (supportsWebsocket) value.websockets = websockets
    } else if (tab === "credentials") {
      if (apiKey.trim()) value.api_key = apiKey.trim()
      if (headerMode === "clear") value.headers = {}
      if (headerMode === "replace") {
        const rows = headers.filter((row) => row.name.trim() || row.value)
        const names = rows.map((row) => row.name.trim().toLowerCase())
        if (
          !rows.length ||
          rows.some(
            (row) =>
              !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(row.name.trim()) ||
              /[\r\n]/.test(row.value)
          ) ||
          new Set(names).size !== rows.length
        ) {
          setError(
            "请填写有效且不重复的请求头名称；值不能包含换行。清空配置请选“清除全部”。"
          )
          return
        }
        value.headers = Object.fromEntries(
          rows.map((row) => [row.name.trim(), row.value])
        )
      }
      if (documentText.trim()) {
        try {
          const parsed: unknown = JSON.parse(documentText)
          if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
            throw new Error()
          value.document = parsed as Record<string, unknown>
        } catch {
          setError("替换凭据必须是有效的 JSON 对象。")
          return
        }
      }
    }
    setSaving(true)
    try {
      await onSave(account, value)
      if (tab === "connection") {
        setName(name.trim())
        setBaseURL(baseURL.trim())
      }
      if (tab === "credentials") {
        setAPIKey("")
        setDocumentText("")
        setHeaderMode("keep")
        setHeaders([{ name: "", value: "" }])
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败，请重试。")
    } finally {
      setSaving(false)
    }
  }
  return (
    <>
      <Sheet open onOpenChange={close}>
        <SheetContent
          className="data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
          showCloseButton={!busy}
        >
          <SheetHeader>
            <SheetTitle>{displayName(account)}</SheetTitle>
            <SheetDescription>
              {providerLabel(account.provider)} · {sourceLabel(account)}
              {account.email ? ` · ${account.email}` : ""}
            </SheetDescription>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={status.variant}>{status.label}</Badge>
              {account.plan_type ? (
                <Badge variant="secondary">{account.plan_type}</Badge>
              ) : null}
              <span className="text-xs text-muted-foreground">
                已发布 {account.models?.length ?? 0} 个模型
              </span>
            </div>
          </SheetHeader>
          <Tabs
            value={tab}
            onValueChange={(value) => {
              setTab(String(value))
              setError("")
            }}
            className="min-h-0 flex-1 px-6"
          >
            <TabsList variant="line" className="w-full shrink-0">
              <TabsTrigger disabled={busy} value="status">
                运行状态
              </TabsTrigger>
              <TabsTrigger disabled={busy} value="models">
                模型发布
              </TabsTrigger>
              <TabsTrigger disabled={busy} value="connection">
                连接设置
              </TabsTrigger>
              <TabsTrigger disabled={busy} value="credentials">
                凭据
              </TabsTrigger>
            </TabsList>
            <fieldset
              disabled={busy}
              className="min-h-0 min-w-0 flex-1 overflow-y-auto py-3"
            >
              <TabsContent value="status">
                <AccountStatusPanel
                  account={account}
                  proxies={proxies}
                  lastTest={lastTest}
                  busy={busy}
                  dirty={dirty}
                  onTest={onTest}
                  onToggle={onToggle}
                  onDelete={onDelete}
                  onReauthenticate={onReauthenticate}
                  onEditCredentials={() => setTab("credentials")}
                />
              </TabsContent>
              <TabsContent value="models" className="flex flex-col gap-3">
                <FieldDescription>
                  勾选的模型会出现在用户可用目录中，并参与该账户的请求路由。刷新目录不会自动改变发布范围。
                </FieldDescription>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs">
                    已选 {selectedModels.length} / 目录 {candidates.length}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={account.disabled || modelLoading || busy}
                    onClick={() => void refreshModels()}
                  >
                    {modelLoading ? <Spinner data-icon="inline-start" /> : null}
                    刷新模型目录
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {catalogSource}
                  {account.disabled ? " · 启用账户后可修改发布范围" : ""}
                </p>
                {catalogError ? (
                  <Alert>
                    <AlertTitle>目录刷新未完全成功</AlertTitle>
                    <AlertDescription>
                      {catalogError}。已保留当前选择。
                    </AlertDescription>
                  </Alert>
                ) : null}
                {missing.length ? (
                  <Alert>
                    <AlertTitle>
                      有 {missing.length} 个已选模型不在本次目录中
                    </AlertTitle>
                    <AlertDescription>
                      已保留它们，避免静默取消发布；请检查上游或明确取消选择后再保存。
                    </AlertDescription>
                  </Alert>
                ) : null}
                <SearchField
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onClear={() => setQuery("")}
                  placeholder="搜索模型"
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={account.disabled || !visible.length || busy}
                    onClick={() =>
                      setSelectedModels((current) => [
                        ...new Set([...current, ...visible]),
                      ])
                    }
                  >
                    选择搜索结果
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={
                      account.disabled || !selectedModels.length || busy
                    }
                    onClick={() =>
                      setSelectedModels((current) =>
                        current.filter((model) => !visible.includes(model))
                      )
                    }
                  >
                    取消搜索结果
                  </Button>
                </div>
                <FieldGroup>
                  {visible.map((model, index) => (
                    <Field key={model} orientation="horizontal">
                      <Checkbox
                        id={`publish-model-${index}`}
                        checked={selectedModels.includes(model)}
                        disabled={account.disabled || busy}
                        onCheckedChange={(checked) =>
                          setSelectedModels((current) =>
                            checked
                              ? [...new Set([...current, model])]
                              : current.filter((item) => item !== model)
                          )
                        }
                      />
                      <FieldLabel htmlFor={`publish-model-${index}`}>
                        {model}
                      </FieldLabel>
                    </Field>
                  ))}
                  {!visible.length ? (
                    <FieldDescription>
                      没有匹配的模型。可清除搜索或刷新目录。
                    </FieldDescription>
                  ) : null}
                </FieldGroup>
              </TabsContent>
              <TabsContent value="connection">
                <FieldGroup>
                  <Field orientation="responsive">
                    <FieldLabel htmlFor="manage-account-name">
                      账户名称
                    </FieldLabel>
                    <FieldContent>
                      <Input
                        id="manage-account-name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </FieldContent>
                  </Field>
                  <Field orientation="responsive">
                    <FieldLabel htmlFor="manage-base-url">接口地址</FieldLabel>
                    <FieldContent>
                      <Input
                        id="manage-base-url"
                        type="url"
                        value={baseURL}
                        onChange={(event) => setBaseURL(event.target.value)}
                        disabled={oauth}
                        placeholder="提供商默认地址"
                      />
                      <FieldDescription>
                        {oauth
                          ? "OAuth 使用提供商固定端点。"
                          : "填写兼容接口的基础地址；留空使用提供商默认值。"}
                      </FieldDescription>
                    </FieldContent>
                  </Field>
                  <Field orientation="responsive">
                    <FieldLabel htmlFor="manage-proxy">账户代理</FieldLabel>
                    <FieldContent>
                      <Select
                        value={proxyID || "direct"}
                        items={[
                          { value: "direct", label: "直连上游" },
                          ...proxies.map((item) => ({
                            value: item.id,
                            label: item.name,
                          })),
                        ]}
                        onValueChange={(value) =>
                          setProxyID(value === "direct" || !value ? "" : value)
                        }
                      >
                        <SelectTrigger id="manage-proxy" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="direct">直连上游</SelectItem>
                            {proxies.map((item) => (
                              <SelectItem key={item.id} value={item.id}>
                                {item.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <FieldDescription>
                        {proxyID
                          ? proxies.find((item) => item.id === proxyID)
                              ?.endpoint || "当前代理详情不可用"
                          : "推理、模型发现、令牌刷新与额度查询均直连。"}
                      </FieldDescription>
                    </FieldContent>
                  </Field>
                  {supportsWebsocket ? (
                    <Field orientation="horizontal">
                      <FieldContent>
                        <FieldLabel htmlFor="manage-websockets">
                          上游 WebSocket
                        </FieldLabel>
                        <FieldDescription>
                          支持原生多轮 Responses；HTTP 和 SSE 仍可使用。
                        </FieldDescription>
                      </FieldContent>
                      <Switch
                        id="manage-websockets"
                        checked={websockets}
                        onCheckedChange={setWebsockets}
                      />
                    </Field>
                  ) : null}
                  <FieldDescription>
                    保存连接不会重新发布模型。修改地址或代理后，请先测试，再刷新模型目录。
                  </FieldDescription>
                </FieldGroup>
              </TabsContent>
              <TabsContent value="credentials">
                <FieldGroup>
                  {account.auth_kind === "api_key" ? (
                    <Field>
                      <FieldLabel htmlFor="manage-api-key">
                        替换 API Key
                      </FieldLabel>
                      <Input
                        id="manage-api-key"
                        type="password"
                        autoComplete="new-password"
                        value={apiKey}
                        onChange={(event) => setAPIKey(event.target.value)}
                        placeholder="留空保留当前密钥"
                      />
                      <FieldDescription>
                        已保存的密钥不会回显。
                      </FieldDescription>
                    </Field>
                  ) : null}
                  {oauth ? (
                    <Alert>
                      <AlertTitle>OAuth 授权</AlertTitle>
                      <AlertDescription>
                        令牌由系统自动刷新。需要更换身份时，请在运行状态中重新授权。
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  <FieldSet>
                    <FieldLegend>自定义请求头</FieldLegend>
                    <FieldDescription>
                      {account.custom_header_names?.length
                        ? `已配置：${account.custom_header_names.join("、")}。现有值不会回显。`
                        : "未配置自定义请求头。"}
                    </FieldDescription>
                    <Field>
                      <FieldLabel htmlFor="header-mode">修改方式</FieldLabel>
                      <Select
                        value={headerMode}
                        items={[
                          { value: "keep", label: "保留当前配置" },
                          { value: "replace", label: "整体替换" },
                          { value: "clear", label: "清除全部" },
                        ]}
                        onValueChange={(value) =>
                          setHeaderMode(value || "keep")
                        }
                      >
                        <SelectTrigger id="header-mode" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="keep">保留当前配置</SelectItem>
                            <SelectItem value="replace">整体替换</SelectItem>
                            <SelectItem value="clear">清除全部</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                    {headerMode === "replace" ? (
                      <>
                        <FieldDescription>
                          保存后只保留下方请求头；请填写所有需要保留的项。
                        </FieldDescription>
                        {headers.map((row, index) => (
                          <div
                            key={index}
                            className="grid grid-cols-[1fr_1fr_auto] items-end gap-2"
                          >
                            <Field>
                              <FieldLabel htmlFor={`header-name-${index}`}>
                                名称 {index + 1}
                              </FieldLabel>
                              <Input
                                id={`header-name-${index}`}
                                value={row.name}
                                onChange={(event) =>
                                  setHeaders((current) =>
                                    current.map((item, i) =>
                                      i === index
                                        ? { ...item, name: event.target.value }
                                        : item
                                    )
                                  )
                                }
                                placeholder="X-Tenant"
                              />
                            </Field>
                            <Field>
                              <FieldLabel htmlFor={`header-value-${index}`}>
                                值 {index + 1}
                              </FieldLabel>
                              <Input
                                id={`header-value-${index}`}
                                type="password"
                                autoComplete="new-password"
                                value={row.value}
                                onChange={(event) =>
                                  setHeaders((current) =>
                                    current.map((item, i) =>
                                      i === index
                                        ? { ...item, value: event.target.value }
                                        : item
                                    )
                                  )
                                }
                              />
                            </Field>
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`移除请求头 ${index + 1}`}
                              onClick={() =>
                                setHeaders((current) =>
                                  current.filter((_, i) => i !== index)
                                )
                              }
                            >
                              移除
                            </Button>
                          </div>
                        ))}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setHeaders((current) => [
                              ...current,
                              { name: "", value: "" },
                            ])
                          }
                        >
                          添加请求头
                        </Button>
                      </>
                    ) : null}
                    {headerMode === "clear" ? (
                      <Alert>
                        <AlertDescription>
                          保存后将删除此账户的全部自定义请求头。
                        </AlertDescription>
                      </Alert>
                    ) : null}
                  </FieldSet>
                  {account.can_replace_document ? (
                    <Field>
                      <FieldLabel htmlFor="manage-document">
                        替换完整凭据 JSON
                      </FieldLabel>
                      <Textarea
                        id="manage-document"
                        rows={6}
                        value={documentText}
                        onChange={(event) =>
                          setDocumentText(event.target.value)
                        }
                        placeholder="留空保留当前凭据"
                        spellCheck={false}
                      />
                      <FieldDescription>
                        仅供导入凭据更新。需要完整 JSON
                        对象；此操作会替换原凭据内容。
                      </FieldDescription>
                    </Field>
                  ) : null}
                </FieldGroup>
              </TabsContent>
            </fieldset>
          </Tabs>
          <SheetFooter>
            {error ? <FieldError role="alert">{error}</FieldError> : null}
            {dirty ? (
              <p className="text-xs text-muted-foreground">
                {dirtyPages}
                有未保存修改。每次保存只应用当前页；执行诊断或账户操作前请先保存或关闭并放弃修改。
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => close(false)}
              >
                关闭
              </Button>
              {tab !== "status" ? (
                <Button
                  disabled={
                    busy ||
                    !currentDirty ||
                    (tab === "models" && (account.disabled || modelLoading))
                  }
                  onClick={() => void save()}
                >
                  {busy ? <Spinner data-icon="inline-start" /> : null}
                  {tab === "models"
                    ? "保存模型发布"
                    : tab === "connection"
                      ? "保存连接设置"
                      : "保存凭据"}
                </Button>
              ) : null}
            </div>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃未保存的修改？</AlertDialogTitle>
            <AlertDialogDescription>
              将放弃{dirtyPages}的草稿。已保存的账户配置不会改变。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>继续编辑</AlertDialogCancel>
            <AlertDialogAction onClick={() => onOpenChange(false)}>
              放弃修改
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

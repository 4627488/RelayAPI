import { useCallback, useEffect, useState, type FormEvent } from "react"
import {
  CheckIcon,
  ExternalLinkIcon,
  FileJson2Icon,
  KeyRoundIcon,
  Link2Icon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react"
import { toast } from "@/components/ui/toast"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import {
  api,
  deleteRequest,
  type OutboundProxy,
  type ProviderAccount,
} from "@/lib/api"
import {
  apiKeyProviders,
  displayName,
  importProviders,
  normalizedOAuthProvider,
  oauthProviders,
  providerLabel,
  type ConnectMode,
  type OAuthStart,
  type OAuthStatus,
} from "@/components/providers/provider-helpers"

export function ConnectAccountDialog({
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
      toast.add({
        title: cause instanceof Error ? cause.message : "无法创建授权链接",
        type: "error",
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
      toast.add({ title: "回调已接收，正在完成连接", type: "success" })
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "回调地址无效",
        type: "error",
      })
    } finally {
      setPending(false)
    }
  }

  async function finalizeOAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!oauth) return
    if (!name.trim()) {
      toast.add({ title: "账户名称必填", type: "error" })
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
      toast.add({
        title: reauthAccount ? "OAuth 账户已重新认证" : "OAuth 账户已连接",
        type: "success",
      })
      onOpenChange(false)
      reset()
      await onSaved()
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "保存账户失败",
        type: "error",
      })
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
        toast.add({ title: "凭据文档不是有效 JSON", type: "error" })
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
      toast.add({
        title: mode === "api_key" ? "API Key 账户已添加" : "凭据已导入",
        type: "success",
      })
      onOpenChange(false)
      reset()
      await onSaved()
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "添加失败",
        type: "error",
      })
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
            <div className="p-4">
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
                <div className="mt-4 bg-muted px-4 py-3 text-center font-mono text-xl font-semibold tracking-widest">
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

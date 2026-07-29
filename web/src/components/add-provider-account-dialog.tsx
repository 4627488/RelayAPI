import { useState, type FormEvent } from "react"
import {
  ArrowRightIcon,
  CheckCircle2Icon,
  CloudCogIcon,
  CodeXmlIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  Layers3Icon,
  PlugIcon,
  RouteIcon,
  ShieldCheckIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"

export type OAuthProvider = "codex" | "anthropic" | "antigravity" | "kimi" | "xai"
export type AddProviderMode = "oauth" | "openai" | "api-key"

type KeyProviderDefinition = {
  path: string
  responseKey: string
  label: string
  description: string
  baseURL: string
  baseURLRequired?: boolean
  websocket?: boolean
}

const oauthProviders: Array<{ id: OAuthProvider; label: string; description: string }> = [
  { id: "codex", label: "OpenAI Codex", description: "ChatGPT / Codex OAuth" },
  { id: "anthropic", label: "Anthropic", description: "Claude OAuth / setup token" },
  { id: "antigravity", label: "Antigravity", description: "Google Antigravity OAuth" },
  { id: "kimi", label: "Kimi", description: "Moonshot Kimi OAuth" },
  { id: "xai", label: "xAI", description: "Grok / xAI OAuth" },
]

const keyProviders: KeyProviderDefinition[] = [
  {
    path: "gemini-api-key",
    responseKey: "gemini-api-key",
    label: "Google Gemini",
    description: "Gemini 原生 API Key",
    baseURL: "https://generativelanguage.googleapis.com",
  },
  {
    path: "interactions-api-key",
    responseKey: "interactions-api-key",
    label: "Google Interactions",
    description: "Google Interactions API",
    baseURL: "https://generativelanguage.googleapis.com",
  },
  {
    path: "claude-api-key",
    responseKey: "claude-api-key",
    label: "Anthropic Claude",
    description: "Claude Messages API",
    baseURL: "https://api.anthropic.com",
  },
  {
    path: "codex-api-key",
    responseKey: "codex-api-key",
    label: "OpenAI / Codex",
    description: "OpenAI Responses API",
    baseURL: "https://api.openai.com/v1",
    baseURLRequired: true,
    websocket: true,
  },
  {
    path: "xai-api-key",
    responseKey: "xai-api-key",
    label: "xAI",
    description: "xAI Responses API",
    baseURL: "https://api.x.ai/v1",
    baseURLRequired: true,
    websocket: true,
  },
  {
    path: "vertex-api-key",
    responseKey: "vertex-api-key",
    label: "Vertex-compatible",
    description: "Vertex 风格第三方端点",
    baseURL: "",
    baseURLRequired: true,
  },
]

const addModes: Array<{ id: AddProviderMode; label: string; description: string; icon: typeof PlugIcon }> = [
  { id: "oauth", label: "OAuth 订阅账户", description: "接入 Codex、Claude、Kimi 等订阅", icon: PlugIcon },
  { id: "openai", label: "OpenAI-compatible", description: "配置自定义 Base URL、Key 和模型", icon: RouteIcon },
  { id: "api-key", label: "原生 API Key", description: "Gemini、Claude、Codex、xAI、Vertex", icon: KeyRoundIcon },
]

function parseHeaders(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim()
  if (!text) return undefined
  const parsed: unknown = JSON.parse(text)
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("自定义请求头必须是 JSON 对象")
  }
  const headers: Record<string, string> = {}
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item !== "string") throw new Error(`请求头 ${key} 的值必须是字符串`)
    headers[key] = item
  }
  return headers
}

function parseModels(value: FormDataEntryValue | null) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, alias] = line.split(/\s*(?:=>|=)\s*/, 2)
      return { name: name.trim(), alias: (alias || name).trim() }
    })
    .filter((item) => item.name && item.alias)
}

function parseLines(value: FormDataEntryValue | null) {
  return String(value ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
}

function optionalInteger(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim()
  return text ? Number(text) : undefined
}

async function cpaText(path: string, init?: RequestInit) {
  const response = await fetch(`/api/admin/cpa/${path}`, { ...init, credentials: "include" })
  const text = await response.text()
  if (!response.ok) throw new Error(text || `CPA 请求失败 (${response.status})`)
  return text
}

async function readCollection(path: string, key: string) {
  const text = await cpaText(path)
  const parsed: unknown = JSON.parse(text)
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === "object") {
    const value = (parsed as Record<string, unknown>)[key] ?? (parsed as Record<string, unknown>).items
    if (Array.isArray(value)) return value
  }
  return []
}

async function appendCollection(path: string, key: string, item: Record<string, unknown>) {
  const current = await readCollection(path, key)
  await cpaText(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([...current, item]),
  })
}

export function AddProviderAccountDialog({
  open,
  onOpenChange,
  initialOAuthProvider = "codex",
  initialMode = "oauth",
  onStartOAuth,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialOAuthProvider?: OAuthProvider
  initialMode?: AddProviderMode
  onStartOAuth: (provider: OAuthProvider) => void
  onSaved: () => void | Promise<void>
}) {
  const [mode, setMode] = useState<AddProviderMode>(initialMode)
  const [oauthProvider, setOAuthProvider] = useState<OAuthProvider>(initialOAuthProvider)
  const [keyProviderPath, setKeyProviderPath] = useState(keyProviders[0].path)
  const [pending, setPending] = useState(false)
  const keyProvider = keyProviders.find((item) => item.path === keyProviderPath) ?? keyProviders[0]

  function close() {
    if (!pending) onOpenChange(false)
  }

  function startOAuth() {
    onOpenChange(false)
    onStartOAuth(oauthProvider)
  }

  async function saveOpenAI(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const apiKeys = parseLines(form.get("api_keys"))
    const models = parseModels(form.get("models"))
    if (!apiKeys.length) {
      toast.error("至少填写一个上游 API Key")
      return
    }
    if (!models.length) {
      toast.error("至少配置一个上游模型")
      return
    }
    setPending(true)
    try {
      const proxyURL = String(form.get("proxy_url") ?? "").trim()
      const weight = optionalInteger(form.get("weight"))
      await appendCollection("openai-compatibility", "openai-compatibility", {
        name: String(form.get("name") ?? "").trim(),
        "base-url": String(form.get("base_url") ?? "").trim().replace(/\/+$/, ""),
        prefix: String(form.get("prefix") ?? "").trim(),
        priority: optionalInteger(form.get("priority")) ?? 0,
        headers: parseHeaders(form.get("headers")),
        "api-key-entries": apiKeys.map((apiKey) => ({
          "api-key": apiKey,
          ...(proxyURL ? { "proxy-url": proxyURL } : {}),
          ...(weight === undefined ? {} : { weight }),
        })),
        models,
      })
      toast.success("OpenAI-compatible 端点已添加")
      onOpenChange(false)
      await onSaved()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "端点配置失败")
    } finally {
      setPending(false)
    }
  }

  async function saveAPIKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    try {
      const baseURL = String(form.get("base_url") ?? "").trim().replace(/\/+$/, "")
      if (keyProvider.baseURLRequired && !baseURL) throw new Error(`${keyProvider.label} 必须配置 Base URL`)
      const entry: Record<string, unknown> = {
        "api-key": String(form.get("api_key") ?? "").trim(),
        "base-url": baseURL,
        prefix: String(form.get("prefix") ?? "").trim(),
        "proxy-url": String(form.get("proxy_url") ?? "").trim(),
        priority: optionalInteger(form.get("priority")) ?? 0,
        headers: parseHeaders(form.get("headers")),
        models: parseModels(form.get("models")),
        "excluded-models": parseLines(form.get("excluded_models")),
      }
      const weight = optionalInteger(form.get("weight"))
      if (weight !== undefined) entry.weight = weight
      if (keyProvider.websocket) entry.websockets = form.get("websockets") === "true"
      await appendCollection(keyProvider.path, keyProvider.responseKey, entry)
      toast.success(`${keyProvider.label} API Key 已添加`)
      onOpenChange(false)
      await onSaved()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "API Key 配置失败")
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) close(); else onOpenChange(true) }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto p-0 sm:max-w-4xl">
        <div className="border-b bg-gradient-to-br from-primary/10 via-background to-background p-5 sm:p-6">
          <DialogHeader>
            <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm"><Layers3Icon className="size-5" /></div>
            <DialogTitle className="text-xl">添加模型账户</DialogTitle>
            <DialogDescription>按 CLIProxyAPI 原生能力添加 OAuth 订阅、自定义 OpenAI-compatible 端点或提供商 API Key。</DialogDescription>
          </DialogHeader>
          <div className="mt-5 grid gap-2 sm:grid-cols-3">
            {addModes.map((item) => {
              const Icon = item.icon
              const selected = mode === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setMode(item.id)}
                  className={`relative flex items-start gap-3 rounded-xl border p-3 text-left transition-colors ${selected ? "border-primary bg-primary/5 ring-2 ring-primary/15" : "bg-background/70 hover:border-primary/30"}`}
                >
                  <span className={`rounded-lg p-2 ${selected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}><Icon className="size-4" /></span>
                  <span><span className="block text-sm font-medium">{item.label}</span><span className="mt-1 block text-xs leading-4 text-muted-foreground">{item.description}</span></span>
                  {selected && <CheckCircle2Icon className="absolute top-2 right-2 size-4 text-primary" />}
                </button>
              )
            })}
          </div>
        </div>

        {mode === "oauth" && (
          <>
            <div className="space-y-5 p-5 sm:p-6">
              <div>
                <p className="mb-3 text-sm font-medium">选择 OAuth 提供商</p>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {oauthProviders.map((provider) => {
                    const selected = oauthProvider === provider.id
                    return (
                      <button key={provider.id} type="button" onClick={() => setOAuthProvider(provider.id)} className={`relative flex min-h-20 items-start gap-3 rounded-xl border p-3 text-left transition-colors ${selected ? "border-primary bg-primary/5" : "hover:border-primary/30 hover:bg-muted/30"}`}>
                        <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${selected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}><CloudCogIcon className="size-4" /></span>
                        <span><span className="block text-sm font-medium">{provider.label}</span><span className="mt-1 block text-xs text-muted-foreground">{provider.description}</span></span>
                        {selected && <CheckCircle2Icon className="absolute top-2 right-2 size-4 text-primary" />}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <InfoTile icon={ShieldCheckIcon} title="CPA 安全托管" description="令牌不会写入 RelayAPI 数据库。" />
                <InfoTile icon={ExternalLinkIcon} title="浏览器授权" description="打开提供商官方认证页面。" />
                <InfoTile icon={CloudCogIcon} title="自动同步" description="完成后加载账户、模型和状态。" />
              </div>
            </div>
            <DialogFooter className="mx-0 mb-0 rounded-none">
              <Button variant="outline" onClick={close}>取消</Button>
              <Button onClick={startOAuth}><ExternalLinkIcon />开始 {oauthProviders.find((item) => item.id === oauthProvider)?.label} 授权</Button>
            </DialogFooter>
          </>
        )}

        {mode === "openai" && (
          <form onSubmit={saveOpenAI}>
            <div className="space-y-5 p-5 sm:p-6">
              <div className="flex items-start gap-3 rounded-xl border bg-muted/15 p-3">
                <CodeXmlIcon className="mt-0.5 size-4 text-primary" />
                <div><p className="text-sm font-medium">OpenAI-compatible 端点</p><p className="mt-1 text-xs leading-5 text-muted-foreground">CPA 会将模型注册到统一目录，并通过 OpenAI Chat/Responses 兼容协议转发。模型映射决定客户端可见名称。</p></div>
              </div>
              <FieldGroup className="grid gap-4 sm:grid-cols-2">
                <Field><FieldLabel htmlFor="compat-name">提供商名称</FieldLabel><Input id="compat-name" name="name" placeholder="例如 openrouter" required /><FieldDescription>用于标识凭据与 User-Agent。</FieldDescription></Field>
                <Field><FieldLabel htmlFor="compat-url">Base URL</FieldLabel><Input id="compat-url" name="base_url" type="url" placeholder="https://openrouter.ai/api/v1" required /></Field>
                <Field><FieldLabel htmlFor="compat-prefix">模型前缀</FieldLabel><Input id="compat-prefix" name="prefix" placeholder="可选，例如 team-a" /><FieldDescription>启用后通过 prefix/model 定向路由。</FieldDescription></Field>
                <Field><FieldLabel htmlFor="compat-proxy">凭据代理</FieldLabel><Input id="compat-proxy" name="proxy_url" placeholder="可选，socks5://… 或 direct" /></Field>
                <Field><FieldLabel htmlFor="compat-priority">优先级</FieldLabel><Input id="compat-priority" name="priority" type="number" defaultValue="0" /><FieldDescription>数值越高越优先。</FieldDescription></Field>
                <Field><FieldLabel htmlFor="compat-weight">Key 权重</FieldLabel><Input id="compat-weight" name="weight" type="number" min="0" max="1000000" placeholder="默认 1" /><FieldDescription>用于 weighted round-robin。</FieldDescription></Field>
                <Field className="sm:col-span-2"><FieldLabel htmlFor="compat-keys">API Keys</FieldLabel><Textarea id="compat-keys" name="api_keys" rows={4} placeholder={"sk-key-1\nsk-key-2"} className="font-mono text-xs" required /><FieldDescription>每行一个；CPA 会为同一端点建立 Key 池。</FieldDescription></Field>
                <Field className="sm:col-span-2"><FieldLabel htmlFor="compat-models">模型映射</FieldLabel><Textarea id="compat-models" name="models" rows={5} placeholder={"moonshotai/kimi-k2 => kimi-k2\ndeepseek/deepseek-v3.1 => deepseek-v3"} className="font-mono text-xs" required /><FieldDescription>每行“上游模型 =&gt; 对外别名”；别名省略时与上游名称相同。</FieldDescription></Field>
                <Field className="sm:col-span-2"><FieldLabel htmlFor="compat-headers">自定义请求头</FieldLabel><Textarea id="compat-headers" name="headers" rows={3} placeholder={'{"X-Custom-Header":"value"}'} className="font-mono text-xs" /><FieldDescription>可选 JSON 对象，不要在这里重复填写 Authorization。</FieldDescription></Field>
              </FieldGroup>
            </div>
            <DialogFooter className="mx-0 mb-0 rounded-none">
              <Button type="button" variant="outline" onClick={close}>取消</Button>
              <Button type="submit" disabled={pending}>{pending ? <Spinner /> : <ArrowRightIcon />}保存并接入端点</Button>
            </DialogFooter>
          </form>
        )}

        {mode === "api-key" && (
          <form onSubmit={saveAPIKey}>
            <div className="space-y-5 p-5 sm:p-6">
              <Field>
                <FieldLabel>提供商协议</FieldLabel>
                <Select value={keyProviderPath} onValueChange={(value) => { if (value) setKeyProviderPath(value) }}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>{keyProviders.map((item) => <SelectItem key={item.path} value={item.path}>{item.label} · {item.description}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
                <FieldDescription>选择 CPA 原生执行器，协议必须与上游端点实际支持的格式一致。</FieldDescription>
              </Field>
              <FieldGroup className="grid gap-4 sm:grid-cols-2">
                <Field className="sm:col-span-2"><FieldLabel htmlFor="native-key">API Key</FieldLabel><Input id="native-key" name="api_key" type="password" autoComplete="off" placeholder="输入上游 API Key" required /></Field>
                <Field><FieldLabel htmlFor="native-url">Base URL</FieldLabel><Input key={keyProvider.path} id="native-url" name="base_url" type="url" defaultValue={keyProvider.baseURL} placeholder="https://…" required={keyProvider.baseURLRequired} /><FieldDescription>{keyProvider.baseURLRequired ? "此 CPA 执行器要求明确的端点地址。" : "留空时使用 CPA 的提供商默认地址。"}</FieldDescription></Field>
                <Field><FieldLabel htmlFor="native-prefix">模型前缀</FieldLabel><Input id="native-prefix" name="prefix" placeholder="可选，例如 team-a" /></Field>
                <Field><FieldLabel htmlFor="native-priority">优先级</FieldLabel><Input id="native-priority" name="priority" type="number" defaultValue="0" /></Field>
                <Field><FieldLabel htmlFor="native-weight">调度权重</FieldLabel><Input id="native-weight" name="weight" type="number" min="0" max="1000000" placeholder="默认 1" /></Field>
                <Field className="sm:col-span-2"><FieldLabel htmlFor="native-proxy">凭据代理</FieldLabel><Input id="native-proxy" name="proxy_url" placeholder="可选，socks5://…、http://… 或 direct" /></Field>
                <Field className="sm:col-span-2"><FieldLabel htmlFor="native-models">模型与别名</FieldLabel><Textarea id="native-models" name="models" rows={4} placeholder={"上游模型 => 对外别名\n模型名"} className="font-mono text-xs" /><FieldDescription>可选；未填写时使用 CPA 对该原生提供商的默认模型能力。</FieldDescription></Field>
                <Field><FieldLabel htmlFor="native-excluded">排除模型</FieldLabel><Textarea id="native-excluded" name="excluded_models" rows={3} placeholder={"model-id\n*-preview"} className="font-mono text-xs" /></Field>
                <Field><FieldLabel htmlFor="native-headers">自定义请求头</FieldLabel><Textarea id="native-headers" name="headers" rows={3} placeholder={'{"X-Custom-Header":"value"}'} className="font-mono text-xs" /></Field>
                {keyProvider.websocket && (
                  <Field className="sm:col-span-2">
                    <FieldLabel>Responses WebSocket</FieldLabel>
                    <Select name="websockets" defaultValue="false"><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="false">关闭</SelectItem><SelectItem value="true">启用</SelectItem></SelectGroup></SelectContent></Select>
                    <FieldDescription>仅在上游支持 Responses WebSocket 传输时启用。</FieldDescription>
                  </Field>
                )}
              </FieldGroup>
            </div>
            <DialogFooter className="mx-0 mb-0 rounded-none">
              <Button type="button" variant="outline" onClick={close}>取消</Button>
              <Button type="submit" disabled={pending}>{pending ? <Spinner /> : <ArrowRightIcon />}保存并添加 Key</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function InfoTile({ icon: Icon, title, description }: { icon: typeof PlugIcon; title: string; description: string }) {
  return (
    <div className="rounded-xl border bg-muted/15 p-3">
      <Icon className="size-4 text-primary" />
      <p className="mt-2 text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
    </div>
  )
}

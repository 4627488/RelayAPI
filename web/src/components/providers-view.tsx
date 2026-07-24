import { useCallback, useEffect, useState, type FormEvent } from "react"
import { ExternalLinkIcon, PlugIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api, deleteRequest, postJSON, type ProviderAccount } from "@/lib/api"

type OAuthStart = { status: string; url: string; state: string }
type ProviderSettings = { request_retry: number; max_retry_interval: number; routing_strategy: string }

export function ProvidersView() {
  const [accounts, setAccounts] = useState<ProviderAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [oauth, setOAuth] = useState<OAuthStart | null>(null)
  const [pending, setPending] = useState(false)
  const [settings, setSettings] = useState<ProviderSettings | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [value, config] = await Promise.all([
        api<{ files: ProviderAccount[] }>("/api/admin/providers/accounts"),
        api<ProviderSettings>("/api/admin/providers/settings"),
      ])
      setAccounts(value.files ?? [])
      setSettings(config)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "无法读取 CPA 凭据")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => void load(), [load])

  async function beginCodex() {
    setPending(true)
    try {
      const value = await postJSON<OAuthStart>("/api/admin/providers/codex/oauth", {})
      setOAuth(value)
      window.open(value.url, "_blank", "noopener,noreferrer")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "无法启动 Codex 登录")
    } finally {
      setPending(false)
    }
  }

  async function completeOAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!oauth) return
    const form = new FormData(event.currentTarget)
    setPending(true)
    try {
      await postJSON("/api/admin/providers/oauth/callback", {
        provider: "codex",
        state: oauth.state,
        redirect_url: String(form.get("redirect_url") ?? ""),
      })
      for (let attempt = 0; attempt < 15; attempt++) {
        const status = await api<{ status: string; error?: string }>(
          `/api/admin/providers/oauth/status?state=${encodeURIComponent(oauth.state)}`,
        )
        if (status.status === "ok") {
          toast.success("Codex 账户已统一接入")
          setOAuth(null)
          await load()
          return
        }
        if (status.status === "error") throw new Error(status.error || "OAuth 登录失败")
        await new Promise((resolve) => window.setTimeout(resolve, 1000))
      }
      toast.info("授权仍在处理，可稍后刷新账户列表")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "无法完成 Codex 登录")
    } finally {
      setPending(false)
    }
  }

  async function toggle(account: ProviderAccount) {
    try {
      await api(`/api/admin/providers/accounts/${encodeURIComponent(account.name)}`, {
        method: "PATCH",
        body: JSON.stringify({ disabled: !account.disabled }),
      })
      await load()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "更新失败")
    }
  }

  async function remove(account: ProviderAccount) {
    if (!window.confirm(`确认从 CPA 删除凭据 ${account.name}？`)) return
    try {
      await deleteRequest(`/api/admin/providers/accounts/${encodeURIComponent(account.name)}`)
      toast.success("凭据已删除")
      await load()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "删除失败")
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    try {
      const value = await api<ProviderSettings>("/api/admin/providers/settings", {
        method: "PATCH",
        body: JSON.stringify({
          request_retry: Number(form.get("request_retry")),
          max_retry_interval: Number(form.get("max_retry_interval")),
          routing_strategy: settings?.routing_strategy,
        }),
      })
      setSettings(value)
      toast.success("CPA 运行策略已保存")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "保存失败")
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">模型账户</h1>
          <p className="text-sm text-muted-foreground">统一管理 CPA 凭据、状态与 Codex OAuth。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCwIcon />刷新</Button>
          <Button onClick={() => void beginCodex()} disabled={pending}>
            {pending ? <Spinner /> : <PlugIcon />}连接 Codex
          </Button>
        </div>
      </div>

      {oauth && (
        <Card>
          <CardHeader>
            <CardTitle>完成 Codex 授权</CardTitle>
            <CardDescription>授权后复制浏览器最终跳转地址并粘贴到下方。地址只用于完成本次 OAuth。</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={completeOAuth}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="redirect-url">回调地址</FieldLabel>
                  <Input id="redirect-url" name="redirect_url" type="url" placeholder="http://localhost:1455/auth/callback?code=…&state=…" required />
                  <FieldDescription>若授权页尚未打开，可点击右侧重新打开。</FieldDescription>
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={pending}>{pending ? <Spinner /> : null}提交并验证</Button>
                  <Button type="button" variant="outline" onClick={() => window.open(oauth.url, "_blank", "noopener,noreferrer")}>
                    <ExternalLinkIcon />打开授权页
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setOAuth(null)}>取消</Button>
                </div>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>CPA 凭据</CardTitle>
          <CardDescription>这里只展示 CPA 返回的脱敏元数据，不读取 token 或 refresh token。</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? <div className="flex justify-center py-12"><Spinner /></div> : (
            <Table>
              <TableHeader><TableRow><TableHead>账户</TableHead><TableHead>提供商</TableHead><TableHead>状态</TableHead><TableHead>请求</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
              <TableBody>
                {accounts.map((account) => (
                  <TableRow key={account.auth_index || account.id || account.name}>
                    <TableCell><div className="font-medium">{account.email || account.label || account.name}</div><div className="max-w-64 truncate text-xs text-muted-foreground">{account.name}</div></TableCell>
                    <TableCell>{account.provider || account.type}</TableCell>
                    <TableCell><Badge variant={account.disabled || account.unavailable ? "secondary" : "default"}>{account.disabled ? "已停用" : account.unavailable ? "不可用" : account.status || "可用"}</Badge></TableCell>
                    <TableCell className="text-muted-foreground">{account.success ?? 0} / {account.failed ?? 0}</TableCell>
                    <TableCell><div className="flex justify-end gap-2"><Button size="sm" variant="outline" onClick={() => void toggle(account)}>{account.disabled ? "启用" : "停用"}</Button><Button size="icon-sm" variant="ghost" aria-label="删除凭据" onClick={() => void remove(account)}><Trash2Icon /></Button></div></TableCell>
                  </TableRow>
                ))}
                {!accounts.length && <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">尚未接入模型账户</TableCell></TableRow>}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {settings && (
        <Card>
          <CardHeader>
            <CardTitle>CPA 运行策略</CardTitle>
            <CardDescription>Relay 只开放经过校验的常用配置，不暴露完整 CPA 配置文件。</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={saveSettings}>
              <FieldGroup className="grid gap-4 md:grid-cols-3">
                <Field>
                  <FieldLabel htmlFor="request-retry">请求重试次数</FieldLabel>
                  <Input id="request-retry" name="request_retry" type="number" min="0" max="20" defaultValue={settings.request_retry} required />
                </Field>
                <Field>
                  <FieldLabel htmlFor="retry-interval">最大重试间隔（秒）</FieldLabel>
                  <Input id="retry-interval" name="max_retry_interval" type="number" min="0" max="3600" defaultValue={settings.max_retry_interval} required />
                </Field>
                <Field>
                  <FieldLabel htmlFor="routing-strategy">凭据调度策略</FieldLabel>
                  <Select value={settings.routing_strategy} onValueChange={(value) => setSettings({ ...settings, routing_strategy: value as string })}>
                    <SelectTrigger id="routing-strategy" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="round-robin">轮询</SelectItem>
                        <SelectItem value="fill-first">优先填满</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <div className="md:col-span-3"><Button type="submit" disabled={pending}>{pending ? <Spinner /> : null}保存策略</Button></div>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

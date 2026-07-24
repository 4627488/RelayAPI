import { useCallback, useEffect, useState, type FormEvent } from "react"
import {
  CheckIcon,
  CopyIcon,
  KeyRoundIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { LogsTable, ModelTable, UsageChart, UsageMetrics } from "@/components/data-views"
import { LoadingView } from "@/components/loading-view"
import type { Page } from "@/components/app-shell"
import {
  api,
  deleteRequest,
  postJSON,
  type ApiKey,
  type RequestLog,
  type Session,
  type UsageReport,
} from "@/lib/api"
import { dateTime, money } from "@/lib/format"

interface UserWorkspaceProps {
  page: Page
  session: Session
}

export function UserWorkspace({ page, session }: UserWorkspaceProps) {
  const [usage, setUsage] = useState<UsageReport | null>(null)
  const [logs, setLogs] = useState<RequestLog[]>([])
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [usageValue, logsValue, keysValue] = await Promise.all([
        api<UsageReport>("/api/usage?days=30"),
        api<{ items: RequestLog[] }>("/api/logs?limit=100"),
        api<{ items: ApiKey[] }>("/api/keys"),
      ])
      setUsage(usageValue)
      setLogs(logsValue.items ?? [])
      setKeys(keysValue.items ?? [])
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "无法读取数据")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (loading || !usage) return <LoadingView />

  if (page === "keys") return <KeysView keys={keys} onChanged={load} />
  if (page === "logs") return <LogsTable logs={logs} />
  if (page === "usage") {
    return (
      <div className="flex flex-col gap-4">
        <UsageMetrics report={usage} />
        <UsageChart report={usage} />
        <ModelTable report={usage} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">你好，{session.tenant?.name}</h1>
        <p className="text-sm text-muted-foreground">这里是你的模型访问和用量概况。</p>
      </div>
      <UsageMetrics report={usage} />
      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <UsageChart report={usage} />
        <Card>
          <CardHeader>
            <CardTitle>账户状态</CardTitle>
            <CardDescription>当前额度与访问策略。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">状态</span>
              <Badge variant="secondary"><CheckIcon /> 正常</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">余额</span>
              <span className="font-medium tabular-nums">{money(session.tenant?.balance_nano_usd)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">有效 Keys</span>
              <span className="font-medium tabular-nums">{keys.filter((key) => key.enabled).length}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">模型范围</span>
              <span className="font-medium">
                {session.tenant?.model_allowlist?.length ? `${session.tenant.model_allowlist.length} 个` : "全部模型"}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
      <LogsTable logs={logs.slice(0, 8)} />
    </div>
  )
}

function KeysView({ keys, onChanged }: { keys: ApiKey[]; onChanged: () => Promise<void> }) {
  const [createOpen, setCreateOpen] = useState(false)
  const [plainKey, setPlainKey] = useState("")
  const [pending, setPending] = useState(false)

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setPending(true)
    try {
      const response = await postJSON<{ item: ApiKey; key: string }>("/api/keys", {
        name: String(data.get("name") ?? ""),
        rateLimitPerMinute: numberOrNull(data.get("rate")),
        tokenLimitDaily: numberOrNull(data.get("tokens")),
        modelAllowlist: String(data.get("models") ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      })
      setPlainKey(response.key)
      await onChanged()
      toast.success("API Key 已创建")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "创建失败")
    } finally {
      setPending(false)
    }
  }

  async function remove(id: string) {
    try {
      await deleteRequest(`/api/keys/${id}`)
      await onChanged()
      toast.success("API Key 已删除")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "删除失败")
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">API Keys</h1>
          <p className="text-sm text-muted-foreground">为不同应用创建独立密钥与限制。</p>
        </div>
        <Button onClick={() => { setPlainKey(""); setCreateOpen(true) }}>
          <PlusIcon data-icon="inline-start" />
          创建 Key
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>你的密钥</CardTitle>
          <CardDescription>完整密钥只在创建时显示一次。</CardDescription>
        </CardHeader>
        <CardContent>
          {keys.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>前缀</TableHead>
                  <TableHead>最后使用</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">{key.name}</TableCell>
                    <TableCell className="font-mono text-xs">{key.prefix}…</TableCell>
                    <TableCell className="text-muted-foreground">{dateTime(key.last_used_at)}</TableCell>
                    <TableCell><Badge variant="secondary">{key.enabled ? "有效" : "停用"}</Badge></TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon-sm" aria-label={`删除 ${key.name}`} onClick={() => void remove(key.id)}>
                        <Trash2Icon />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><KeyRoundIcon /></EmptyMedia>
                <EmptyTitle>还没有 API Key</EmptyTitle>
                <EmptyDescription>创建密钥后即可调用所有已授权模型。</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button onClick={() => setCreateOpen(true)}>
                  <PlusIcon data-icon="inline-start" />
                  创建第一个 Key
                </Button>
              </EmptyContent>
            </Empty>
          )}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{plainKey ? "保存 API Key" : "创建 API Key"}</DialogTitle>
            <DialogDescription>
              {plainKey ? "这是唯一一次显示完整密钥，请立即保存。" : "限制留空表示继承账户策略。"}
            </DialogDescription>
          </DialogHeader>
          {plainKey ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="plain-key">完整密钥</FieldLabel>
                <InputGroup>
                  <InputGroupInput id="plain-key" readOnly value={plainKey} className="font-mono text-xs" />
                  <InputGroupAddon align="inline-end">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="复制密钥"
                      onClick={() => {
                        void navigator.clipboard.writeText(plainKey)
                        toast.success("已复制")
                      }}
                    >
                      <CopyIcon />
                    </Button>
                  </InputGroupAddon>
                </InputGroup>
              </Field>
            </FieldGroup>
          ) : (
            <form id="create-key-form" onSubmit={create}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="key-name">名称</FieldLabel>
                  <Input id="key-name" name="name" placeholder="例如：开发环境" required />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="key-rate">每分钟请求</FieldLabel>
                    <Input id="key-rate" name="rate" type="number" min="1" placeholder="不限" />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="key-tokens">每日 Tokens</FieldLabel>
                    <Input id="key-tokens" name="tokens" type="number" min="1" placeholder="不限" />
                  </Field>
                </div>
                <Field>
                  <FieldLabel htmlFor="key-models">模型范围</FieldLabel>
                  <Input id="key-models" name="models" placeholder="gpt-*, claude-*（留空为全部）" />
                  <FieldDescription>支持逗号分隔和通配符。</FieldDescription>
                </Field>
              </FieldGroup>
            </form>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {plainKey ? "我已保存" : "取消"}
            </Button>
            {!plainKey ? (
              <Button type="submit" form="create-key-form" disabled={pending}>
                {pending ? <Spinner data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}
                创建
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function numberOrNull(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim()
  return text ? Number(text) : null
}

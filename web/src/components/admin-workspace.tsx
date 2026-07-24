import { useCallback, useEffect, useState, type FormEvent } from "react"
import {
  ActivityIcon,
  CopyIcon,
  KeyRoundIcon,
  PlusIcon,
  SendIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UserCheckIcon,
  UsersIcon,
} from "lucide-react"
import { toast } from "sonner"

import type { Page } from "@/components/app-shell"
import { LogsTable, MetricGrid, ModelTable, UsageChart, UsageMetrics } from "@/components/data-views"
import { LoadingView } from "@/components/loading-view"
import { ProvidersView } from "@/components/providers-view"
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
import {
  api,
  deleteRequest,
  postJSON,
  type AdminOverview,
  type Invitation,
  type RequestLog,
  type UsageReport,
  type User,
} from "@/lib/api"
import { compact, dateTime, money } from "@/lib/format"

interface AdminWorkspaceProps {
  page: Page
}

export function AdminWorkspace({ page }: AdminWorkspaceProps) {
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [usage, setUsage] = useState<UsageReport | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [logs, setLogs] = useState<RequestLog[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [overviewValue, usageValue, usersValue, invitationsValue, logsValue] = await Promise.all([
        api<AdminOverview>("/api/admin/overview"),
        api<UsageReport>("/api/admin/usage?days=30"),
        api<{ items: User[] }>("/api/admin/tenants"),
        api<{ items: Invitation[] }>("/api/admin/invitations"),
        api<{ items: RequestLog[] }>("/api/logs?limit=100"),
      ])
      setOverview(overviewValue)
      setUsage(usageValue)
      setUsers(usersValue.items ?? [])
      setInvitations(invitationsValue.items ?? [])
      setLogs(logsValue.items ?? [])
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "无法读取管理数据")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (loading || !overview || !usage) return <LoadingView />
  if (page === "users") return <UsersView users={users} />
  if (page === "invitations") return <InvitationsView items={invitations} onChanged={load} />
  if (page === "providers") return <ProvidersView />
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
        <h1 className="text-2xl font-semibold tracking-tight">管理总览</h1>
        <p className="text-sm text-muted-foreground">用户增长、系统负载和异常概况。</p>
      </div>
      <MetricGrid
        items={[
          { label: "用户", value: compact(overview.users), hint: `${overview.enabled_users} 个账户正常`, icon: UsersIcon },
          { label: "有效 Keys", value: compact(overview.active_api_keys), hint: "用户创建的访问凭据", icon: KeyRoundIcon },
          { label: "今日请求", value: compact(overview.today.requests), hint: `${compact(overview.today.tokens)} tokens`, icon: ActivityIcon },
          { label: "今日错误", value: compact(overview.today.errors), hint: `费用 ${money(overview.today.cost_nano_usd)}`, icon: TriangleAlertIcon },
        ]}
      />
      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <UsageChart report={usage} />
        <Card>
          <CardHeader>
            <CardTitle>需要关注</CardTitle>
            <CardDescription>运营入口与待处理事项。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center justify-between rounded-lg bg-muted p-3">
              <div className="flex items-center gap-3">
                <SendIcon className="size-4 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">待使用邀请</p>
                  <p className="text-xs text-muted-foreground">仍在有效期内</p>
                </div>
              </div>
              <Badge variant="secondary">{overview.pending_invitations}</Badge>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-muted p-3">
              <div className="flex items-center gap-3">
                <UserCheckIcon className="size-4 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">正常用户</p>
                  <p className="text-xs text-muted-foreground">可登录并调用 API</p>
                </div>
              </div>
              <Badge variant="secondary">{overview.enabled_users}</Badge>
            </div>
          </CardContent>
        </Card>
      </div>
      <LogsTable logs={logs.slice(0, 8)} />
    </div>
  )
}

function UsersView({ users }: { users: User[] }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">用户</h1>
        <p className="text-sm text-muted-foreground">受邀注册账户与当前余额。</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>全部用户</CardTitle>
          <CardDescription>{users.length} 个账户。</CardDescription>
        </CardHeader>
        <CardContent>
          {users.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>用户</TableHead>
                  <TableHead>邮箱</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">余额</TableHead>
                  <TableHead className="text-right">注册时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">{user.name}</TableCell>
                    <TableCell className="text-muted-foreground">{user.owner_email}</TableCell>
                    <TableCell>
                      <Badge variant={user.enabled ? "secondary" : "destructive"}>
                        {user.enabled ? "正常" : "停用"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(user.balance_nano_usd)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{dateTime(user.created_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><UsersIcon /></EmptyMedia>
                <EmptyTitle>还没有用户</EmptyTitle>
                <EmptyDescription>生成邀请链接来添加第一个用户。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function InvitationsView({ items, onChanged }: { items: Invitation[]; onChanged: () => Promise<void> }) {
  const [renderedAt] = useState(() => Date.now())
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<{ token: string; invite_url: string } | null>(null)
  const [pending, setPending] = useState(false)

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setPending(true)
    try {
      const value = await postJSON<{ item: Invitation; token: string; invite_url: string }>(
        "/api/admin/invitations",
        {
          email: String(data.get("email") ?? ""),
          expires_in_hours: Number(data.get("hours") ?? 72),
        },
      )
      setResult(value)
      await onChanged()
      toast.success("邀请已生成")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "生成失败")
    } finally {
      setPending(false)
    }
  }

  async function revoke(id: string) {
    try {
      await deleteRequest(`/api/admin/invitations/${id}`)
      await onChanged()
      toast.success("邀请已撤销")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "撤销失败")
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">邀请</h1>
          <p className="text-sm text-muted-foreground">生成单次邀请链接并追踪使用状态。</p>
        </div>
        <Button onClick={() => { setResult(null); setOpen(true) }}>
          <PlusIcon data-icon="inline-start" />
          生成邀请
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>邀请记录</CardTitle>
          <CardDescription>Token 明文不会在列表中保存。</CardDescription>
        </CardHeader>
        <CardContent>
          {items.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>目标邮箱</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead>到期时间</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const expired = new Date(item.expires_at).getTime() <= renderedAt
                  const active = !item.used_at && !item.revoked_at && !expired
                  return (
                    <TableRow key={item.id}>
                      <TableCell>{item.email || "任意邮箱"}</TableCell>
                      <TableCell className="text-muted-foreground">{dateTime(item.created_at)}</TableCell>
                      <TableCell className="text-muted-foreground">{dateTime(item.expires_at)}</TableCell>
                      <TableCell>
                        <Badge variant={active ? "secondary" : "outline"}>
                          {item.used_at ? "已使用" : item.revoked_at ? "已撤销" : expired ? "已过期" : "待使用"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="撤销邀请"
                          disabled={!active}
                          onClick={() => void revoke(item.id)}
                        >
                          <Trash2Icon />
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><SendIcon /></EmptyMedia>
                <EmptyTitle>还没有邀请</EmptyTitle>
                <EmptyDescription>生成链接，让用户自行完成注册。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{result ? "邀请已生成" : "生成邀请"}</DialogTitle>
            <DialogDescription>
              {result ? "链接只显示一次，请复制并安全发送。" : "可选填邮箱来限制邀请使用者。"}
            </DialogDescription>
          </DialogHeader>
          {result ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="invite-url">邀请链接</FieldLabel>
                <InputGroup>
                  <InputGroupInput id="invite-url" readOnly value={result.invite_url} />
                  <InputGroupAddon align="inline-end">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="复制邀请链接"
                      onClick={() => {
                        void navigator.clipboard.writeText(result.invite_url)
                        toast.success("邀请链接已复制")
                      }}
                    >
                      <CopyIcon />
                    </Button>
                  </InputGroupAddon>
                </InputGroup>
              </Field>
            </FieldGroup>
          ) : (
            <form id="invite-form" onSubmit={create}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="invite-email">限定邮箱</FieldLabel>
                  <Input id="invite-email" name="email" type="email" placeholder="留空则任何人可使用" />
                  <FieldDescription>限定后，其他邮箱无法完成注册。</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="invite-hours">有效小时数</FieldLabel>
                  <Input id="invite-hours" name="hours" type="number" min="1" max="720" defaultValue="72" required />
                </Field>
              </FieldGroup>
            </form>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {result ? "完成" : "取消"}
            </Button>
            {!result ? (
              <Button type="submit" form="invite-form" disabled={pending}>
                {pending ? <Spinner data-icon="inline-start" /> : <SendIcon data-icon="inline-start" />}
                生成
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

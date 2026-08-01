import { useCallback, useEffect, useState, type FormEvent } from "react"
import {
  ActivityIcon,
  CircleDollarSignIcon,
  CopyIcon,
  KeyRoundIcon,
  PlusIcon,
  SendIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UserCheckIcon,
  UsersIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import type { Page } from "@/components/app-shell"
import { LogsTable, MetricGrid, ModelTable, UsageChart, UsageMetrics } from "@/components/data-views"
import { LoadingView } from "@/components/loading-view"
import { LoadErrorView } from "@/components/load-error-view"
import { ProvidersView } from "@/components/providers-view"
import { PricingView } from "@/components/pricing-view"
import { RequestLogsWorkbench } from "@/components/request-logs-workbench"
import { AdminSubscriptionsView } from "@/components/subscriptions-view"
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
import { compact, compactTokens, dateTime, money } from "@/lib/format"
import { copyText } from "@/lib/clipboard"
import { useSessionStorage } from "@/hooks/use-session-storage"

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
  const [loadError, setLoadError] = useState("")

  const load = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    setLoadError("")
    try {
      const [overviewValue, usageValue, usersValue, invitationsValue, logsValue] = await Promise.all([
        api<AdminOverview>("/api/admin/overview"),
        api<UsageReport>("/api/admin/usage?days=30"),
        api<{ items: User[] }>("/api/admin/tenants"),
        api<{ items: Invitation[] }>("/api/admin/invitations"),
        api<{ items: RequestLog[] }>("/api/admin/logs?limit=100"),
      ])
      setOverview(overviewValue)
      setUsage(usageValue)
      setUsers(usersValue.items ?? [])
      setInvitations(invitationsValue.items ?? [])
      setLogs(logsValue.items ?? [])
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "无法读取管理数据"
      setLoadError(message)
      if (!showLoading) toast.error(message)
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(true)
  }, [load])

  if (loading) return <LoadingView />
  if (!overview || !usage) {
    return <LoadErrorView message={loadError || "管理数据不完整"} onRetry={() => void load(true)} />
  }
  if (page === "users") return <UsersView users={users} onChanged={load} />
  if (page === "invitations") return <InvitationsView items={invitations} onChanged={load} />
  if (page === "providers") return <ProvidersView />
  if (page === "subscriptions") return <AdminSubscriptionsView />
  if (page === "logs") return <RequestLogsWorkbench admin />
  if (page === "pricing") return <PricingView />
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
          { label: "今日请求", value: compact(overview.today.requests), hint: `${compactTokens(overview.today.tokens)} tokens`, icon: ActivityIcon },
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

function UsersView({ users, onChanged }: { users: User[]; onChanged: () => Promise<void> }) {
  const [creditUser, setCreditUser] = useState<User | null>(null)
  const [resetUser, setResetUser] = useState<User | null>(null)
  const [temporaryPassword, setTemporaryPassword] = useState("")
  const [pending, setPending] = useState(false)

  async function credit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!creditUser) return
    const data = new FormData(event.currentTarget)
    const amountUSD = Number(data.get("amount_usd"))
    if (!Number.isFinite(amountUSD) || amountUSD <= 0 || amountUSD > 1_000_000) {
      toast.error("充值金额必须大于 0 且不超过 1,000,000 USD")
      return
    }
    const amountNanoUSD = Math.round(amountUSD * 1_000_000_000)
    setPending(true)
    try {
      await postJSON(`/api/admin/tenants/${creditUser.id}/credit`, {
        amount_nano_usd: amountNanoUSD,
        note: String(data.get("note") ?? "").trim() || "管理员充值",
      })
      await onChanged()
      toast.success(`已为 ${creditUser.name} 充值 ${money(amountNanoUSD)}`)
      setCreditUser(null)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "充值失败")
    } finally {
      setPending(false)
    }
  }

  async function resetPassword() {
    if (!resetUser) return
    setPending(true)
    try {
      const result = await postJSON<{ temporary_password: string }>(`/api/admin/tenants/${resetUser.id}/password`, {})
      setTemporaryPassword(result.temporary_password)
      await onChanged()
      toast.success(`已重置 ${resetUser.name} 的密码`)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "密码重置失败")
    } finally {
      setPending(false)
    }
  }

  function closeReset() {
    if (pending) return
    setResetUser(null)
    setTemporaryPassword("")
  }

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
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">
                      <span className="inline-flex items-center gap-2">
                        {user.name}
                        {user.is_admin ? <Badge variant="outline">管理员</Badge> : null}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{user.owner_email}</TableCell>
                    <TableCell>
                      <Badge variant={user.enabled ? "secondary" : "destructive"}>
                        {user.enabled ? "正常" : "停用"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(user.balance_nano_usd)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{dateTime(user.created_at)}</TableCell>
                    <TableCell className="text-right">
                      <span className="inline-flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => { setResetUser(user); setTemporaryPassword("") }}>
                          <KeyRoundIcon data-icon="inline-start" />
                          重置密码
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setCreditUser(user)}>
                          <CircleDollarSignIcon data-icon="inline-start" />
                          充值
                        </Button>
                      </span>
                    </TableCell>
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
      <Dialog open={Boolean(creditUser)} onOpenChange={(open) => { if (!open && !pending) setCreditUser(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>用户充值</DialogTitle>
            <DialogDescription>
              为 {creditUser?.name} 增加账户总余额。该操作会写入计费账本。
            </DialogDescription>
          </DialogHeader>
          <form id="credit-user-form" onSubmit={credit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="credit-amount">充值金额（USD）</FieldLabel>
                <Input
                  id="credit-amount"
                  name="amount_usd"
                  type="number"
                  min="0.000001"
                  max="1000000"
                  step="0.000001"
                  placeholder="例如 10.00"
                  autoFocus
                  required
                />
                <FieldDescription>充值后余额：{creditUser ? money(creditUser.balance_nano_usd) : "$0.00"} + 本次金额</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="credit-note">备注</FieldLabel>
                <Input id="credit-note" name="note" maxLength={200} placeholder="例如：订单号或线下收款说明" />
              </Field>
            </FieldGroup>
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreditUser(null)} disabled={pending}>取消</Button>
            <Button type="submit" form="credit-user-form" disabled={pending}>
              {pending ? <Spinner /> : <CircleDollarSignIcon data-icon="inline-start" />}
              确认充值
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(resetUser)} onOpenChange={(open) => { if (!open) closeReset() }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{temporaryPassword ? "临时密码已生成" : "重置用户密码"}</DialogTitle>
            <DialogDescription>
              {temporaryPassword
                ? `将临时密码发送给 ${resetUser?.name}。该密码关闭后无法再次查看。`
                : `${resetUser?.name} 的原密码将立即失效。用户使用临时密码登录后必须设置新密码。`}
            </DialogDescription>
          </DialogHeader>
          {temporaryPassword ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="temporary-password">临时密码</FieldLabel>
                <InputGroup>
                  <InputGroupInput id="temporary-password" value={temporaryPassword} readOnly className="font-mono" />
                  <InputGroupAddon align="inline-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label="复制临时密码"
                      onClick={() => void copyText(temporaryPassword).then(() => toast.success("临时密码已复制"))}
                    >
                      <CopyIcon />
                    </Button>
                  </InputGroupAddon>
                </InputGroup>
                <FieldDescription>用户首次登录后，该密码会被新密码替换。</FieldDescription>
              </Field>
            </FieldGroup>
          ) : null}
          <DialogFooter>
            {temporaryPassword ? (
              <Button onClick={closeReset}>完成</Button>
            ) : (
              <>
                <Button variant="outline" onClick={closeReset} disabled={pending}>取消</Button>
                <Button variant="destructive" onClick={() => void resetPassword()} disabled={pending}>
                  {pending ? <Spinner /> : <KeyRoundIcon data-icon="inline-start" />}
                  生成临时密码
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

type GeneratedInvitation = {
  id: string
  invite_url: string
  expires_at: string
}

function isGeneratedInvitation(value: unknown): value is GeneratedInvitation {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<GeneratedInvitation>
  return typeof item.id === "string"
    && typeof item.invite_url === "string"
    && typeof item.expires_at === "string"
    && new Date(item.expires_at).getTime() > Date.now()
}

function InvitationsView({ items, onChanged }: { items: Invitation[]; onChanged: () => Promise<void> }) {
  const [renderedAt, setRenderedAt] = useState(() => Date.now())
  const [open, setOpen] = useState(false)
  const [showResult, setShowResult] = useState(false)
  const [result, setResult] = useSessionStorage<GeneratedInvitation>(
    "relayapi.latest-invitation",
    isGeneratedInvitation,
  )
  const [pending, setPending] = useState(false)

  useEffect(() => {
    const timer = window.setInterval(() => setRenderedAt(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!result) return
    const item = items.find((candidate) => candidate.id === result.id)
    if (new Date(result.expires_at).getTime() <= Date.now() || item?.used_at || item?.revoked_at) {
      setResult(null)
    }
  }, [items, result, setResult])

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
      setResult({
        id: value.item.id,
        invite_url: value.invite_url,
        expires_at: value.item.expires_at,
      })
      setShowResult(true)
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
      if (result?.id === id) setResult(null)
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
        <Button onClick={() => { setShowResult(false); setOpen(true) }}>
          <PlusIcon data-icon="inline-start" />
          生成邀请
        </Button>
      </div>
      {result ? (
        <Card className="border-primary/30 bg-primary/5">
          <CardHeader className="flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>最近生成的邀请链接</CardTitle>
              <CardDescription>
                已临时保留在当前浏览器标签页中，关闭标签页或清除后无法恢复。
              </CardDescription>
            </div>
            <Button variant="ghost" size="icon-sm" aria-label="清除邀请链接" onClick={() => setResult(null)}>
              <XIcon />
            </Button>
          </CardHeader>
          <CardContent>
            <InviteLinkField id="latest-invite-url" value={result.invite_url} />
          </CardContent>
        </Card>
      ) : null}
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
            <DialogTitle>{showResult && result ? "邀请已生成" : "生成邀请"}</DialogTitle>
            <DialogDescription>
              {showResult && result ? "请复制并安全发送；关闭弹窗后仍可在邀请页顶部找到。" : "可选填邮箱来限制邀请使用者。"}
            </DialogDescription>
          </DialogHeader>
          {showResult && result ? (
            <InviteLinkField id="dialog-invite-url" value={result.invite_url} />
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
              {showResult && result ? "完成" : "取消"}
            </Button>
            {!(showResult && result) ? (
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

function InviteLinkField({ id, value }: { id: string; value: string }) {
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={id}>邀请链接</FieldLabel>
        <InputGroup>
          <InputGroupInput id={id} readOnly value={value} />
          <InputGroupAddon align="inline-end">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="复制邀请链接"
              onClick={() => {
                copyText(value)
                  .then(() => toast.success("邀请链接已复制"))
                  .catch(() => toast.error("复制失败，请手动选择链接"))
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

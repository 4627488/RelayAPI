import { useCallback, useEffect, useState, type ReactNode } from "react"
import { AlertDialog } from "@astryxdesign/core/AlertDialog"
import { Badge } from "@astryxdesign/core/Badge"
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
  StackItem,
  VStack,
} from "@astryxdesign/core/Layout"
import { List, ListItem } from "@astryxdesign/core/List"
import { NumberInput } from "@astryxdesign/core/NumberInput"
import { Tab, TabList } from "@astryxdesign/core/TabList"
import { Table, pixel, proportional } from "@astryxdesign/core/Table"
import { Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useToast } from "@astryxdesign/core/Toast"
import {
  BanIcon,
  CircleCheckIcon,
  CircleDollarSignIcon,
  KeyRoundIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SendIcon,
  Trash2Icon,
  UsersIcon,
  XIcon,
} from "lucide-react"

import type { Page } from "@/components/app-shell"
import {
  LogsTable,
  LogsTableAction,
  MetricGrid,
  UsageChart,
} from "@/components/data-views"
import { UsageView } from "@/components/usage-view"
import { LoadingView } from "@/components/loading-view"
import { LoadErrorView } from "@/components/load-error-view"
import { ProvidersView } from "@/components/providers-view"
import { PricingView } from "@/components/pricing-view"
import { ProxiesView } from "@/components/proxies-view"
import { RequestLogsWorkbench } from "@/components/request-logs-workbench"
import { RuntimeSettingsView } from "@/components/runtime-settings-view"
import { AdminSubscriptionsView } from "@/components/admin-subscriptions-view"
import {
  CopyField,
  CountBadge,
  PageFrame,
  StatusLabel,
} from "@/components/page-kit"
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
  currentUserId: string
  onPageChange: (page: Page) => void
}

export function AdminWorkspace({
  page,
  currentUserId,
  onPageChange,
}: AdminWorkspaceProps) {
  if (page === "users" || page === "invitations") {
    return (
      <UsersHub
        currentUserId={currentUserId}
        initialTab={page === "invitations" ? "invites" : "accounts"}
      />
    )
  }
  if (page === "providers") return <ProvidersView />
  if (page === "settings" || page === "proxies") {
    return (
      <SettingsHub initialTab={page === "proxies" ? "proxies" : "runtime"} />
    )
  }
  if (page === "subscriptions") return <AdminSubscriptionsView />
  if (page === "logs") return <RequestLogsWorkbench admin />
  if (page === "pricing") return <PricingView />
  if (page === "usage") return <UsageView admin />
  return <AdminOverviewPage onPageChange={onPageChange} />
}

function UsersHub({
  currentUserId,
  initialTab,
}: {
  currentUserId: string
  initialTab: "accounts" | "invites"
}) {
  const toast = useToast()
  const [tab, setTab] = useState(initialTab)
  const [users, setUsers] = useState<User[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [now] = useState(() => Date.now())

  const load = useCallback(
    async (showLoading = false) => {
      if (showLoading) setLoading(true)
      setLoadError("")
      try {
        const [usersValue, invitationsValue] = await Promise.all([
          api<{ items: User[] }>("/api/admin/tenants"),
          api<{ items: Invitation[] }>("/api/admin/invitations"),
        ])
        setUsers(usersValue.items ?? [])
        setInvitations(invitationsValue.items ?? [])
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : "无法读取用户数据"
        setLoadError(message)
        if (!showLoading) toast({ type: "error", body: message })
      } finally {
        if (showLoading) setLoading(false)
      }
    },
    [toast]
  )

  useEffect(() => {
    void load(true)
  }, [load])

  if (loading) return <LoadingView />
  if (loadError && users.length === 0 && invitations.length === 0) {
    return <LoadErrorView message={loadError} onRetry={() => void load(true)} />
  }

  const pendingInvites = invitations.filter((item) => {
    const expired = new Date(item.expires_at).getTime() <= now
    return !item.used_at && !item.revoked_at && !expired
  }).length

  const tabs = (
    <TabList
      value={tab}
      onChange={(value) => {
        if (value === "accounts" || value === "invites") setTab(value)
      }}
    >
      <Tab value="accounts" label="账号" />
      <Tab
        value="invites"
        label="邀请"
        endContent={
          pendingInvites > 0 ? <CountBadge value={pendingInvites} /> : undefined
        }
      />
    </TabList>
  )

  if (tab === "accounts") {
    return (
      <UsersView
        users={users}
        currentUserId={currentUserId}
        accessory={tabs}
        onChanged={() => load()}
      />
    )
  }
  return (
    <InvitationsView
      items={invitations}
      accessory={tabs}
      onChanged={() => load()}
    />
  )
}

function SettingsHub({ initialTab }: { initialTab: "runtime" | "proxies" }) {
  const [tab, setTab] = useState(initialTab)
  const tabs = (
    <TabList
      value={tab}
      onChange={(value) => {
        if (value === "runtime" || value === "proxies") setTab(value)
      }}
    >
      <Tab value="runtime" label="运行策略" />
      <Tab value="proxies" label="出站代理" />
    </TabList>
  )
  return tab === "runtime" ? (
    <RuntimeSettingsView accessory={tabs} />
  ) : (
    <ProxiesView accessory={tabs} />
  )
}

function AdminOverviewPage({
  onPageChange,
}: {
  onPageChange: (page: Page) => void
}) {
  const toast = useToast()
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [usage, setUsage] = useState<UsageReport | null>(null)
  const [logs, setLogs] = useState<RequestLog[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")

  const load = useCallback(
    async (showLoading = false) => {
      if (showLoading) setLoading(true)
      setLoadError("")
      try {
        const [overviewValue, usageValue, logsValue] = await Promise.all([
          api<AdminOverview>("/api/admin/overview"),
          api<UsageReport>("/api/admin/usage?days=30"),
          api<{ items: RequestLog[] }>("/api/admin/logs?limit=8"),
        ])
        setOverview(overviewValue)
        setUsage(usageValue)
        setLogs(logsValue.items ?? [])
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : "无法读取管理数据"
        setLoadError(message)
        if (!showLoading) toast({ type: "error", body: message })
      } finally {
        if (showLoading) setLoading(false)
      }
    },
    [toast]
  )

  useEffect(() => {
    void load(true)
  }, [load])

  if (loading) return <LoadingView />
  if (!overview || !usage) {
    return (
      <LoadErrorView
        message={loadError || "管理数据不完整"}
        onRetry={() => void load(true)}
      />
    )
  }

  return (
    <PageFrame title="工作台">
      <VStack gap={0}>
        <MetricGrid
          items={[
            {
              label: "用户",
              value: compact(overview.users),
              hint: `${overview.enabled_users} 正常`,
            },
            {
              label: "Keys",
              value: compact(overview.active_api_keys),
            },
            {
              label: "今日请求",
              value: compact(overview.today.requests),
              hint: compactTokens(overview.today.tokens),
            },
            {
              label: "今日错误",
              value: compact(overview.today.errors),
              hint: money(overview.today.cost_nano_usd),
            },
          ]}
        />
        <UsageChart report={usage} />
        <List density="compact" hasDividers>
          <ListItem
            label="待使用邀请"
            endContent={<CountBadge value={overview.pending_invitations} />}
            onClick={() => onPageChange("invitations")}
          />
          <ListItem
            label="正常用户"
            endContent={<CountBadge value={overview.enabled_users} />}
            onClick={() => onPageChange("users")}
          />
        </List>
        <LogsTable
          logs={logs}
          action={<LogsTableAction onOpen={() => onPageChange("logs")} />}
        />
      </VStack>
    </PageFrame>
  )
}

function UsersView({
  users,
  currentUserId,
  accessory,
  onChanged,
}: {
  users: User[]
  currentUserId: string
  accessory?: ReactNode
  onChanged: () => Promise<void>
}) {
  const toast = useToast()
  const [creditUser, setCreditUser] = useState<User | null>(null)
  const [resetUser, setResetUser] = useState<User | null>(null)
  const [deleteUser, setDeleteUser] = useState<User | null>(null)
  const [temporaryPassword, setTemporaryPassword] = useState("")
  const [amountUsd, setAmountUsd] = useState<number | undefined>(undefined)
  const [creditNote, setCreditNote] = useState("")
  const [pending, setPending] = useState(false)

  function openCredit(user: User) {
    setAmountUsd(undefined)
    setCreditNote("")
    setCreditUser(user)
  }

  function closeCredit() {
    if (pending) return
    setCreditUser(null)
    setAmountUsd(undefined)
    setCreditNote("")
  }

  async function credit() {
    if (!creditUser) return
    const amountUSD = amountUsd ?? 0
    if (
      !Number.isFinite(amountUSD) ||
      amountUSD <= 0 ||
      amountUSD > 1_000_000
    ) {
      toast({ type: "error", body: "充值金额必须大于 0 且不超过 1,000,000 USD" })
      return
    }
    const amountNanoUSD = Math.round(amountUSD * 1_000_000_000)
    setPending(true)
    try {
      await postJSON(`/api/admin/tenants/${creditUser.id}/credit`, {
        amount_nano_usd: amountNanoUSD,
        note: creditNote.trim() || "管理员充值",
      })
      await onChanged()
      toast({ body: `已为 ${creditUser.name} 充值 ${money(amountNanoUSD)}` })
      setCreditUser(null)
      setAmountUsd(undefined)
      setCreditNote("")
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "充值失败",
      })
    } finally {
      setPending(false)
    }
  }

  async function resetPassword() {
    if (!resetUser) return
    setPending(true)
    try {
      const result = await postJSON<{ temporary_password: string }>(
        `/api/admin/tenants/${resetUser.id}/password`,
        {}
      )
      setTemporaryPassword(result.temporary_password)
      await onChanged()
      toast({ body: `已重置 ${resetUser.name} 的密码` })
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "密码重置失败",
      })
    } finally {
      setPending(false)
    }
  }

  function closeReset() {
    if (pending) return
    setResetUser(null)
    setTemporaryPassword("")
  }

  async function toggleUser(user: User) {
    setPending(true)
    try {
      await api<User>(`/api/admin/tenants/${user.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: user.name,
          ownerEmail: user.owner_email,
          enabled: !user.enabled,
          rateLimitPerMinute: user.rate_limit_per_minute,
          tokenLimitDaily: user.token_limit_daily,
          modelAllowlist: user.model_allowlist,
        }),
      })
      await onChanged()
      toast({ body: `已${user.enabled ? "停用" : "启用"} ${user.name}` })
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "更新用户状态失败",
      })
    } finally {
      setPending(false)
    }
  }

  async function removeUser() {
    if (!deleteUser) return
    setPending(true)
    try {
      await deleteRequest(`/api/admin/tenants/${deleteUser.id}`)
      await onChanged()
      toast({ body: `已删除 ${deleteUser.name}` })
      setDeleteUser(null)
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "删除用户失败",
      })
    } finally {
      setPending(false)
    }
  }

  interface UserRow extends Record<string, unknown> {
    id: string
    name: string
    owner_email: string
    enabled: boolean
    is_admin: boolean
    balance: number
    created_at: string
    user: User
  }

  const rows: UserRow[] = users.map((user) => ({
    id: user.id,
    name: user.name,
    owner_email: user.owner_email,
    enabled: user.enabled,
    is_admin: user.is_admin,
    balance: user.balance_nano_usd,
    created_at: user.created_at,
    user,
  }))

  return (
    <>
    <PageFrame title="用户" accessory={accessory}>
        {rows.length ? (
          <Table
            data={rows}
            idKey="id"
            density="compact"
            hasHover
            textOverflow="truncate"
            columns={[
              {
                key: "name",
                header: "用户",
                width: proportional(1),
                renderCell: (row) => (
                  <HStack gap={2} vAlign="center">
                    <Text weight="semibold">{row.name}</Text>
                    {row.is_admin ? <Badge label="管理员" /> : null}
                  </HStack>
                ),
              },
              {
                key: "owner_email",
                header: "邮箱",
                width: proportional(1),
                renderCell: (row) => (
                  <Text color="secondary">{row.owner_email}</Text>
                ),
              },
              {
                key: "enabled",
                header: "状态",
                width: pixel(90),
                renderCell: (row) => (
                  <StatusLabel
                    tone={row.enabled ? "success" : "error"}
                    label={row.enabled ? "正常" : "停用"}
                  />
                ),
              },
              {
                key: "balance",
                header: "余额",
                width: pixel(120),
                align: "end",
                renderCell: (row) => <Text>{money(row.balance)}</Text>,
              },
              {
                key: "created_at",
                header: "注册时间",
                width: pixel(150),
                align: "end",
                renderCell: (row) => (
                  <Text color="secondary">{dateTime(row.created_at)}</Text>
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
                        label: "充值",
                        icon: <CircleDollarSignIcon />,
                        onClick: () => openCredit(row.user),
                      },
                      {
                        label: "重置密码",
                        icon: <KeyRoundIcon />,
                        onClick: () => {
                          setResetUser(row.user)
                          setTemporaryPassword("")
                        },
                      },
                      {
                        label: row.enabled ? "停用" : "启用",
                        icon: row.enabled ? <BanIcon /> : <CircleCheckIcon />,
                        isDisabled: pending || row.id === currentUserId,
                        onClick: () => void toggleUser(row.user),
                      },
                      { type: "divider" },
                      {
                        label: "删除",
                        variant: "destructive",
                        icon: <Trash2Icon />,
                        isDisabled: pending || row.id === currentUserId,
                        onClick: () => setDeleteUser(row.user),
                      },
                    ]}
                  />
                ),
              },
            ]}
          />
        ) : (
          <EmptyState
            title="还没有用户"
            icon={<UsersIcon />}
          />
        )}
    </PageFrame>

      <Dialog
        isOpen={Boolean(creditUser)}
        onOpenChange={(open) => {
          if (!open) closeCredit()
        }}
        width={520}
        purpose="form"
      >
        <Layout
          height="auto"
          header={
            <DialogHeader
              title="用户充值"
              subtitle={`为 ${creditUser?.name} 增加账户总余额。该操作会写入计费账本。`}
              onOpenChange={(open) => {
                if (!open) closeCredit()
              }}
            />
          }
          content={
            <LayoutContent>
              <FormLayout>
                <NumberInput
                  label="充值金额（USD）"
                  value={amountUsd}
                  onChange={setAmountUsd}
                  min={0.000001}
                  max={1_000_000}
                  step={0.000001}
                  placeholder="例如 10.00"
                  hasAutoFocus
                  isRequired
                  description={`充值后余额：${creditUser ? money(creditUser.balance_nano_usd) : "$0.00"} + 本次金额`}
                  onEnter={() => void credit()}
                />
                <TextInput
                  label="备注"
                  value={creditNote}
                  onChange={setCreditNote}
                  isOptional
                  placeholder="例如：订单号或线下收款说明"
                />
              </FormLayout>
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack hAlign="end" gap={2}>
                <Button
                  label="取消"
                  onClick={closeCredit}
                  isDisabled={pending}
                />
                <Button
                  label="确认充值"
                  variant="primary"
                  isLoading={pending}
                  onClick={() => void credit()}
                />
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>

      <AlertDialog
        isOpen={Boolean(deleteUser)}
        onOpenChange={(open) => {
          if (!open && !pending) setDeleteUser(null)
        }}
        title="永久删除用户？"
        description={`将永久删除 ${deleteUser?.name} 及其 API Key、订阅分配、请求日志和计费记录。此操作无法撤销。`}
        actionLabel="确认删除"
        cancelLabel="取消"
        isActionLoading={pending}
        onAction={() => void removeUser()}
      />

      <AlertDialog
        isOpen={Boolean(resetUser) && !temporaryPassword}
        onOpenChange={(open) => {
          if (!open && !pending && !temporaryPassword) setResetUser(null)
        }}
        title="重置用户密码"
        description={`${resetUser?.name} 的原密码将立即失效。用户使用临时密码登录后必须设置新密码。`}
        actionLabel="生成临时密码"
        cancelLabel="取消"
        isActionLoading={pending}
        onAction={() => void resetPassword()}
      />

      <Dialog
        isOpen={Boolean(temporaryPassword)}
        onOpenChange={(open) => {
          if (!open) closeReset()
        }}
        width={520}
        purpose="info"
      >
        <Layout
          height="auto"
          header={
            <DialogHeader
              title="临时密码已生成"
              subtitle={`将临时密码发送给 ${resetUser?.name}。该密码关闭后无法再次查看。`}
              onOpenChange={(open) => {
                if (!open) closeReset()
              }}
            />
          }
          content={
            <LayoutContent>
              <CopyField
                id="temporary-password"
                label="临时密码"
                value={temporaryPassword}
                description="用户首次登录后，该密码会被新密码替换。"
              />
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack hAlign="end" gap={2}>
                <Button label="完成" variant="primary" onClick={closeReset} />
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>
    </>
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
  return (
    typeof item.id === "string" &&
    typeof item.invite_url === "string" &&
    typeof item.expires_at === "string" &&
    new Date(item.expires_at).getTime() > Date.now()
  )
}

function invitationStatus(item: Invitation, now: number) {
  const expired = new Date(item.expires_at).getTime() <= now
  if (item.used_at) return { label: "已使用", tone: "neutral" as const, active: false }
  if (item.revoked_at)
    return { label: "已撤销", tone: "error" as const, active: false }
  if (expired) return { label: "已过期", tone: "warning" as const, active: false }
  return { label: "待使用", tone: "success" as const, active: true }
}

function InvitationsView({
  items,
  accessory,
  onChanged,
}: {
  items: Invitation[]
  accessory?: ReactNode
  onChanged: () => Promise<void>
}) {
  const toast = useToast()
  const [renderedAt, setRenderedAt] = useState(() => Date.now())
  const [open, setOpen] = useState(false)
  const [showResult, setShowResult] = useState(false)
  const [result, setResult] = useSessionStorage<GeneratedInvitation>(
    "relayapi.latest-invitation",
    isGeneratedInvitation
  )
  const [revokeItem, setRevokeItem] = useState<Invitation | null>(null)
  const [inviteEmail, setInviteEmail] = useState<string | undefined>(undefined)
  const [inviteHours, setInviteHours] = useState<number | undefined>(72)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    const timer = window.setInterval(() => setRenderedAt(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!result) return
    const item = items.find((candidate) => candidate.id === result.id)
    if (
      new Date(result.expires_at).getTime() <= Date.now() ||
      item?.used_at ||
      item?.revoked_at
    ) {
      setResult(null)
    }
  }, [items, result, setResult])

  function openCreate() {
    setShowResult(false)
    setInviteEmail(undefined)
    setInviteHours(72)
    setOpen(true)
  }

  function copyInviteUrl(value: string) {
    copyText(value)
      .then(() => toast({ body: "邀请链接已复制" }))
      .catch(() => toast({ type: "error", body: "复制失败，请手动选择链接" }))
  }

  async function create() {
    setPending(true)
    try {
      const value = await postJSON<{
        item: Invitation
        token: string
        invite_url: string
      }>("/api/admin/invitations", {
        email: inviteEmail ?? "",
        expires_in_hours: inviteHours ?? 72,
      })
      setResult({
        id: value.item.id,
        invite_url: value.invite_url,
        expires_at: value.item.expires_at,
      })
      setShowResult(true)
      await onChanged()
      toast({ body: "邀请已生成" })
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "生成失败",
      })
    } finally {
      setPending(false)
    }
  }

  async function revoke() {
    if (!revokeItem) return
    setPending(true)
    try {
      await deleteRequest(`/api/admin/invitations/${revokeItem.id}`)
      if (result?.id === revokeItem.id) setResult(null)
      await onChanged()
      toast({ body: "邀请已撤销" })
      setRevokeItem(null)
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "撤销失败",
      })
    } finally {
      setPending(false)
    }
  }

  interface InvitationRow extends Record<string, unknown> {
    id: string
    email: string
    created_at: string
    expires_at: string
    status: string
    tone: "success" | "warning" | "error" | "neutral"
    active: boolean
    item: Invitation
  }

  const rows: InvitationRow[] = items.map((item) => {
    const status = invitationStatus(item, renderedAt)
    return {
      id: item.id,
      email: item.email || "任意邮箱",
      created_at: item.created_at,
      expires_at: item.expires_at,
      status: status.label,
      tone: status.tone,
      active: status.active,
      item,
    }
  })

  return (
    <>
    <PageFrame
      title="用户"
      accessory={accessory}
      actions={
        <Button
          label="生成邀请"
          variant="primary"
          icon={<PlusIcon />}
          onClick={openCreate}
        />
      }
    >
      <VStack gap={0}>
      {result ? (
        <VStack gap={3} padding={4}>
          <HStack hAlign="between" vAlign="center">
            <Text weight="semibold">邀请链接</Text>
            <Button
              label="清除"
              variant="ghost"
              size="sm"
              icon={<XIcon />}
              onClick={() => setResult(null)}
            />
          </HStack>
          <InviteLinkField
            id="latest-invite-url"
            value={result.invite_url}
            onCopy={copyInviteUrl}
          />
        </VStack>
      ) : null}
        {rows.length ? (
          <Table
            data={rows}
            idKey="id"
            density="compact"
            hasHover
            textOverflow="truncate"
            columns={[
              { key: "email", header: "目标邮箱", width: proportional(1) },
              {
                key: "created_at",
                header: "创建时间",
                width: pixel(150),
                renderCell: (row) => (
                  <Text color="secondary">{dateTime(row.created_at)}</Text>
                ),
              },
              {
                key: "expires_at",
                header: "到期时间",
                width: pixel(150),
                renderCell: (row) => (
                  <Text color="secondary">{dateTime(row.expires_at)}</Text>
                ),
              },
              {
                key: "status",
                header: "状态",
                width: pixel(90),
                renderCell: (row) => (
                  <StatusLabel tone={row.tone} label={row.status} />
                ),
              },
              {
                key: "actions",
                header: "操作",
                width: pixel(80),
                align: "end",
                renderCell: (row) => (
                  <Button
                    label="撤销"
                    variant="ghost"
                    size="sm"
                    isDisabled={!row.active || pending}
                    onClick={() => setRevokeItem(row.item)}
                  />
                ),
              },
            ]}
          />
        ) : (
          <EmptyState
            title="还没有邀请"
            icon={<SendIcon />}
          />
        )}
      </VStack>
    </PageFrame>

      <Dialog
        isOpen={open}
        onOpenChange={setOpen}
        width={520}
        purpose={showResult && result ? "info" : "form"}
      >
        <Layout
          height="auto"
          header={
            <DialogHeader
              title={showResult && result ? "邀请已生成" : "生成邀请"}
              subtitle={
                showResult && result
                  ? "请复制并安全发送；关闭弹窗后仍可在邀请页顶部找到。"
                  : "可选填邮箱来限制邀请使用者。"
              }
              onOpenChange={setOpen}
            />
          }
          content={
            <LayoutContent>
              {showResult && result ? (
                <InviteLinkField
                  id="dialog-invite-url"
                  value={result.invite_url}
                  onCopy={copyInviteUrl}
                />
              ) : (
                <FormLayout>
                  <TextInput
                    label="限定邮箱"
                    type="email"
                    value={inviteEmail ?? ""}
                    onChange={(value) =>
                      setInviteEmail(value.trim() ? value : undefined)
                    }
                    isOptional
                    placeholder="留空则任何人可使用"
                    description="限定后，其他邮箱无法完成注册。"
                  />
                  <NumberInput
                    label="有效小时数"
                    value={inviteHours}
                    onChange={setInviteHours}
                    min={1}
                    max={720}
                    isIntegerOnly
                    isRequired
                    onEnter={() => void create()}
                  />
                </FormLayout>
              )}
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack hAlign="end" gap={2}>
                <Button
                  label={showResult && result ? "完成" : "取消"}
                  onClick={() => setOpen(false)}
                />
                {!(showResult && result) ? (
                  <Button
                    label="生成"
                    variant="primary"
                    isLoading={pending}
                    onClick={() => void create()}
                  />
                ) : null}
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>

      <AlertDialog
        isOpen={Boolean(revokeItem)}
        onOpenChange={(openChange) => {
          if (!openChange && !pending) setRevokeItem(null)
        }}
        title="撤销邀请"
        description="撤销后该邀请链接将立即失效。"
        actionLabel="撤销"
        cancelLabel="取消"
        isActionLoading={pending}
        onAction={() => void revoke()}
      />
    </>
  )
}

function InviteLinkField({
  id,
  value,
  onCopy,
}: {
  id: string
  value: string
  onCopy: (value: string) => void
}) {
  return (
    <HStack gap={2} vAlign="end">
      <StackItem size="fill">
        <TextInput
          id={id}
          label="邀请链接"
          value={value}
          isReadOnly
          width="100%"
        />
      </StackItem>
      <Button
        label="复制"
        variant="secondary"
        onClick={() => onCopy(value)}
      />
    </HStack>
  )
}

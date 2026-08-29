import { useCallback, useState, type FormEvent } from "react"
import { Button } from "@cloudflare/kumo/components/button"
import { ClipboardText } from "@cloudflare/kumo/components/clipboard-text"
import { Dialog } from "@cloudflare/kumo/components/dialog"
import { Field } from "@cloudflare/kumo/components/field"
import { Input } from "@cloudflare/kumo/components/input"
import { Tabs } from "@cloudflare/kumo/components/tabs"
import { useAsyncResource } from "@/hooks/use-async-resource"
import {
  api,
  deleteRequest,
  postJSON,
  type Invitation,
  type User,
} from "@/lib/api"
import { dateTime, money } from "@/lib/format"
import { errorMessage, toast } from "@/lib/toast"
import {
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  Page,
  Surface,
} from "@/console/kit"

export function AdminUsersPage({ currentUserId }: { currentUserId: string }) {
  const [tab, setTab] = useState("users")
  const loadUsers = useCallback(async () => {
    const value = await api<{ items: User[] }>("/api/admin/tenants")
    return value.items ?? []
  }, [])
  const loadInvites = useCallback(async () => {
    const value = await api<{ items: Invitation[] }>("/api/admin/invitations")
    return value.items ?? []
  }, [])
  const users = useAsyncResource(loadUsers, {
    initialData: [],
    errorMessage: "无法读取用户",
    onBackgroundError: (message) => toast.error(message),
  })
  const invites = useAsyncResource(loadInvites, {
    initialData: [],
    errorMessage: "无法读取邀请",
    onBackgroundError: (message) => toast.error(message),
  })
  const [createOpen, setCreateOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteUrl, setInviteUrl] = useState("")
  const [tempPassword, setTempPassword] = useState("")
  const [pending, setPending] = useState(false)

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setPending(true)
    try {
      await postJSON("/api/admin/tenants", {
        name: String(data.get("name") ?? ""),
        owner_email: String(data.get("owner_email") ?? ""),
        password: String(data.get("password") ?? ""),
        enabled: true,
        model_allowlist: [],
      })
      setCreateOpen(false)
      toast.success("用户已创建")
      await users.reload()
    } catch (cause) {
      toast.error(errorMessage(cause, "创建失败"))
    } finally {
      setPending(false)
    }
  }

  async function createInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setPending(true)
    try {
      const result = await postJSON<{ invite_url: string }>(
        "/api/admin/invitations",
        {
          email: String(data.get("email") ?? ""),
          expires_in_hours: Number(data.get("expires_in_hours") || 72),
        }
      )
      setInviteUrl(result.invite_url)
      setInviteOpen(false)
      toast.success("邀请已创建，链接只显示一次")
      await invites.reload()
    } catch (cause) {
      toast.error(errorMessage(cause, "创建失败"))
    } finally {
      setPending(false)
    }
  }

  async function credit(id: string) {
    const raw = window.prompt("充值金额（USD，可为负）", "10")
    if (raw == null) return
    const amount = Number(raw)
    if (!Number.isFinite(amount) || amount === 0) {
      toast.error("金额不能为 0")
      return
    }
    try {
      await postJSON(`/api/admin/tenants/${id}/credit`, {
        amount_nano_usd: Math.round(amount * 1_000_000_000),
        note: "控制台充值",
      })
      toast.success("余额已更新")
      await users.reload()
    } catch (cause) {
      toast.error(errorMessage(cause, "充值失败"))
    }
  }

  async function resetPassword(id: string) {
    try {
      const result = await postJSON<{ temporary_password: string }>(
        `/api/admin/tenants/${id}/password`,
        {}
      )
      setTempPassword(result.temporary_password)
      toast.success("已生成临时密码")
    } catch (cause) {
      toast.error(errorMessage(cause, "重置失败"))
    }
  }

  async function removeUser(id: string) {
    if (!window.confirm("删除用户会同时删除其 Key 和用量归属。")) return
    try {
      await deleteRequest(`/api/admin/tenants/${id}`)
      toast.success("用户已删除")
      await users.reload()
    } catch (cause) {
      toast.error(errorMessage(cause, "删除失败"))
    }
  }

  async function revoke(id: string) {
    try {
      await deleteRequest(`/api/admin/invitations/${id}`)
      toast.success("邀请已撤销")
      await invites.reload()
    } catch (cause) {
      toast.error(errorMessage(cause, "撤销失败"))
    }
  }

  if (users.loading && invites.loading) return <LoadingState />

  return (
    <Page title="用户" description="租户账户、余额和单次邀请。">
      <Tabs
        variant="underline"
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: "users", label: "用户" },
          { value: "invitations", label: "邀请" },
        ]}
      />
      {inviteUrl ? (
        <Surface title="邀请链接只显示一次">
          <ClipboardText text={inviteUrl} />
        </Surface>
      ) : null}
      {tempPassword ? (
        <Surface title="临时密码">
          <ClipboardText text={tempPassword} />
        </Surface>
      ) : null}

      {tab === "users" ? (
        <>
          {users.error && users.data.length === 0 ? (
            <ErrorState
              message={users.error}
              onRetry={() => void users.reload(true)}
            />
          ) : (
            <Surface
              title={
                <div className="flex items-center justify-between">
                  <span>用户</span>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => setCreateOpen(true)}
                  >
                    新建用户
                  </Button>
                </div>
              }
            >
              <DataTable
                columns={["名称", "邮箱", "余额", "角色", ""]}
                empty={<EmptyState title="还没有用户" />}
                rows={users.data.map((user) => (
                  <tr
                    key={user.id}
                    className="border-b border-kumo-hairline last:border-0"
                  >
                    <td className="px-3 py-2">{user.name}</td>
                    <td className="px-3 py-2">{user.owner_email}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {money(user.balance_nano_usd)}
                    </td>
                    <td className="px-3 py-2">
                      {user.is_admin
                        ? "管理员"
                        : user.enabled
                          ? "启用"
                          : "停用"}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void credit(user.id)}
                        >
                          充值
                        </Button>
                        {user.id !== currentUserId ? (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void resetPassword(user.id)}
                            >
                              重置密码
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary-destructive"
                              onClick={() => void removeUser(user.id)}
                            >
                              删除
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              />
            </Surface>
          )}
        </>
      ) : (
        <Surface
          title={
            <div className="flex items-center justify-between">
              <span>邀请</span>
              <Button
                size="sm"
                variant="primary"
                onClick={() => setInviteOpen(true)}
              >
                生成邀请
              </Button>
            </div>
          }
        >
          {invites.error && invites.data.length === 0 ? (
            <ErrorState
              message={invites.error}
              onRetry={() => void invites.reload(true)}
            />
          ) : (
            <DataTable
              columns={["邮箱", "过期", "状态", ""]}
              empty={<EmptyState title="没有邀请" />}
              rows={invites.data.map((item) => (
                <tr
                  key={item.id}
                  className="border-b border-kumo-hairline last:border-0"
                >
                  <td className="px-3 py-2">{item.email || "不限邮箱"}</td>
                  <td className="px-3 py-2 text-kumo-subtle">
                    {dateTime(item.expires_at)}
                  </td>
                  <td className="px-3 py-2">
                    {item.revoked_at
                      ? "已撤销"
                      : item.used_at
                        ? "已使用"
                        : "待使用"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {!item.used_at && !item.revoked_at ? (
                      <Button
                        size="sm"
                        variant="secondary-destructive"
                        onClick={() => void revoke(item.id)}
                      >
                        撤销
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            />
          )}
        </Surface>
      )}

      <Dialog.Root open={createOpen} onOpenChange={setCreateOpen}>
        <Dialog>
          <Dialog.Title>新建用户</Dialog.Title>
          <form className="mt-4 flex flex-col gap-4" onSubmit={createUser}>
            <Field label="显示名称">
              <Input name="name" required />
            </Field>
            <Field label="邮箱">
              <Input name="owner_email" type="email" required />
            </Field>
            <Field label="初始密码" description="至少 8 位。">
              <Input name="password" type="password" minLength={8} required />
            </Field>
            <div className="flex justify-end gap-2">
              <Dialog.Close
                render={<Button variant="secondary">取消</Button>}
              />
              <Button type="submit" variant="primary" loading={pending}>
                创建
              </Button>
            </div>
          </form>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root open={inviteOpen} onOpenChange={setInviteOpen}>
        <Dialog>
          <Dialog.Title>生成邀请</Dialog.Title>
          <form className="mt-4 flex flex-col gap-4" onSubmit={createInvite}>
            <Field label="限制邮箱" required={false}>
              <Input name="email" type="email" />
            </Field>
            <Field label="有效小时">
              <Input
                name="expires_in_hours"
                type="number"
                defaultValue="72"
                min={1}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Dialog.Close
                render={<Button variant="secondary">取消</Button>}
              />
              <Button type="submit" variant="primary" loading={pending}>
                生成
              </Button>
            </div>
          </form>
        </Dialog>
      </Dialog.Root>
    </Page>
  )
}

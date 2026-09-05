import { useState, type FormEvent } from "react"
import {
  BanIcon,
  CircleCheckIcon,
  CircleDollarSignIcon,
  CopyIcon,
  KeyRoundIcon,
  MoreHorizontalIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react"
import { toast } from "@/components/ui/toast"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { api, deleteRequest, postJSON, type User } from "@/lib/api"
import { dateTime, money } from "@/lib/format"
import { copyText } from "@/lib/clipboard"

export function UsersView({
  users,
  currentUserId,
  onChanged,
}: {
  users: User[]
  currentUserId: string
  onChanged: () => Promise<void>
}) {
  const [creditUser, setCreditUser] = useState<User | null>(null)
  const [resetUser, setResetUser] = useState<User | null>(null)
  const [deleteUser, setDeleteUser] = useState<User | null>(null)
  const [temporaryPassword, setTemporaryPassword] = useState("")
  const [pending, setPending] = useState(false)

  async function credit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!creditUser) return
    const data = new FormData(event.currentTarget)
    const amountUSD = Number(data.get("amount_usd"))
    if (
      !Number.isFinite(amountUSD) ||
      amountUSD <= 0 ||
      amountUSD > 1_000_000
    ) {
      toast.add({
        title: "充值金额必须大于 0 且不超过 1,000,000 USD",
        type: "error",
      })
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
      toast.add({
        title: `已为 ${creditUser.name} 充值 ${money(amountNanoUSD)}`,
        type: "success",
      })
      setCreditUser(null)
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "充值失败",
        type: "error",
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
      toast.add({ title: `已重置 ${resetUser.name} 的密码`, type: "success" })
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "密码重置失败",
        type: "error",
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
      toast.add({
        title: `已${user.enabled ? "停用" : "启用"} ${user.name}`,
        type: "success",
      })
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "更新用户状态失败",
        type: "error",
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
      toast.add({ title: `已删除 ${deleteUser.name}`, type: "success" })
      setDeleteUser(null)
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "删除用户失败",
        type: "error",
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>全部用户</CardTitle>
          <CardDescription>{users.length} 个账户</CardDescription>
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
                        {user.is_admin ? (
                          <Badge variant="outline">管理员</Badge>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {user.owner_email}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={user.enabled ? "secondary" : "destructive"}
                      >
                        {user.enabled ? "正常" : "停用"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(user.balance_nano_usd)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {dateTime(user.created_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="inline-flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setCreditUser(user)}
                        >
                          <CircleDollarSignIcon data-icon="inline-start" />
                          充值
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={`管理 ${user.name}`}
                              />
                            }
                          >
                            <MoreHorizontalIcon />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuGroup>
                              <DropdownMenuItem
                                onClick={() => {
                                  setResetUser(user)
                                  setTemporaryPassword("")
                                }}
                              >
                                <KeyRoundIcon />
                                重置密码
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={pending || user.id === currentUserId}
                                onClick={() => void toggleUser(user)}
                              >
                                {user.enabled ? (
                                  <BanIcon />
                                ) : (
                                  <CircleCheckIcon />
                                )}
                                {user.enabled ? "停用" : "启用"}
                              </DropdownMenuItem>
                            </DropdownMenuGroup>
                            <DropdownMenuSeparator />
                            <DropdownMenuGroup>
                              <DropdownMenuItem
                                variant="destructive"
                                disabled={pending || user.id === currentUserId}
                                onClick={() => setDeleteUser(user)}
                              >
                                <Trash2Icon />
                                删除
                              </DropdownMenuItem>
                            </DropdownMenuGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <UsersIcon />
                </EmptyMedia>
                <EmptyTitle>还没有用户</EmptyTitle>
                <EmptyDescription>
                  生成邀请链接来添加第一个用户。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>
      <Dialog
        open={Boolean(creditUser)}
        onOpenChange={(open) => {
          if (!open && !pending) setCreditUser(null)
        }}
      >
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
                <FieldDescription>
                  充值后余额：
                  {creditUser ? money(creditUser.balance_nano_usd) : "$0.00"} +
                  本次金额
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="credit-note">备注</FieldLabel>
                <Input
                  id="credit-note"
                  name="note"
                  maxLength={200}
                  placeholder="例如：订单号或线下收款说明"
                />
              </Field>
            </FieldGroup>
          </form>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreditUser(null)}
              disabled={pending}
            >
              取消
            </Button>
            <Button type="submit" form="credit-user-form" disabled={pending}>
              {pending ? (
                <Spinner />
              ) : (
                <CircleDollarSignIcon data-icon="inline-start" />
              )}
              确认充值
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={Boolean(deleteUser)}
        onOpenChange={(open) => {
          if (!open && !pending) setDeleteUser(null)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Trash2Icon />
            </AlertDialogMedia>
            <AlertDialogTitle>永久删除用户？</AlertDialogTitle>
            <AlertDialogDescription>
              将永久删除 {deleteUser?.name} 及其 API
              Key、订阅分配、请求日志和计费记录。此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={() => void removeUser()}
            >
              {pending ? <Spinner /> : <Trash2Icon data-icon="inline-start" />}
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog
        open={Boolean(resetUser)}
        onOpenChange={(open) => {
          if (!open) closeReset()
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {temporaryPassword ? "临时密码已生成" : "重置用户密码"}
            </DialogTitle>
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
                  <InputGroupInput
                    id="temporary-password"
                    value={temporaryPassword}
                    readOnly
                    className="font-mono"
                  />
                  <InputGroupAddon align="inline-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label="复制临时密码"
                      onClick={() =>
                        void copyText(temporaryPassword).then(() =>
                          toast.add({
                            title: "临时密码已复制",
                            type: "success",
                          })
                        )
                      }
                    >
                      <CopyIcon />
                    </Button>
                  </InputGroupAddon>
                </InputGroup>
                <FieldDescription>
                  用户首次登录后，该密码会被新密码替换。
                </FieldDescription>
              </Field>
            </FieldGroup>
          ) : null}
          <DialogFooter>
            {temporaryPassword ? (
              <Button onClick={closeReset}>完成</Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={closeReset}
                  disabled={pending}
                >
                  取消
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => void resetPassword()}
                  disabled={pending}
                >
                  {pending ? (
                    <Spinner />
                  ) : (
                    <KeyRoundIcon data-icon="inline-start" />
                  )}
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

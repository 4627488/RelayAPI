import { useEffect, useState, type FormEvent } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  CopyIcon,
  PlusIcon,
  SendIcon,
  Delete02Icon,
  XIcon,
} from "@hugeicons/core-free-icons"
import { toast } from "@/components/ui/toast"
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
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
import { PageHeader } from "@/components/workspace-ui"
import { deleteRequest, postJSON, type Invitation } from "@/lib/api"
import { dateTime } from "@/lib/format"
import { copyText } from "@/lib/clipboard"
import { useSessionStorage } from "@/hooks/use-session-storage"

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

export function InvitationsView({
  items,
  onChanged,
}: {
  items: Invitation[]
  onChanged: () => Promise<void>
}) {
  const [renderedAt, setRenderedAt] = useState(() => Date.now())
  const [open, setOpen] = useState(false)
  const [showResult, setShowResult] = useState(false)
  const [result, setResult] = useSessionStorage<GeneratedInvitation>(
    "relayapi.latest-invitation",
    isGeneratedInvitation
  )
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

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setPending(true)
    try {
      const value = await postJSON<{
        item: Invitation
        token: string
        invite_url: string
      }>("/api/admin/invitations", {
        email: String(data.get("email") ?? ""),
        expires_in_hours: Number(data.get("hours") ?? 72),
      })
      setResult({
        id: value.item.id,
        invite_url: value.invite_url,
        expires_at: value.item.expires_at,
      })
      setShowResult(true)
      await onChanged()
      toast.add({ title: "邀请已生成", type: "success" })
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "生成失败",
        type: "error",
      })
    } finally {
      setPending(false)
    }
  }

  async function revoke(id: string) {
    try {
      await deleteRequest(`/api/admin/invitations/${id}`)
      if (result?.id === id) setResult(null)
      await onChanged()
      toast.add({ title: "邀请已撤销", type: "success" })
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "撤销失败",
        type: "error",
      })
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="邀请"
        actions={
          <Button
            onClick={() => {
              setShowResult(false)
              setOpen(true)
            }}
          >
            <HugeiconsIcon
              strokeWidth={2}
              icon={PlusIcon}
              data-icon="inline-start"
            />
            生成邀请
          </Button>
        }
      />
      {result ? (
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>最近生成的邀请链接</CardTitle>
              <CardDescription>关闭标签页后无法再次查看。</CardDescription>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="清除邀请链接"
              onClick={() => setResult(null)}
            >
              <HugeiconsIcon strokeWidth={2} icon={XIcon} />
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
                  const expired =
                    new Date(item.expires_at).getTime() <= renderedAt
                  const active = !item.used_at && !item.revoked_at && !expired
                  return (
                    <TableRow key={item.id}>
                      <TableCell>{item.email || "任意邮箱"}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {dateTime(item.created_at)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {dateTime(item.expires_at)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={active ? "secondary" : "outline"}>
                          {item.used_at
                            ? "已使用"
                            : item.revoked_at
                              ? "已撤销"
                              : expired
                                ? "已过期"
                                : "待使用"}
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
                          <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
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
                <EmptyMedia variant="icon">
                  <HugeiconsIcon strokeWidth={2} icon={SendIcon} />
                </EmptyMedia>
                <EmptyTitle>还没有邀请</EmptyTitle>
                <EmptyDescription>
                  生成链接，让用户自行完成注册。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {showResult && result ? "邀请已生成" : "生成邀请"}
            </DialogTitle>
            <DialogDescription>
              {showResult && result
                ? "请复制并安全发送；关闭弹窗后仍可在邀请页顶部找到。"
                : "可选填邮箱来限制邀请使用者。"}
            </DialogDescription>
          </DialogHeader>
          {showResult && result ? (
            <InviteLinkField id="dialog-invite-url" value={result.invite_url} />
          ) : (
            <form id="invite-form" onSubmit={create}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="invite-email">限定邮箱</FieldLabel>
                  <Input
                    id="invite-email"
                    name="email"
                    type="email"
                    placeholder="留空则任何人可使用"
                  />
                  <FieldDescription>
                    限定后，其他邮箱无法完成注册。
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="invite-hours">有效小时数</FieldLabel>
                  <Input
                    id="invite-hours"
                    name="hours"
                    type="number"
                    min="1"
                    max="720"
                    defaultValue="72"
                    required
                  />
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
                {pending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <HugeiconsIcon
                    strokeWidth={2}
                    icon={SendIcon}
                    data-icon="inline-start"
                  />
                )}
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
                  .then(() =>
                    toast.add({ title: "邀请链接已复制", type: "success" })
                  )
                  .catch(() =>
                    toast.add({
                      title: "复制失败，请手动选择链接",
                      type: "error",
                    })
                  )
              }}
            >
              <HugeiconsIcon strokeWidth={2} icon={CopyIcon} />
            </Button>
          </InputGroupAddon>
        </InputGroup>
      </Field>
    </FieldGroup>
  )
}

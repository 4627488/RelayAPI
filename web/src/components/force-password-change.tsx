import { useState, type FormEvent } from "react"
import { KeyRoundIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { postJSON } from "@/lib/api"

export function ForcePasswordChange({
  onChanged,
  onLogout,
}: {
  onChanged: () => Promise<void>
  onLogout: () => void
}) {
  const [pending, setPending] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const password = String(data.get("password") ?? "")
    const confirmation = String(data.get("confirmation") ?? "")
    if (password.length < 12) {
      toast.error("新密码至少 12 位")
      return
    }
    if (password !== confirmation) {
      toast.error("两次输入的密码不一致")
      return
    }
    setPending(true)
    try {
      await postJSON("/api/auth/password", { password })
      await onChanged()
      form.reset()
      toast.success("密码已修改")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "密码修改失败")
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>设置新密码</CardTitle>
          <CardDescription>
            当前密码由管理员临时生成。设置新密码后才能继续使用账户。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form id="force-password-change" onSubmit={submit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="new-password">新密码</FieldLabel>
                <Input
                  id="new-password"
                  name="password"
                  type="password"
                  minLength={12}
                  autoComplete="new-password"
                  autoFocus
                  required
                />
                <FieldDescription>至少 12 位。</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="confirm-password">确认新密码</FieldLabel>
                <Input
                  id="confirm-password"
                  name="confirmation"
                  type="password"
                  minLength={12}
                  autoComplete="new-password"
                  required
                />
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
        <CardFooter className="flex justify-between gap-2">
          <Button variant="outline" onClick={onLogout} disabled={pending}>
            退出登录
          </Button>
          <Button type="submit" form="force-password-change" disabled={pending}>
            {pending ? <Spinner /> : <KeyRoundIcon data-icon="inline-start" />}
            保存新密码
          </Button>
        </CardFooter>
      </Card>
    </main>
  )
}

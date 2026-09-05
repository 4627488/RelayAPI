import { useState, type FormEvent } from "react"
import { Button } from "@cloudflare/kumo/components/button"
import { LayerCard } from "@cloudflare/kumo/components/layer-card"
import { SensitiveInput } from "@cloudflare/kumo/components/sensitive-input"
import { postJSON } from "@/lib/api"
import { errorMessage, toast } from "@/lib/toast"

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
      toast.error(errorMessage(cause, "密码修改失败"))
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <LayerCard className="w-full max-w-md">
        <LayerCard.Secondary>
          <div>
            <h1 className="text-base font-semibold">设置新密码</h1>
            <p className="text-sm text-kumo-subtle">
              当前密码由管理员临时生成。设置新密码后才能继续使用账户。
            </p>
          </div>
        </LayerCard.Secondary>
        <LayerCard.Primary>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <SensitiveInput
              label="新密码"
              name="password"
              autoComplete="new-password"
              required
              description="至少 12 位。"
            />
            <SensitiveInput
              label="确认新密码"
              name="confirmation"
              autoComplete="new-password"
              required
            />
            <div className="flex justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={onLogout}
                disabled={pending}
              >
                退出登录
              </Button>
              <Button type="submit" variant="primary" loading={pending}>
                保存新密码
              </Button>
            </div>
          </form>
        </LayerCard.Primary>
      </LayerCard>
    </main>
  )
}

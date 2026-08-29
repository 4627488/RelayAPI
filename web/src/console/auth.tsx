import { useEffect, useState, type FormEvent } from "react"
import { PaperPlaneTiltIcon } from "@phosphor-icons/react"
import { Banner } from "@cloudflare/kumo/components/banner"
import { Button } from "@cloudflare/kumo/components/button"
import { Input } from "@cloudflare/kumo/components/input"
import { LayerCard } from "@cloudflare/kumo/components/layer-card"
import { SensitiveInput } from "@cloudflare/kumo/components/sensitive-input"
import { api, postJSON, type AuthStatus, type Session } from "@/lib/api"
import { errorMessage, toast } from "@/lib/toast"

function copy(mode: string, setupRequired: boolean) {
  if (mode === "register") {
    return setupRequired
      ? {
          title: "初始化 RelayAPI",
          description: "首个用户将拥有管理员权限。",
          submit: "创建账户",
          switchLabel: "已有账户？登录",
        }
      : {
          title: "接受邀请",
          description: "用邀请 Token 创建账户。",
          submit: "创建账户",
          switchLabel: "已有账户？登录",
        }
  }
  return {
    title: "登录",
    description: "使用已有账户进入控制台。",
    submit: "登录",
    switchLabel: setupRequired
      ? "首次使用？创建首个用户"
      : "已有邀请？创建账户",
  }
}

export function AuthPage({
  onAuthenticated,
}: {
  onAuthenticated: (session: Session) => void
}) {
  const token = new URLSearchParams(window.location.search).get("token")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [mode, setMode] = useState(token ? "register" : "login")
  const [setupRequired, setSetupRequired] = useState(false)
  const labels = copy(mode, setupRequired)

  useEffect(() => {
    api<AuthStatus>("/api/auth/status")
      .then((status) => {
        setSetupRequired(status.setup_required)
        if (status.setup_required) setMode("register")
      })
      .catch(() => undefined)
  }, [])

  async function submit(path: string, payload: Record<string, string>) {
    setPending(true)
    setError("")
    try {
      const session = await postJSON<Session>(path, payload)
      toast.success(path.endsWith("register") ? "账户已创建" : "欢迎回来")
      onAuthenticated(session)
    } catch (cause) {
      setError(errorMessage(cause, "请求失败，请稍后重试"))
    } finally {
      setPending(false)
    }
  }

  function onLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    void submit("/api/auth/login", {
      email: String(data.get("email") ?? ""),
      password: String(data.get("password") ?? ""),
    })
  }

  function onRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    void submit("/api/auth/register", {
      token: String(data.get("token") ?? token ?? ""),
      name: String(data.get("name") ?? ""),
      email: String(data.get("email") ?? ""),
      password: String(data.get("password") ?? ""),
    })
  }

  return (
    <main className="flex min-h-svh flex-col items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-kumo-contrast text-kumo-inverse">
            <PaperPlaneTiltIcon />
          </div>
          <div className="grid text-sm leading-tight">
            <span className="font-semibold">RelayAPI</span>
            <span className="text-xs text-kumo-subtle">模型网关</span>
          </div>
        </div>

        {error ? (
          <Banner
            variant="error"
            title="无法继续"
            description={error}
            size="sm"
          />
        ) : null}

        <LayerCard>
          <LayerCard.Secondary>
            <div>
              <h1 className="text-base font-semibold">{labels.title}</h1>
              <p className="text-sm text-kumo-subtle">{labels.description}</p>
            </div>
          </LayerCard.Secondary>
          <LayerCard.Primary>
            {mode === "register" ? (
              <form className="flex flex-col gap-4" onSubmit={onRegister}>
                {!setupRequired ? (
                  <Input
                    name="token"
                    label="邀请 Token"
                    defaultValue={token ?? ""}
                    required
                  />
                ) : null}
                <Input
                  name="name"
                  label="显示名称"
                  autoComplete="name"
                  required
                />
                <Input
                  name="email"
                  type="email"
                  label="邮箱"
                  autoComplete="email"
                  required
                />
                <SensitiveInput
                  label="密码"
                  name="password"
                  autoComplete="new-password"
                  required
                  description="至少 8 个字符。"
                />
                <Button type="submit" variant="primary" loading={pending}>
                  {labels.submit}
                </Button>
              </form>
            ) : (
              <form className="flex flex-col gap-4" onSubmit={onLogin}>
                <Input
                  name="email"
                  type="email"
                  label="邮箱"
                  autoComplete="username"
                  required
                />
                <SensitiveInput
                  label="密码"
                  name="password"
                  autoComplete="current-password"
                  required
                />
                <Button type="submit" variant="primary" loading={pending}>
                  {labels.submit}
                </Button>
              </form>
            )}
          </LayerCard.Primary>
        </LayerCard>

        <Button
          variant="ghost"
          className="self-center"
          onClick={() => setMode(mode === "register" ? "login" : "register")}
        >
          {labels.switchLabel}
        </Button>
      </div>
    </main>
  )
}

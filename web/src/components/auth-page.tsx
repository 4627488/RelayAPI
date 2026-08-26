import { useEffect, useState, type FormEvent } from "react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { api, postJSON, type AuthStatus, type Session } from "@/lib/api"

interface AuthPageProps {
  onAuthenticated: (session: Session) => void
}

export function AuthPage({ onAuthenticated }: AuthPageProps) {
  const token = new URLSearchParams(window.location.search).get("token")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [mode, setMode] = useState(token ? "register" : "login")
  const [setupRequired, setSetupRequired] = useState(false)

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
      setError(cause instanceof Error ? cause.message : "请求失败，请稍后重试")
    } finally {
      setPending(false)
    }
  }

  function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    void submit("/api/auth/login", {
      email: String(data.get("email") ?? ""),
      password: String(data.get("password") ?? ""),
    })
  }

  function register(event: FormEvent<HTMLFormElement>) {
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
    <main className="flex min-h-svh items-center justify-center p-5 sm:p-10">
      <section className="flex w-full max-w-sm flex-col gap-8">
        <div>
          <p className="mb-8 text-sm font-semibold">RelayAPI</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {mode === "register"
              ? setupRequired
                ? "初始化 RelayAPI"
                : "接受邀请"
              : "登录 RelayAPI"}
          </h1>
          {mode === "register" && setupRequired ? (
            <p className="mt-2 text-sm text-muted-foreground">
              首个用户将拥有管理员权限。
            </p>
          ) : null}
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>无法继续</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {mode === "register" ? (
          <form onSubmit={register}>
            <FieldGroup>
              {!setupRequired ? (
                <Field>
                  <FieldLabel htmlFor="token">邀请 Token</FieldLabel>
                  <Input
                    id="token"
                    name="token"
                    defaultValue={token ?? ""}
                    required
                  />
                </Field>
              ) : null}
              <Field>
                <FieldLabel htmlFor="name">显示名称</FieldLabel>
                <Input id="name" name="name" autoComplete="name" required />
              </Field>
              <Field>
                <FieldLabel htmlFor="register-email">邮箱</FieldLabel>
                <Input
                  id="register-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="register-password">密码</FieldLabel>
                <Input
                  id="register-password"
                  name="password"
                  type="password"
                  minLength={8}
                  autoComplete="new-password"
                  required
                />
                <FieldDescription>至少 8 个字符。</FieldDescription>
              </Field>
              <Button type="submit" disabled={pending}>
                {pending ? <Spinner data-icon="inline-start" /> : null}
                创建账户
              </Button>
            </FieldGroup>
          </form>
        ) : (
          <form onSubmit={login}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="email">邮箱</FieldLabel>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">密码</FieldLabel>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </Field>
              <Button type="submit" disabled={pending}>
                {pending ? <Spinner data-icon="inline-start" /> : null}
                登录
              </Button>
            </FieldGroup>
          </form>
        )}

        <Button
          variant="ghost"
          onClick={() => setMode(mode === "register" ? "login" : "register")}
        >
          {mode === "register"
            ? "已有账户？返回登录"
            : setupRequired
              ? "首次使用？创建首个用户"
              : "已有邀请？创建账户"}
        </Button>
      </section>
    </main>
  )
}

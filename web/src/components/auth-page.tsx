import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import { SendIcon } from "lucide-react"
import { toast } from "@/components/ui/toast"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { api, postJSON, type AuthStatus, type Session } from "@/lib/api"

interface AuthPageProps {
  onAuthenticated: (session: Session) => void
}

function AuthFrame({
  title,
  description,
  children,
  footer,
}: {
  title: ReactNode
  description: ReactNode
  children: ReactNode
  footer: ReactNode
}) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/30 px-4 py-8 sm:px-6">
      <section className="w-full max-w-md" aria-labelledby="auth-title">
        <div className="mb-6 flex items-center gap-3 px-1">
          <SendIcon />
          <div className="leading-tight">
            <p className="text-base font-semibold">RelayAPI</p>
            <p className="text-xs text-muted-foreground">管理控制台</p>
          </div>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl font-semibold tracking-tight">
              <h1 id="auth-title">{title}</h1>
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent>{children}</CardContent>
          <CardFooter className="flex-col gap-3">{footer}</CardFooter>
        </Card>
      </section>
    </main>
  )
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
      toast.add({
        title: path.endsWith("register") ? "账户已创建" : "欢迎回来",
        type: "success",
      })
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

  const title =
    mode === "register"
      ? setupRequired
        ? "初始化 RelayAPI"
        : "接受邀请"
      : "登录 RelayAPI"
  const description =
    mode === "register"
      ? setupRequired
        ? "创建首个管理员账户。"
        : "使用邀请完成账户创建。"
      : "使用邮箱和密码登录。"

  return (
    <AuthFrame
      title={title}
      description={description}
      footer={
        <Button
          variant="ghost"
          className="w-full"
          onClick={() => setMode(mode === "register" ? "login" : "register")}
        >
          {mode === "register"
            ? "已有账户？返回登录"
            : setupRequired
              ? "首次使用？创建首个用户"
              : "已有邀请？创建账户"}
        </Button>
      }
    >
      {error ? (
        <Alert className="mb-5" variant="destructive">
          <AlertTitle>无法继续</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {mode === "register" ? (
        <form key="register" onSubmit={register}>
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
            <Button className="w-full" type="submit" disabled={pending}>
              {pending ? <Spinner data-icon="inline-start" /> : null}
              创建账户
            </Button>
          </FieldGroup>
        </form>
      ) : (
        <form key="login" onSubmit={login}>
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
            <Button className="w-full" type="submit" disabled={pending}>
              {pending ? <Spinner data-icon="inline-start" /> : null}
              登录
            </Button>
          </FieldGroup>
        </form>
      )}
    </AuthFrame>
  )
}

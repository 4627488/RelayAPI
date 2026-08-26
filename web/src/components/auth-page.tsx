import { useEffect, useState, type FormEvent } from "react"
import {
  ArrowRightIcon,
  KeyRoundIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
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

function BrandPanel() {
  return (
    <section className="hidden min-h-svh flex-col justify-between bg-primary p-10 text-primary-foreground lg:flex">
      <div className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary-foreground text-primary">
          <SparklesIcon className="size-5" />
        </div>
        <span className="text-lg font-semibold tracking-tight">RelayAPI</span>
      </div>
      <div className="flex max-w-lg flex-col gap-6">
        <p className="text-4xl leading-tight font-medium tracking-tight">
          一个入口，
          <br />
          连接所有模型。
        </p>
        <p className="max-w-md text-primary-foreground/70">
          安全地管理 API Key、额度和用量。模型路由与协议兼容由 Relay
          原生运行时提供。
        </p>
        <div className="flex gap-6 text-sm text-primary-foreground/70">
          <span className="flex items-center gap-2">
            <ShieldCheckIcon className="size-4" />
            租户隔离
          </span>
          <span className="flex items-center gap-2">
            <KeyRoundIcon className="size-4" />
            密钥自助
          </span>
        </div>
      </div>
      <p className="text-xs text-primary-foreground/50">
        Powered by RelayAPI Native Runtime
      </p>
    </section>
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
    <main className="grid min-h-svh lg:grid-cols-[1.05fr_1fr]">
      <BrandPanel />
      <section className="flex items-center justify-center p-6 sm:p-10">
        <div className="flex w-full max-w-md flex-col gap-6">
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">账户中心</p>
            <h1 className="text-3xl font-semibold tracking-tight">
              {mode === "register"
                ? setupRequired
                  ? "初始化 RelayAPI"
                  : "接受邀请"
                : "登录 RelayAPI"}
            </h1>
            <p className="text-sm text-muted-foreground">
              {mode === "register"
                ? setupRequired
                  ? "创建首个用户。该用户会同时获得管理员权限。"
                  : "完成资料后即可创建自己的 API Key。"
                : "访问你的模型、密钥和用量数据。"}
            </p>
          </div>

          {error ? (
            <Alert variant="destructive">
              <AlertTitle>无法继续</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {mode === "register" ? (
            <Card>
              <CardHeader>
                <CardTitle>创建账户</CardTitle>
                <CardDescription>
                  {setupRequired
                    ? "管理员是该普通用户的附加身份，提交后默认进入个人面板。"
                    : "邀请为单次使用，提交后会自动登录。"}
                </CardDescription>
              </CardHeader>
              <CardContent>
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
                      <Input
                        id="name"
                        name="name"
                        autoComplete="name"
                        required
                      />
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
                      {!pending ? (
                        <ArrowRightIcon data-icon="inline-end" />
                      ) : null}
                    </Button>
                  </FieldGroup>
                </form>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>账户登录</CardTitle>
                <CardDescription>
                  管理员也使用自己的普通用户邮箱和密码登录。
                </CardDescription>
              </CardHeader>
              <CardContent>
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
              </CardContent>
            </Card>
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
        </div>
      </section>
    </main>
  )
}

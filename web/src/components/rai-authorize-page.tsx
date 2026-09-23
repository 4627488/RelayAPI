import { useCallback, useEffect, useState, type FormEvent } from "react"
import { AuthFrame } from "@/components/auth-page"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { api, ApiError, postJSON, type Session } from "@/lib/api"
import { useAsyncResource } from "@/hooks/use-async-resource"

interface Authorization {
  id: string
  device_name: string
  device_os: string
  device_arch: string
  rai_version: string
  status: string
  expires_at: string
}

const systems: Record<string, string> = {
  windows: "Windows",
  darwin: "macOS",
  linux: "Linux",
}

export function RAIAuthorizePage({
  id,
  session,
  onAuthenticated,
}: {
  id: string
  session: Session | null
  onAuthenticated: (session: Session | null) => void
}) {
  const endpoint = `/api/rai/authorizations/${encodeURIComponent(id)}`
  const load = useCallback(async () => {
    try {
      return await api<Authorization>(endpoint)
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 410))
        return null
      throw err
    }
  }, [endpoint])
  const {
    data: request,
    loading,
    error: loadError,
    reload,
  } = useAsyncResource(load, {
    initialData: null,
    errorMessage: "无法读取授权请求",
  })
  const [result, setResult] = useState<Authorization | null>(null)
  const [pending, setPending] = useState("")
  const [error, setError] = useState("")
  const current = result ?? request
  const status = current?.status
  const finished = status === "approved" || status === "consumed"

  useEffect(() => {
    if (!current || status !== "pending") return
    const remaining = Date.parse(current.expires_at) - Date.now()
    const timer = window.setTimeout(
      () => setResult({ ...current, status: "expired" }),
      Math.max(0, remaining)
    )
    return () => window.clearTimeout(timer)
  }, [current, status])

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    const fields = new FormData(event.currentTarget)
    setPending("login")
    setError("")
    try {
      const value = await postJSON<Session>("/api/auth/login", {
        email: fields.get("email"),
        password: fields.get("password"),
      })
      onAuthenticated(value)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败，请重试")
    } finally {
      setPending("")
    }
  }

  async function decide(action: "approve" | "deny") {
    if (pending) return
    setPending(action)
    setError("")
    try {
      setResult(await postJSON<Authorization>(`${endpoint}/${action}`, {}))
    } catch (err) {
      setError(err instanceof Error ? err.message : "授权失败，请重试")
      if (err instanceof ApiError && err.status === 401) onAuthenticated(null)
      await reload()
    } finally {
      setPending("")
    }
  }

  const title = loading
    ? "读取授权请求"
    : loadError
      ? "暂时无法打开授权"
      : !current
        ? "授权链接无效"
        : finished
          ? "设备已获授权"
          : status === "denied"
            ? "已拒绝授权"
            : status === "expired"
              ? "授权已过期"
              : session
                ? "允许这台设备使用 rai？"
                : "登录以授权 rai"
  const description = loading
    ? "正在获取设备信息。"
    : loadError
      ? "请检查网络连接后重试。"
      : !current || status === "expired"
        ? "请回到终端重新运行 rai login，使用新的链接继续。"
        : finished
          ? "回到终端即可继续使用。你可以关闭此页面。"
          : status === "denied"
            ? "这次授权已取消，设备不会获得访问权限。"
            : "确认设备信息后，允许 rai 使用你的账户调用模型。"

  return (
    <AuthFrame
      title={title}
      description={description}
      footer={
        finished ? (
          <Button
            role="link"
            nativeButton={false}
            render={<a href="/app/rai-devices" />}
            className="w-full"
          >
            管理已登录设备
          </Button>
        ) : loadError ? (
          <Button
            variant="outline"
            className="w-full"
            onClick={() => void reload(true)}
          >
            重新加载
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-5">
        {loading ? (
          <div role="status" className="flex items-center gap-2">
            <Spinner />
            正在读取…
          </div>
        ) : null}
        {current && !loading ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">设备名称</dt>
            <dd className="min-w-0 break-words">
              {current.device_name || "未命名设备"}
            </dd>
            <dt className="text-muted-foreground">操作系统</dt>
            <dd>
              {systems[current.device_os] ?? (current.device_os || "未上报")}
              {current.device_arch ? ` / ${current.device_arch}` : ""}
            </dd>
            <dt className="text-muted-foreground">rai 版本</dt>
            <dd className="min-w-0 break-words">
              {current.rai_version || "未上报"}
            </dd>
          </dl>
        ) : null}
        {error ? (
          <Alert role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {status === "pending" && !loading && !loadError ? (
          <>
            {session ? (
              <>
                <p className="text-sm">
                  授权账户：
                  <span className="break-all">
                    {session.tenant.owner_email}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">
                  设备会使用你的模型权限和配额。之后可在「rai
                  已登录设备」中撤销登录。
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1"
                    disabled={!!pending}
                    onClick={() => void decide("deny")}
                  >
                    {pending === "deny" ? (
                      <Spinner data-icon="inline-start" />
                    ) : null}
                    拒绝
                  </Button>
                  <Button
                    className="flex-1"
                    disabled={!!pending}
                    onClick={() => void decide("approve")}
                  >
                    {pending === "approve" ? (
                      <Spinner data-icon="inline-start" />
                    ) : null}
                    批准授权
                  </Button>
                </div>
              </>
            ) : (
              <form onSubmit={login}>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="rai-email">邮箱</FieldLabel>
                    <Input
                      id="rai-email"
                      name="email"
                      type="email"
                      autoComplete="username"
                      required
                      disabled={!!pending}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="rai-password">密码</FieldLabel>
                    <Input
                      id="rai-password"
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      required
                      disabled={!!pending}
                    />
                  </Field>
                  <Button type="submit" disabled={!!pending}>
                    {pending ? <Spinner data-icon="inline-start" /> : null}
                    登录并继续
                  </Button>
                </FieldGroup>
              </form>
            )}
          </>
        ) : null}
      </div>
    </AuthFrame>
  )
}

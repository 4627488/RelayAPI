import { useCallback, useState, type FormEvent } from "react"
import { api, postJSON } from "@/lib/api"
import { githubResultMessage } from "@/lib/github-auth"
import { useAsyncResource } from "@/hooks/use-async-resource"
import { PageHeader } from "@/components/workspace-ui"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card"
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldGroup,
} from "@/components/ui/field"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { LoadingView } from "@/components/loading-view"
import { LoadErrorView } from "@/components/load-error-view"

type GitHubBinding = { enabled: boolean; bound: boolean; login: string }
export function AccountSettings() {
  const load = useCallback(() => api<GitHubBinding>("/api/account/github"), [])
  const { data, error, reload } = useAsyncResource(load, {
    initialData: null,
    errorMessage: "无法读取 GitHub 绑定",
  })
  const [password, setPassword] = useState("")
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState(() =>
    githubResultMessage(new URLSearchParams(location.search).get("github"))
  )
  const [failure, setFailure] = useState("")
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!data || pending) return
    setPending(true)
    setFailure("")
    setMessage("")
    try {
      if (data.bound) {
        await postJSON("/api/account/github/unbind", { password })
        setPassword("")
        setMessage(
          "已解绑 GitHub，其他登录会话已失效。你仍可使用邮箱和密码登录。"
        )
        await reload(true)
      } else {
        const result = await postJSON<{ url: string }>(
          "/api/account/github/bind",
          { password }
        )
        setPassword("")
        window.location.assign(result.url)
      }
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "操作失败")
    } finally {
      setPending(false)
    }
  }
  if (!data)
    return error ? (
      <LoadErrorView message={error} onRetry={() => void reload(true)} />
    ) : (
      <LoadingView />
    )
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="账户设置" description="管理登录方式与账户绑定。" />
      <Card>
        <CardHeader>
          <CardTitle>GitHub 登录</CardTitle>
          <CardDescription>
            {data.bound ? `已绑定 @${data.login}` : "尚未绑定 GitHub 账户"}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {message && (
            <Alert>
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          )}
          {(failure || error) && (
            <Alert variant="destructive">
              <AlertDescription>{failure || error}</AlertDescription>
            </Alert>
          )}
          {error && (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void reload(true)}
            >
              刷新绑定状态
            </Button>
          )}
          {!data.enabled && (
            <p className="text-sm text-muted-foreground">
              管理员尚未配置 GitHub 登录。
            </p>
          )}
          {(data.enabled || data.bound) && (
            <form onSubmit={submit} className="max-w-md">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="github-password">
                    当前账户密码
                  </FieldLabel>
                  <Input
                    id="github-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    disabled={pending}
                  />
                  <FieldDescription>
                    {data.bound
                      ? "解绑后改用邮箱和密码登录；其他登录会话将失效。"
                      : "验证本人身份后前往 GitHub 授权。每个 GitHub 账户只能绑定一个本站账户。"}
                  </FieldDescription>
                </Field>
                <Button
                  type="submit"
                  variant={data.bound ? "destructive" : "default"}
                  disabled={pending || !password}
                >
                  {pending && <Spinner />}
                  {data.bound ? "确认解绑 GitHub" : "绑定 GitHub"}
                </Button>
              </FieldGroup>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

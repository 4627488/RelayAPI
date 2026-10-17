import { useState, type FormEvent } from "react"
import { AuthFrame, AuthPage } from "@/components/auth-page"
import { RAIAuthorizePage } from "@/components/rai-authorize-page"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { postJSON, type Session } from "@/lib/api"

export function RAIDevicePage({
  session,
  onAuthenticated,
}: {
  session: Session | null
  onAuthenticated: (session: Session | null) => void
}) {
  const [id, setID] = useState("")
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    const fields = new FormData(event.currentTarget)
    setError("")
    setPending(true)
    try {
      const result = await postJSON<{ authorization_id: string }>(
        "/api/rai/device/resolve",
        {
          user_code: fields.get("user_code"),
        }
      )
      setID(result.authorization_id)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "验证码校验失败，请重试"
      )
    } finally {
      setPending(false)
    }
  }

  if (!session) return <AuthPage onAuthenticated={onAuthenticated} />
  if (id)
    return (
      <RAIAuthorizePage
        id={id}
        session={session}
        onAuthenticated={onAuthenticated}
      />
    )

  return (
    <AuthFrame
      title="登录服务器上的 rai"
      description="输入服务器终端显示的验证码，下一步核对设备并确认授权。"
      footer="仅输入你自己发起的登录请求中的验证码。"
    >
      <form onSubmit={submit}>
        <FieldGroup>
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor="device-code">设备验证码</FieldLabel>
            <Input
              id="device-code"
              name="user_code"
              placeholder="ABCD-EFGH"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={9}
              required
              aria-invalid={!!error}
              disabled={pending}
            />
          </Field>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={pending}>
            {pending && <Spinner data-icon="inline-start" />}继续
          </Button>
        </FieldGroup>
      </form>
    </AuthFrame>
  )
}

import { useEffect, useState } from "react"
import { AppShell } from "@astryxdesign/core/AppShell"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { Center } from "@astryxdesign/core/Center"
import { FormLayout } from "@astryxdesign/core/FormLayout"
import { Icon } from "@astryxdesign/core/Icon"
import { VStack } from "@astryxdesign/core/Layout"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useToast } from "@astryxdesign/core/Toast"
import { SendIcon } from "lucide-react"

import { api, postJSON, type AuthStatus, type Session } from "@/lib/api"

interface AuthPageProps {
  onAuthenticated: (session: Session) => void
}

export function AuthPage({ onAuthenticated }: AuthPageProps) {
  const toast = useToast()
  const token = new URLSearchParams(window.location.search).get("token")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [mode, setMode] = useState(token ? "register" : "login")
  const [setupRequired, setSetupRequired] = useState(false)
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [inviteToken, setInviteToken] = useState(token ?? "")

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
      toast({
        body: path.endsWith("register") ? "账户已创建" : "欢迎回来",
      })
      onAuthenticated(session)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "请求失败，请稍后重试")
    } finally {
      setPending(false)
    }
  }

  const register = mode === "register"
  const title = register
    ? setupRequired
      ? "初始化 RelayAPI"
      : "接受邀请"
    : "登录 RelayAPI"
  const subtitle = register
    ? setupRequired
      ? "创建首个用户。该用户会同时获得管理员权限。"
      : "完成资料后即可创建自己的 API Key。"
    : "访问你的模型、密钥和用量数据。"

  return (
    <AppShell height="fill" variant="wash">
      <Center minHeight="100%">
        <VStack gap={4} width={400}>
          <VStack gap={2} hAlign="center">
            <Icon icon={SendIcon} size="lg" />
            <Heading level={1}>RelayAPI</Heading>
            <Text color="secondary">模型网关控制台</Text>
          </VStack>
          <Card padding={6} width="100%" elevation="low">
            <VStack gap={4}>
              <VStack gap={1}>
                <Heading level={2}>{title}</Heading>
                <Text color="secondary">{subtitle}</Text>
              </VStack>
              {error ? (
                <Banner status="error" title="无法继续" description={error} />
              ) : null}
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  if (register) {
                    void submit("/api/auth/register", {
                      token: inviteToken,
                      name,
                      email,
                      password,
                    })
                    return
                  }
                  void submit("/api/auth/login", { email, password })
                }}
              >
                <FormLayout>
                  {register && !setupRequired ? (
                    <TextInput
                      label="邀请 Token"
                      value={inviteToken}
                      onChange={setInviteToken}
                      isRequired
                    />
                  ) : null}
                  {register ? (
                    <TextInput
                      label="显示名称"
                      value={name}
                      onChange={setName}
                      isRequired
                    />
                  ) : null}
                  <TextInput
                    label="邮箱"
                    type="email"
                    value={email}
                    onChange={setEmail}
                    isRequired
                  />
                  <TextInput
                    label="密码"
                    type="password"
                    value={password}
                    onChange={setPassword}
                    description={register ? "至少 8 个字符。" : undefined}
                    isRequired
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    label={register ? "创建账户" : "登录"}
                    isLoading={pending}
                    width="100%"
                  />
                </FormLayout>
              </form>
              <Button
                variant="ghost"
                width="100%"
                label={
                  register
                    ? "已有账户？返回登录"
                    : setupRequired
                      ? "首次使用？创建首个用户"
                      : "已有邀请？创建账户"
                }
                onClick={() => {
                  setError("")
                  setMode(register ? "login" : "register")
                }}
              />
            </VStack>
          </Card>
        </VStack>
      </Center>
    </AppShell>
  )
}

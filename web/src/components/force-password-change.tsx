import { useState } from "react"
import { AppShell } from "@astryxdesign/core/AppShell"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { Center } from "@astryxdesign/core/Center"
import { FormLayout } from "@astryxdesign/core/FormLayout"
import { HStack, VStack } from "@astryxdesign/core/Layout"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useToast } from "@astryxdesign/core/Toast"

import { postJSON } from "@/lib/api"

export function ForcePasswordChange({
  onChanged,
  onLogout,
}: {
  onChanged: () => Promise<void>
  onLogout: () => void
}) {
  const toast = useToast()
  const [pending, setPending] = useState(false)
  const [password, setPassword] = useState("")
  const [confirmation, setConfirmation] = useState("")

  return (
    <AppShell height="fill" variant="wash">
      <Center minHeight="100%">
        <Card padding={6} width={400} elevation="low">
          <VStack gap={4}>
            <VStack gap={1}>
              <Heading level={1}>设置新密码</Heading>
              <Text color="secondary">
                当前密码由管理员临时生成。设置新密码后才能继续使用账户。
              </Text>
            </VStack>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                if (password.length < 12) {
                  toast({ type: "error", body: "新密码至少 12 位" })
                  return
                }
                if (password !== confirmation) {
                  toast({ type: "error", body: "两次输入的密码不一致" })
                  return
                }
                setPending(true)
                void postJSON("/api/auth/password", { password })
                  .then(async () => {
                    await onChanged()
                    setPassword("")
                    setConfirmation("")
                    toast({ body: "密码已修改" })
                  })
                  .catch((cause) => {
                    toast({
                      type: "error",
                      body:
                        cause instanceof Error
                          ? cause.message
                          : "密码修改失败",
                    })
                  })
                  .finally(() => setPending(false))
              }}
            >
              <FormLayout>
                <TextInput
                  label="新密码"
                  type="password"
                  value={password}
                  onChange={setPassword}
                  description="至少 12 位。"
                  isRequired
                  hasAutoFocus
                />
                <TextInput
                  label="确认新密码"
                  type="password"
                  value={confirmation}
                  onChange={setConfirmation}
                  isRequired
                />
                <HStack hAlign="between" gap={2}>
                  <Button
                    label="退出登录"
                    variant="ghost"
                    isDisabled={pending}
                    onClick={onLogout}
                  />
                  <Button
                    type="submit"
                    label="保存新密码"
                    variant="primary"
                    isLoading={pending}
                  />
                </HStack>
              </FormLayout>
            </form>
          </VStack>
        </Card>
      </Center>
    </AppShell>
  )
}

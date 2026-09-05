import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Tick02Icon,
  ClipboardIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "@hugeicons/core-free-icons"
import { toast } from "@/components/ui/toast"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter } from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { copyText } from "@/lib/clipboard"

type Platform = "bash" | "powershell"

export function ConnectionGuide() {
  const [platform, setPlatform] = useState<Platform>("bash")
  const origin =
    typeof window === "undefined"
      ? ""
      : window.location.origin.replace(/\/$/, "")
  const command =
    platform === "powershell"
      ? `irm '${origin}/rai/install.ps1' | iex`
      : `curl -fsSL '${origin}/rai/install.sh' | bash`
  const scriptPath =
    platform === "powershell" ? "/rai/install.ps1" : "/rai/install.sh"
  const installDirectory =
    platform === "powershell" ? "%LOCALAPPDATA%\\rai" : "~/.local/bin"

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <Alert>
        <HugeiconsIcon strokeWidth={2} icon={TriangleAlertIcon} />
        <AlertDescription>
          本站没有对应平台的发布包时，安装器会改用本机 Go。
        </AlertDescription>
      </Alert>
      <Card>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel id="rai-platform-label">运行环境</FieldLabel>
              <ToggleGroup
                variant="outline"
                size="sm"
                spacing={1}
                value={[platform]}
                onValueChange={(next) =>
                  next[0] && setPlatform(next[0] as Platform)
                }
                className="w-full flex-wrap"
                aria-labelledby="rai-platform-label"
              >
                <ToggleGroupItem value="bash" className="min-w-24 flex-1">
                  {platform === "bash" ? (
                    <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} />
                  ) : null}
                  macOS / Linux / WSL
                </ToggleGroupItem>
                <ToggleGroupItem value="powershell" className="min-w-24 flex-1">
                  {platform === "powershell" ? (
                    <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} />
                  ) : null}
                  Windows
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>
            <Field>
              <FieldLabel htmlFor="rai-install-command">安装命令</FieldLabel>
              <InputGroup>
                <InputGroupAddon>
                  <HugeiconsIcon strokeWidth={2} icon={TerminalIcon} />
                </InputGroupAddon>
                <InputGroupInput
                  id="rai-install-command"
                  readOnly
                  value={command}
                  className="font-mono text-xs"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    variant="default"
                    size="sm"
                    aria-label="复制安装命令"
                    onClick={() => void copy(command)}
                  >
                    <HugeiconsIcon
                      strokeWidth={2}
                      icon={ClipboardIcon}
                      data-icon="inline-start"
                    />
                    复制
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter className="flex-wrap justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            默认安装到 <code>{installDirectory}</code>；新终端找不到 rai
            时，请将该目录加入用户 PATH。
          </p>
          <Button
            render={
              <a
                href={`${origin}${scriptPath}`}
                target="_blank"
                rel="noreferrer"
              />
            }
            nativeButton={false}
            variant="link"
            size="sm"
          >
            查看安装脚本
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}

async function copy(value: string) {
  try {
    await copyText(value)
    toast.add({ title: "安装命令已复制", type: "success" })
  } catch {
    toast.add({ title: "复制失败", type: "error" })
  }
}

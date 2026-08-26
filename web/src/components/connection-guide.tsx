import { useState } from "react"
import { CheckIcon, ClipboardIcon, TerminalIcon } from "lucide-react"
import { toast } from "sonner"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
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
    typeof window === "undefined" ? "" : window.location.origin.replace(/\/$/, "")
  const command =
    platform === "powershell"
      ? `irm '${origin}/rai/install.ps1' | iex`
      : `curl -fsSL '${origin}/rai/install.sh' | bash`

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>安装 rai</CardTitle>
          <CardDescription>
            一条命令安装启动器并打开浏览器登录。之后用 rai claude / rai
            codex / rai opencode 启动原来的客户端。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field>
            <FieldLabel>运行环境</FieldLabel>
            <ToggleGroup
              variant="outline"
              size="sm"
              spacing={1}
              value={[platform]}
              onValueChange={(next) =>
                next[0] && setPlatform(next[0] as Platform)
              }
              className="w-full flex-wrap"
            >
              <ToggleGroupItem value="bash" className="min-w-24 flex-1">
                {platform === "bash" ? <CheckIcon /> : null}
                macOS / Linux / WSL
              </ToggleGroupItem>
              <ToggleGroupItem value="powershell" className="min-w-24 flex-1">
                {platform === "powershell" ? <CheckIcon /> : null}
                Windows
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <Field>
            <FieldLabel>安装命令</FieldLabel>
            <FieldDescription>
              脚本从本站下发，装好后会对 {origin || "当前站点"} 执行 rai
              login。
            </FieldDescription>
            <InputGroup>
              <InputGroupAddon>
                <TerminalIcon />
              </InputGroupAddon>
              <InputGroupInput
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
                  <ClipboardIcon data-icon="inline-start" />
                  复制
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </Field>
        </CardContent>
      </Card>
    </div>
  )
}

async function copy(value: string) {
  try {
    await copyText(value)
    toast.success("安装命令已复制")
  } catch {
    toast.error("复制失败")
  }
}

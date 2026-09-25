import { useState } from "react"
import {
  CheckIcon,
  ClipboardIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { toast } from "@/components/ui/toast"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"
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
  const [platform, setPlatform] = useState<Platform>(() =>
    typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)
      ? "powershell"
      : "bash"
  )
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
        <TriangleAlertIcon />
        <AlertDescription>
          请先安装要使用的客户端，例如 Codex CLI。rai
          安装后会打开浏览器完成本站授权，无需复制 API Key。
        </AlertDescription>
      </Alert>
      <Card>
        <CardHeader>
          <CardTitle>安装并连接 rai</CardTitle>
          <CardDescription>
            在本机终端运行，安装包从本站下载。下载失败时请联系管理员检查发布包。
          </CardDescription>
        </CardHeader>
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
              <FieldLabel htmlFor="rai-install-command">安装命令</FieldLabel>
              <InputGroup>
                <InputGroupAddon>
                  <TerminalIcon />
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
                    <ClipboardIcon data-icon="inline-start" />
                    复制
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter className="flex-wrap justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            默认安装到 <code>{installDirectory}</code>。
            {platform === "powershell"
              ? "安装器会加入用户 PATH，安装后请打开新终端。"
              : "目录不在 PATH 时，安装器会打印配置命令，请按提示加入 shell 配置。"}
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
      <Card>
        <CardHeader>
          <CardTitle>开始使用</CardTitle>
          <CardDescription>
            Codex 默认沿用自身保存的模型和推理设置；也可以通过 rai 固定模型。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            {[
              ["启动 Codex", "rai codex"],
              ["查看本站可用模型", "rai models"],
              ["恢复客户端默认模型", "rai use default"],
              ["查看当前连接和默认模型", "rai status"],
              ["检查登录、PATH 和客户端安装", "rai doctor"],
            ].map(([label, value], index) => (
              <Field key={value}>
                <FieldLabel htmlFor={`rai-command-${index}`}>
                  {label}
                </FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id={`rai-command-${index}`}
                    readOnly
                    value={value}
                    className="font-mono text-xs"
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      aria-label={`复制${label}命令`}
                      onClick={() => void copy(value)}
                    >
                      复制
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </Field>
            ))}
          </FieldGroup>
        </CardContent>
        <CardFooter className="text-xs text-muted-foreground">
          使用 rai use 模型名保存默认值，或 rai codex --model
          模型名临时覆盖。旧配置选中了 code-review 时，可运行 rai use default
          重置。Codex 保存到用户配置的模型和推理变化会在退出后同步到当前 rai
          配置；其他设置由 Codex 自身保存。默认模型仍须在本站可用，可用 rai
          models 核对。
        </CardFooter>
      </Card>
    </div>
  )
}

async function copy(value: string) {
  try {
    await copyText(value)
    toast.add({ title: "命令已复制", type: "success" })
  } catch {
    toast.add({ title: "复制失败", type: "error" })
  }
}

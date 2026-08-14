import { useEffect, useMemo, useState } from "react"
import {
  CheckIcon,
  ChevronDownIcon,
  ClipboardIcon,
  Clock3Icon,
  KeyRoundIcon,
  Settings2Icon,
  TerminalIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { api, postJSON, type ApiKey, type ChildSubscription } from "@/lib/api"
import { copyText } from "@/lib/clipboard"
import { cn } from "@/lib/utils"

type Platform = "bash" | "powershell"
type ClientChoice = "all" | "codex" | "opencode"

interface SetupResponse {
  expires_at: string
  bash_command: string
  bash_check_command: string
  powershell_command: string
  powershell_check_command: string
}

export function ConnectionGuide({
  keys,
  tenantModels,
}: {
  keys: ApiKey[]
  tenantModels: string[]
}) {
  const usableKeys = useMemo(
    () => keys.filter((key) => key.enabled && key.recoverable),
    [keys]
  )
  const [subscriptionModels, setSubscriptionModels] = useState<string[]>([])
  const [modelsLoading, setModelsLoading] = useState(true)
  const [keyID, setKeyID] = useState(usableKeys[0]?.id ?? "")
  const [model, setModel] = useState("")
  const [client, setClient] = useState<ClientChoice>("all")
  const [platform, setPlatform] = useState<Platform>("bash")
  const [reasoningEffort, setReasoningEffort] = useState("high")
  const [openCodeProtocol, setOpenCodeProtocol] = useState("responses")
  const [installMissing, setInstallMissing] = useState(true)
  const [verifyConnection, setVerifyConnection] = useState(true)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [setup, setSetup] = useState<SetupResponse | null>(null)

  useEffect(() => {
    if (!usableKeys.some((key) => key.id === keyID)) {
      setKeyID(usableKeys[0]?.id ?? "")
    }
  }, [keyID, usableKeys])

  useEffect(() => {
    let active = true
    void api<{ items: ChildSubscription[] }>("/api/subscriptions")
      .then((value) => {
        if (!active) return
        const now = Date.now()
        setSubscriptionModels(
          Array.from(
            new Set(
              value.items
                .filter(
                  (item) =>
                    item.enabled &&
                    Date.parse(item.starts_at) <= now &&
                    (!item.expires_at || Date.parse(item.expires_at) > now)
                )
                .flatMap(
                  (item) =>
                    item.effective_model_allowlist ?? item.model_allowlist ?? []
                )
            )
          ).sort()
        )
      })
      .catch(() => {})
      .finally(() => {
        if (active) setModelsLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const selectedKey = usableKeys.find((key) => key.id === keyID)
  const models = useMemo(() => {
    const concrete = selectedKey?.model_allowlist?.length
      ? selectedKey.model_allowlist
      : [...tenantModels, ...subscriptionModels]
    const aliases = selectedKey?.model_aliases?.map((item) => item.alias) ?? []
    return Array.from(
      new Set(
        [...aliases, ...concrete].map((item) => item.trim()).filter(Boolean)
      )
    ).sort()
  }, [selectedKey, subscriptionModels, tenantModels])

  useEffect(() => {
    if (!models.includes(model)) {
      setModel(preferredModel(models))
    }
  }, [model, models])

  useEffect(() => {
    setSetup(null)
  }, [
    keyID,
    model,
    client,
    reasoningEffort,
    openCodeProtocol,
    installMissing,
    verifyConnection,
  ])

  async function generateSetup() {
    if (!keyID || !model) return
    setPending(true)
    try {
      const value = await postJSON<SetupResponse>("/api/agent-setup", {
        key_id: keyID,
        agents: client === "all" ? ["codex", "opencode"] : [client],
        model,
        reasoning_effort: reasoningEffort,
        opencode_protocol: openCodeProtocol,
        install_missing: installMissing,
        verify_connection: verifyConnection,
      })
      setSetup(value)
      toast.success("接入命令已生成")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "无法生成接入命令")
    } finally {
      setPending(false)
    }
  }

  const installCommand = setup
    ? platform === "bash"
      ? setup.bash_command
      : setup.powershell_command
    : ""
  const checkCommand = setup
    ? platform === "bash"
      ? setup.bash_check_command
      : setup.powershell_check_command
    : ""
  const includesCodex = client === "all" || client === "codex"
  const includesOpenCode = client === "all" || client === "opencode"

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">接入向导</h1>
        <p className="text-sm text-muted-foreground">
          选择客户端和模型，复制一条命令完成用户级配置。
        </p>
      </header>

      {!usableKeys.length ? (
        <Alert>
          <KeyRoundIcon />
          <AlertTitle>需要一个可恢复的 API Key</AlertTitle>
          <AlertDescription>
            请先在 API Keys 页面创建新密钥。旧密钥只有哈希，无法生成安装脚本。
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>配置客户端</CardTitle>
          <CardDescription>
            已有配置会先备份；脚本失败时自动恢复。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                label="API Key"
                value={keyID}
                placeholder="选择 API Key"
                onChange={setKeyID}
                options={usableKeys.map((key) => ({
                  value: key.id,
                  label: `${key.name} · ${key.prefix}…`,
                }))}
              />
              <SelectField
                label="默认模型"
                value={model}
                placeholder={modelsLoading ? "正在读取模型" : "选择模型"}
                onChange={setModel}
                options={models.map((item) => ({ value: item, label: item }))}
              />
            </div>

            <ChoiceField
              label="客户端"
              description="“全部”会同时配置 Codex 和 OpenCode。"
              value={client}
              onChange={(value) => setClient(value as ClientChoice)}
              options={[
                { value: "all", label: "全部" },
                { value: "codex", label: "Codex" },
                { value: "opencode", label: "OpenCode" },
              ]}
            />

            <ChoiceField
              label="运行环境"
              value={platform}
              onChange={(value) => setPlatform(value as Platform)}
              options={[
                { value: "bash", label: "macOS / Linux / WSL" },
                { value: "powershell", label: "Windows" },
              ]}
            />

            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleTrigger
                render={
                  <Button
                    variant="ghost"
                    className="w-full justify-start px-0"
                  />
                }
              >
                <Settings2Icon data-icon="inline-start" />
                高级设置
                <ChevronDownIcon
                  data-icon="inline-end"
                  className={cn(
                    "ml-auto transition-transform",
                    advancedOpen && "rotate-180"
                  )}
                />
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-4">
                <FieldGroup>
                  {includesCodex ? (
                    <ChoiceField
                      label="Codex 推理强度"
                      value={reasoningEffort}
                      onChange={setReasoningEffort}
                      options={[
                        { value: "minimal", label: "Minimal" },
                        { value: "low", label: "Low" },
                        { value: "medium", label: "Medium" },
                        { value: "high", label: "High" },
                        { value: "xhigh", label: "XHigh" },
                      ]}
                    />
                  ) : null}

                  {includesOpenCode ? (
                    <ChoiceField
                      label="OpenCode 协议"
                      description="Responses 适合 Codex/OAI；Chat 兼容传统 OpenAI 接口。"
                      value={openCodeProtocol}
                      onChange={setOpenCodeProtocol}
                      options={[
                        { value: "responses", label: "Responses" },
                        { value: "chat", label: "Chat Completions" },
                      ]}
                    />
                  ) : null}

                  <FieldSet>
                    <FieldLegend variant="label">安装行为</FieldLegend>
                    <FieldGroup className="gap-3">
                      <SwitchField
                        id="setup-install-missing"
                        label="安装缺失的客户端"
                        description="只在命令不存在时调用官方安装器。"
                        checked={installMissing}
                        onCheckedChange={setInstallMissing}
                      />
                      <SwitchField
                        id="setup-verify"
                        label="验证连接"
                        description="写入前后检查网关、密钥和模型。"
                        checked={verifyConnection}
                        onCheckedChange={setVerifyConnection}
                      />
                    </FieldGroup>
                  </FieldSet>

                </FieldGroup>
              </CollapsibleContent>
            </Collapsible>
          </FieldGroup>
        </CardContent>
        <CardFooter className="flex-col items-stretch gap-3 sm:flex-row sm:items-center">
          <p className="text-xs text-muted-foreground sm:mr-auto">
            {clientLabel(client)} ·{" "}
            {platform === "bash" ? "Bash" : "PowerShell"}
          </p>
          <Button
            className="w-full sm:w-auto"
            disabled={pending || !usableKeys.length || !model}
            onClick={() => void generateSetup()}
          >
            {pending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <TerminalIcon data-icon="inline-start" />
            )}
            生成接入命令
          </Button>
        </CardFooter>
      </Card>

      {setup ? (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <CardTitle>运行命令</CardTitle>
                <CardDescription>
                  先预检；确认无误后再执行安装。
                </CardDescription>
              </div>
              <Badge variant="outline">
                <Clock3Icon />
                {new Date(setup.expires_at).toLocaleTimeString()} 前有效
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <CommandField
                label="只读预检"
                description="检查网络、密钥和客户端，不修改文件。"
                command={checkCommand}
              />
              <CommandField
                label="安装并配置"
                description="合并现有配置，失败时恢复备份。"
                command={installCommand}
                primary
              />

              <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
                <CollapsibleTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start px-0"
                    />
                  }
                >
                  查看脚本写入内容
                  <ChevronDownIcon
                    data-icon="inline-end"
                    className={cn(
                      "ml-auto transition-transform",
                      detailsOpen && "rotate-180"
                    )}
                  />
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-3">
                  <div className="flex flex-col gap-3 text-sm">
                    {includesCodex ? (
                      <WriteTarget title="Codex" path="~/.codex/config.toml" />
                    ) : null}
                    {includesOpenCode ? (
                      <WriteTarget
                        title="OpenCode"
                        path="~/.config/opencode/opencode.json"
                      />
                    ) : null}
                    <WriteTarget
                      title="共享凭据"
                      path="~/.config/relayapi/api-key"
                    />
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </FieldGroup>
          </CardContent>
          <CardFooter className="text-xs text-muted-foreground">
            链接使用短时随机令牌，不包含 API Key；过期后需重新生成。
          </CardFooter>
        </Card>
      ) : null}
    </div>
  )
}

function preferredModel(models: string[]) {
  return (
    models.find((item) => item === "gpt-5.6-sol") ??
    models.find((item) => item.toLowerCase().includes("codex")) ??
    models[0] ??
    ""
  )
}

function SelectField({
  label,
  value,
  placeholder,
  onChange,
  options,
}: {
  label: string
  value: string
  placeholder?: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
}) {
  const items: Array<{ value: string | null; label: string }> = [
    { value: null, label: placeholder ?? "请选择" },
    ...options,
  ]
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Select
        items={items}
        value={value || null}
        onValueChange={(next) =>
          typeof next === "string" && next && onChange(next)
        }
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {items.map((option) => (
              <SelectItem
                key={option.value ?? "placeholder"}
                value={option.value}
                disabled={option.value === null}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  )
}

function ChoiceField({
  label,
  description,
  value,
  onChange,
  options,
}: {
  label: string
  description?: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <ToggleGroup
        variant="outline"
        size="sm"
        spacing={1}
        value={[value]}
        onValueChange={(next) => next[0] && onChange(next[0])}
        className="w-full flex-wrap"
      >
        {options.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            className="min-w-24 flex-1"
          >
            {value === option.value ? <CheckIcon /> : null}
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  )
}

function SwitchField({
  id,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  id: string
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </Field>
  )
}

function CommandField({
  label,
  description,
  command,
  primary = false,
}: {
  label: string
  description: string
  command: string
  primary?: boolean
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <FieldDescription>{description}</FieldDescription>
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
            variant={primary ? "default" : "ghost"}
            size={primary ? "sm" : "icon-xs"}
            aria-label={`复制${label}`}
            onClick={() => void copy(command, label)}
          >
            <ClipboardIcon data-icon={primary ? "inline-start" : undefined} />
            {primary ? "复制" : null}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </Field>
  )
}

function WriteTarget({ title, path }: { title: string; path: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-4">
      <span>{title}</span>
      <code className="truncate text-xs text-muted-foreground" title={path}>
        {path}
      </code>
    </div>
  )
}

function clientLabel(client: ClientChoice) {
  if (client === "all") return "两个客户端"
  if (client === "opencode") return "OpenCode"
  return "Codex"
}

async function copy(value: string, label: string) {
  try {
    await copyText(value)
    toast.success(`${label}已复制`)
  } catch {
    toast.error("复制失败")
  }
}

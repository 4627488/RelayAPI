import { useEffect, useMemo, useState } from "react"
import {
  CheckCircle2Icon,
  ClipboardIcon,
  Clock3Icon,
  KeyRoundIcon,
  LaptopIcon,
  PlayIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
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
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { api, postJSON, type ApiKey, type ChildSubscription } from "@/lib/api"
import { copyText } from "@/lib/clipboard"

type Platform = "bash" | "powershell"
type ClientChoice = "all" | "codex" | "claude" | "opencode"

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
  const [installMissing, setInstallMissing] = useState("yes")
  const [verifyConnection, setVerifyConnection] = useState("yes")
  const [gatewayDiscovery, setGatewayDiscovery] = useState("yes")
  const [disableExtraTraffic, setDisableExtraTraffic] = useState("no")
  const [pending, setPending] = useState(false)
  const [setup, setSetup] = useState<SetupResponse | null>(null)

  useEffect(() => {
    if (!usableKeys.some((key) => key.id === keyID)) {
      setKeyID(usableKeys[0]?.id ?? "")
      setSetup(null)
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
    const inherited = subscriptionModels.length
      ? subscriptionModels
      : tenantModels
    const concrete = selectedKey?.model_allowlist?.length
      ? selectedKey.model_allowlist
      : inherited
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
      setSetup(null)
    }
  }, [model, models])

  useEffect(() => {
    setSetup(null)
  }, [
    reasoningEffort,
    openCodeProtocol,
    installMissing,
    verifyConnection,
    gatewayDiscovery,
    disableExtraTraffic,
  ])

  async function generateSetup() {
    if (!keyID || !model) return
    setPending(true)
    try {
      const value = await postJSON<SetupResponse>("/api/agent-setup", {
        key_id: keyID,
        agents: client === "all" ? ["codex", "claude", "opencode"] : [client],
        model,
        reasoning_effort: reasoningEffort,
        opencode_protocol: openCodeProtocol,
        install_missing: installMissing === "yes",
        verify_connection: verifyConnection === "yes",
        claude_gateway_discovery: gatewayDiscovery === "yes",
        claude_disable_extra_traffic: disableExtraTraffic === "yes",
      })
      setSetup(value)
      toast.success("安装脚本已生成，有效期 5 分钟")
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "无法生成安装脚本")
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">接入向导</h1>
        <p className="text-sm text-muted-foreground">
          生成一个可重复执行、失败自动回滚的安装脚本，配置 Codex、Claude Code 和
          OpenCode。
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <FeatureCard
          icon={ShieldCheckIcon}
          title="短时授权"
          description="命令只包含 5 分钟有效的加密令牌，不把 API Key 放进剪贴板或终端历史。"
        />
        <FeatureCard
          icon={RefreshCwIcon}
          title="合并与回滚"
          description="保留原配置，原子写入并在失败时恢复；重复运行只更新 RelayAPI 对应项。"
        />
        <FeatureCard
          icon={CheckCircle2Icon}
          title="先验证再落盘"
          description="先检查 /v1/models、密钥和客户端版本，再写受限权限的共享凭据文件。"
        />
      </div>

      {!usableKeys.length ? (
        <Alert variant="destructive">
          <KeyRoundIcon />
          <AlertTitle>没有可用于脚本的 API Key</AlertTitle>
          <AlertDescription>
            请先到“API Keys”创建一个新密钥。升级前创建的旧 Key
            只有哈希，无法恢复明文或生成安装脚本。
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>1. 选择接入目标</CardTitle>
          <CardDescription>
            脚本在当前用户范围写配置，不需要管理员权限；已有配置会先备份。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <div className="grid gap-4 md:grid-cols-2">
              <SelectField
                label="API Key"
                description="仅列出启用且可恢复的 Key。"
                value={keyID}
                placeholder="选择 API Key"
                onChange={(value) => {
                  setKeyID(value)
                  setSetup(null)
                }}
                options={usableKeys.map((key) => ({
                  value: key.id,
                  label: `${key.name} · ${key.prefix}…`,
                }))}
              />
              <SelectField
                label="默认模型"
                description="包含当前 Key 的模型别名。"
                value={model}
                placeholder={modelsLoading ? "正在读取模型" : "选择模型"}
                onChange={(value) => {
                  setModel(value)
                  setSetup(null)
                }}
                options={models.map((item) => ({ value: item, label: item }))}
              />
              <SelectField
                label="客户端"
                description="可一次配置三个客户端，也可只配置其中一个。"
                value={client}
                onChange={(value) => {
                  setClient(value as ClientChoice)
                  setSetup(null)
                }}
                options={[
                  {
                    value: "all",
                    label: "全部：Codex + Claude Code + OpenCode",
                  },
                  { value: "codex", label: "Codex" },
                  { value: "claude", label: "Claude Code" },
                  { value: "opencode", label: "OpenCode" },
                ]}
              />
              <SelectField
                label="运行环境"
                description="WSL 应选择 macOS / Linux / WSL。"
                value={platform}
                onChange={(value) => {
                  setPlatform(value as Platform)
                  setSetup(null)
                }}
                options={[
                  { value: "bash", label: "macOS / Linux / WSL（Bash）" },
                  { value: "powershell", label: "Windows（PowerShell）" },
                ]}
              />
            </div>

            <Field>
              <FieldLabel>高级设置</FieldLabel>
              <div className="grid gap-4 rounded-lg border p-4 md:grid-cols-2 xl:grid-cols-3">
                <CompactSelect
                  label="Codex 推理强度"
                  value={reasoningEffort}
                  onChange={setReasoningEffort}
                  options={["minimal", "low", "medium", "high", "xhigh"]}
                />
                <CompactSelect
                  label="OpenCode 协议"
                  value={openCodeProtocol}
                  onChange={setOpenCodeProtocol}
                  options={["responses", "chat"]}
                />
                <YesNoSelect
                  label="自动安装缺失客户端"
                  value={installMissing}
                  onChange={setInstallMissing}
                />
                <YesNoSelect
                  label="写入前后验证连接"
                  value={verifyConnection}
                  onChange={setVerifyConnection}
                />
                <YesNoSelect
                  label="Claude 网关模型发现"
                  value={gatewayDiscovery}
                  onChange={setGatewayDiscovery}
                />
                <YesNoSelect
                  label="Claude 禁用非必要外联"
                  value={disableExtraTraffic}
                  onChange={setDisableExtraTraffic}
                />
              </div>
              <FieldDescription>
                Responses 适合 Codex/OAI 模型；Chat 兼容更多传统
                OpenAI-compatible 模型。关闭 Claude
                非必要外联也会关闭自动更新和网关模型发现。
              </FieldDescription>
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter>
          <Button
            disabled={pending || !usableKeys.length || !model}
            onClick={() => void generateSetup()}
          >
            {pending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <TerminalIcon data-icon="inline-start" />
            )}
            生成一键脚本
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. 检查并安装</CardTitle>
          <CardDescription>
            建议先运行只读预检，再运行安装命令。脚本过期后重新生成即可。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {setup ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">
                  <Clock3Icon />
                  {new Date(setup.expires_at).toLocaleTimeString()} 前有效
                </Badge>
                <Badge variant="outline">
                  {platform === "bash" ? "Bash" : "PowerShell"}
                </Badge>
                <Badge variant="outline">{clientLabel(client)}</Badge>
              </div>
              <CommandBlock
                title="只读预检"
                description="验证网关、Key 与客户端安装状态，不修改任何文件。"
                command={checkCommand}
              />
              <CommandBlock
                title="执行接入"
                description="必要时安装客户端，然后合并配置；任何写入失败都会回滚本次修改。"
                command={installCommand}
              />
              <Alert>
                <ShieldCheckIcon />
                <AlertTitle>脚本如何保存密钥</AlertTitle>
                <AlertDescription>
                  三个客户端共用 <code>~/.config/relayapi/api-key</code>。Codex
                  和 Claude Code 通过凭据命令读取，OpenCode 通过 file
                  变量读取；脚本不会修改 Codex 的 auth.json。
                </AlertDescription>
              </Alert>
            </>
          ) : (
            <div className="flex flex-col gap-3 rounded-lg border p-6 text-center">
              <LaptopIcon className="mx-auto size-8 text-muted-foreground" />
              <p className="font-medium">等待生成脚本</p>
              <p className="text-sm text-muted-foreground">
                选好 Key、模型和运行环境后，点击“生成一键脚本”。
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>脚本写入内容</CardTitle>
          <CardDescription>
            所有配置均为用户级，并保留时间戳备份。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm md:grid-cols-3">
          <WriteTarget
            title="Codex"
            path="~/.codex/config.toml"
            detail="Responses、WebSocket、模型、推理强度与 provider-scoped auth；通过 app-server 原子更新。"
          />
          <WriteTarget
            title="Claude Code"
            path="~/.claude/settings.json"
            detail="Anthropic Base URL、apiKeyHelper、默认模型及可选网关模型发现。"
          />
          <WriteTarget
            title="OpenCode"
            path="~/.config/opencode/opencode.json"
            detail="独立 relayapi provider、默认模型、Responses 或 Chat 协议，不覆盖其他 provider。"
          />
        </CardContent>
      </Card>

      <Alert>
        <PlayIcon />
        <AlertTitle>接入后验证</AlertTitle>
        <AlertDescription>
          运行 <code>codex --version</code>、<code>claude --version</code> 或{" "}
          <code>opencode --version</code>
          ，再启动对应客户端。若模型不可用，请回到这里选择当前 Key
          能访问的模型重新生成。
        </AlertDescription>
      </Alert>
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

function FeatureCard({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof ShieldCheckIcon
  title: string
  description: string
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <Icon className="size-5 text-muted-foreground" />
          <CardTitle>{title}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="text-sm leading-6 text-muted-foreground">
        {description}
      </CardContent>
    </Card>
  )
}

function SelectField({
  label,
  description,
  value,
  placeholder,
  onChange,
  options,
}: {
  label: string
  description: string
  value: string
  placeholder?: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Select value={value} onValueChange={(next) => next && onChange(next)}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <FieldDescription>{description}</FieldDescription>
    </Field>
  )
}

function CompactSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: string[]
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Select value={value} onValueChange={(next) => next && onChange(next)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  )
}

function YesNoSelect({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Select value={value} onValueChange={(next) => next && onChange(next)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="yes">启用</SelectItem>
            <SelectItem value="no">关闭</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  )
}

function CommandBlock({
  title,
  description,
  command,
}: {
  title: string
  description: string
  command: string
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`复制${title}`}
          onClick={() => void copy(command, title)}
        >
          <ClipboardIcon />
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs leading-5">
        <code>{command}</code>
      </pre>
    </div>
  )
}

function WriteTarget({
  title,
  path,
  detail,
}: {
  title: string
  path: string
  detail: string
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4">
      <p className="font-medium">{title}</p>
      <code className="text-xs">{path}</code>
      <p className="leading-6 text-muted-foreground">{detail}</p>
    </div>
  )
}

function clientLabel(client: ClientChoice) {
  if (client === "all") return "三个客户端"
  if (client === "claude") return "Claude Code"
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

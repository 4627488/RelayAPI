import { useEffect, useMemo, useState } from "react"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Code } from "@astryxdesign/core/Code"
import { CodeBlock } from "@astryxdesign/core/CodeBlock"
import { Collapsible } from "@astryxdesign/core/Collapsible"
import { FormLayout } from "@astryxdesign/core/FormLayout"
import { HStack, VStack } from "@astryxdesign/core/Layout"
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl"
import { Selector } from "@astryxdesign/core/Selector"
import { Switch } from "@astryxdesign/core/Switch"
import { Text } from "@astryxdesign/core/Text"
import { useToast } from "@astryxdesign/core/Toast"
import { KeyRoundIcon, TerminalIcon } from "lucide-react"

import { CopyField, PageHeader, SectionCard } from "@/components/page-kit"
import { api, postJSON, type ApiKey, type ChildSubscription } from "@/lib/api"

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
  const toast = useToast()
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
      toast({ body: "接入命令已生成" })
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "无法生成接入命令",
      })
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
    <VStack gap={4}>
      <PageHeader title="接入指南" />
      {!usableKeys.length ? (
        <Banner
          status="warning"
          title="需要一个可恢复的 API Key"
          description="请先在 API Keys 页面创建新密钥。旧密钥只有哈希，无法生成安装脚本。"
          icon={<KeyRoundIcon />}
        />
      ) : null}

      <SectionCard
        title="配置客户端"
        description="已有配置会先备份；脚本失败时自动恢复。"
        actions={
          <Button
            label="生成接入命令"
            variant="primary"
            icon={<TerminalIcon />}
            isLoading={pending}
            isDisabled={!usableKeys.length || !model}
            onClick={() => void generateSetup()}
          />
        }
      >
        <FormLayout>
          <FormLayout direction="horizontal">
            <Selector
              label="API Key"
              value={keyID}
              onChange={setKeyID}
              placeholder="选择 API Key"
              options={usableKeys.map((key) => ({
                value: key.id,
                label: `${key.name} · ${key.prefix}…`,
              }))}
            />
            <Selector
              label="默认模型"
              value={model}
              onChange={setModel}
              isLoading={modelsLoading}
              placeholder={modelsLoading ? "正在读取模型" : "选择模型"}
              hasSearch
              options={models.map((item) => ({ value: item, label: item }))}
            />
          </FormLayout>
          <SegmentedControl
            label="客户端"
            value={client}
            onChange={(value) => setClient(value as ClientChoice)}
          >
            <SegmentedControlItem value="all" label="全部" />
            <SegmentedControlItem value="codex" label="Codex" />
            <SegmentedControlItem value="opencode" label="OpenCode" />
          </SegmentedControl>
          <Text color="secondary" type="supporting">
            “全部”会同时配置 Codex 和 OpenCode。
          </Text>
          <SegmentedControl
            label="运行环境"
            value={platform}
            onChange={(value) => setPlatform(value as Platform)}
          >
            <SegmentedControlItem value="bash" label="macOS / Linux / WSL" />
            <SegmentedControlItem value="powershell" label="Windows" />
          </SegmentedControl>
          <Collapsible trigger="高级设置" defaultIsOpen={false}>
            <FormLayout>
              {includesCodex ? (
                <SegmentedControl
                  label="Codex 推理强度"
                  value={reasoningEffort}
                  onChange={setReasoningEffort}
                >
                  <SegmentedControlItem value="minimal" label="Minimal" />
                  <SegmentedControlItem value="low" label="Low" />
                  <SegmentedControlItem value="medium" label="Medium" />
                  <SegmentedControlItem value="high" label="High" />
                  <SegmentedControlItem value="xhigh" label="XHigh" />
                </SegmentedControl>
              ) : null}
              {includesOpenCode ? (
                <VStack gap={2}>
                  <SegmentedControl
                    label="OpenCode 协议"
                    value={openCodeProtocol}
                    onChange={setOpenCodeProtocol}
                  >
                    <SegmentedControlItem value="responses" label="Responses" />
                    <SegmentedControlItem value="chat" label="Chat Completions" />
                  </SegmentedControl>
                  <Text color="secondary" type="supporting">
                    Responses 适合 Codex/OAI；Chat 兼容传统 OpenAI 接口。
                  </Text>
                </VStack>
              ) : null}
              <Switch
                label="安装缺失的客户端"
                description="只在命令不存在时调用官方安装器。"
                value={installMissing}
                onChange={setInstallMissing}
              />
              <Switch
                label="验证连接"
                description="写入前后检查网关、密钥和模型。"
                value={verifyConnection}
                onChange={setVerifyConnection}
              />
            </FormLayout>
          </Collapsible>
          <Text color="secondary" type="supporting">
            {clientLabel(client)} · {platform === "bash" ? "Bash" : "PowerShell"}
          </Text>
        </FormLayout>
      </SectionCard>

      {usableKeys.length && model ? (
        <ManualConfigCard
          endpoint={`${
            typeof window === "undefined" ? "" : window.location.origin
          }/v1`}
          model={model}
          platform={platform}
          includesCodex={includesCodex}
          includesOpenCode={includesOpenCode}
          reasoningEffort={reasoningEffort}
          openCodeProtocol={openCodeProtocol}
        />
      ) : null}

      {setup ? (
        <SectionCard
          title="运行命令"
          description="先预检；确认无误后再执行安装。"
          actions={
            <Text color="secondary" type="supporting">
              {new Date(setup.expires_at).toLocaleTimeString()} 前有效
            </Text>
          }
        >
          <VStack gap={4}>
            <CodeBlock
              title="只读预检"
              language="bash"
              code={checkCommand}
              width="100%"
              hasLanguageLabel={false}
            />
            <CodeBlock
              title="安装并配置"
              language="bash"
              code={installCommand}
              width="100%"
              hasLanguageLabel={false}
            />
            <Collapsible trigger="查看脚本写入内容" defaultIsOpen={false}>
              <VStack gap={2}>
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
              </VStack>
            </Collapsible>
            <Text color="secondary" type="supporting">
              链接使用短时随机令牌，不包含 API Key；过期后需重新生成。
            </Text>
          </VStack>
        </SectionCard>
      ) : null}
    </VStack>
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

function ManualConfigCard({
  endpoint,
  model,
  platform,
  includesCodex,
  includesOpenCode,
  reasoningEffort,
  openCodeProtocol,
}: {
  endpoint: string
  model: string
  platform: Platform
  includesCodex: boolean
  includesOpenCode: boolean
  reasoningEffort: string
  openCodeProtocol: string
}) {
  const keyPath =
    platform === "powershell"
      ? "$HOME\\.config\\relayapi\\api-key"
      : "~/.config/relayapi/api-key"
  const codexPath =
    platform === "powershell"
      ? "$HOME\\.codex\\config.toml"
      : "~/.codex/config.toml"
  const openCodePath =
    platform === "powershell"
      ? "$HOME\\.config\\opencode\\opencode.json"
      : "~/.config/opencode/opencode.json"
  const npmPackage =
    openCodeProtocol === "chat" ? "@ai-sdk/openai-compatible" : "@ai-sdk/openai"
  const codexAuth =
    platform === "powershell"
      ? `command = "powershell"
args = ["-NoProfile", "-Command", "$p=Join-Path $HOME '.config\\relayapi\\api-key'; [IO.File]::ReadAllText($p)"]`
      : `command = "sh"
args = ["-c", "cat \\"$HOME/.config/relayapi/api-key\\""]`
  const codexConfig = `model_provider = "relayapi"
model = "${model}"
model_reasoning_effort = "${reasoningEffort}"

[model_providers.relayapi]
name = "RelayAPI"
base_url = "${endpoint}"
wire_api = "responses"
supports_websockets = true
supports_standalone_web_search = true

[model_providers.relayapi.auth]
${codexAuth}`
  const openCodeConfig = JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      model: `relayapi/${model}`,
      provider: {
        relayapi: {
          npm: npmPackage,
          name: "RelayAPI",
          options: {
            baseURL: endpoint,
            apiKey: "{file:~/.config/relayapi/api-key}",
          },
          models: { [model]: { name: model } },
        },
      },
    },
    null,
    2
  )

  return (
    <SectionCard
      title="手动配置"
      description="把 API Key 写入密钥文件，再把对应配置合并进客户端。"
    >
      <VStack gap={4}>
        <CopyField id="guide-endpoint" label="接口地址" value={endpoint} />
        <CopyField id="guide-key-path" label="密钥文件" value={keyPath} />
        {includesCodex ? (
          <CodeBlock
            title={`Codex · ${codexPath}`}
            language="toml"
            code={codexConfig}
            width="100%"
          />
        ) : null}
        {includesOpenCode ? (
          <CodeBlock
            title={`OpenCode · ${openCodePath}`}
            language="json"
            code={openCodeConfig}
            width="100%"
          />
        ) : null}
      </VStack>
    </SectionCard>
  )
}

function WriteTarget({ title, path }: { title: string; path: string }) {
  return (
    <HStack hAlign="between" gap={3} vAlign="center">
      <Text>{title}</Text>
      <Code>{path}</Code>
    </HStack>
  )
}

function clientLabel(client: ClientChoice) {
  if (client === "all") return "两个客户端"
  if (client === "opencode") return "OpenCode"
  return "Codex"
}

import { useCallback, useEffect, useState, type FormEvent } from "react"
import { Banner } from "@cloudflare/kumo/components/banner"
import { Button } from "@cloudflare/kumo/components/button"
import { ClipboardText } from "@cloudflare/kumo/components/clipboard-text"
import { Field } from "@cloudflare/kumo/components/field"
import { Input } from "@cloudflare/kumo/components/input"
import { Select } from "@cloudflare/kumo/components/select"
import { Tabs } from "@cloudflare/kumo/components/tabs"
import { useAsyncResource } from "@/hooks/use-async-resource"
import { api, postJSON, type AgentSetupCommands, type ApiKey } from "@/lib/api"
import { errorMessage, toast } from "@/lib/toast"
import { ErrorState, LoadingState, Page, Surface } from "@/console/kit"

export function GuidePage() {
  const load = useCallback(async () => {
    const value = await api<{ items: ApiKey[] }>("/api/keys")
    return value.items ?? []
  }, [])
  const {
    data: keys,
    loading,
    error,
    reload,
  } = useAsyncResource(load, {
    initialData: [],
    errorMessage: "无法读取密钥",
    onBackgroundError: (message) => toast.error(message),
  })
  const [platform, setPlatform] = useState("bash")
  const [keyId, setKeyId] = useState("")
  const [agent, setAgent] = useState("codex")
  const [pending, setPending] = useState(false)
  const [setup, setSetup] = useState<AgentSetupCommands | null>(null)
  useEffect(() => {
    if (!keyId && keys[0]) setKeyId(keys[0].id)
  }, [keyId, keys])
  const origin = window.location.origin.replace(/\/$/, "")
  const install =
    platform === "powershell"
      ? `irm '${origin}/rai/install.ps1' | iex`
      : `curl -fsSL '${origin}/rai/install.sh' | bash`

  async function createSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setPending(true)
    try {
      const result = await postJSON<AgentSetupCommands>("/api/agent-setup", {
        key_id: keyId,
        agents: [agent],
        model: String(data.get("model") ?? ""),
        reasoning_effort: "medium",
        opencode_protocol: "responses",
        install_missing: true,
        verify_connection: true,
      })
      setSetup(result)
      toast.success("安装命令已生成，5 分钟内有效")
    } catch (cause) {
      toast.error(errorMessage(cause, "无法生成安装脚本"))
    } finally {
      setPending(false)
    }
  }

  if (loading) return <LoadingState />
  if (error && keys.length === 0) {
    return <ErrorState message={error} onRetry={() => void reload(true)} />
  }

  return (
    <Page title="接入指南" description="把 RelayAPI 接到常用客户端。">
      <Banner
        variant="secondary"
        size="sm"
        title="本站安装包"
        description="没有对应平台的发布包时，安装器会改用本机 Go。"
      />
      <Surface title="安装 rai">
        <Tabs
          variant="segmented"
          size="sm"
          value={platform}
          onValueChange={setPlatform}
          tabs={[
            { value: "bash", label: "macOS / Linux / WSL" },
            { value: "powershell", label: "Windows" },
          ]}
        />
        <div className="mt-3">
          <ClipboardText text={install} />
        </div>
      </Surface>
      <Surface title="一键写入客户端">
        <form className="flex flex-col gap-4" onSubmit={createSetup}>
          <Select
            label="API Key"
            required
            value={keyId || undefined}
            onValueChange={(value) => setKeyId(value ?? "")}
            items={Object.fromEntries(keys.map((key) => [key.id, key.name]))}
          />
          <Select
            label="客户端"
            value={agent}
            onValueChange={(value) => setAgent(value ?? "codex")}
            items={{ codex: "Codex", opencode: "OpenCode" }}
          />
          <Field label="默认模型">
            <Input name="model" required placeholder="例如 gpt-5" />
          </Field>
          <Button
            type="submit"
            variant="primary"
            loading={pending}
            disabled={keys.length === 0}
          >
            生成 5 分钟命令
          </Button>
        </form>
        {setup ? (
          <div className="mt-4 flex flex-col gap-2">
            <ClipboardText
              text={
                platform === "powershell"
                  ? setup.powershell_command
                  : setup.bash_command
              }
            />
          </div>
        ) : null}
      </Surface>
    </Page>
  )
}

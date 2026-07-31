import { useMemo, type ReactNode } from "react"
import { BookOpenIcon, CheckIcon, ClipboardIcon, CodeXmlIcon, KeyRoundIcon, MonitorCogIcon, TerminalIcon } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { copyText } from "@/lib/clipboard"

type CodeSampleProps = {
  code: string
  label: string
}

export function ConnectionGuide() {
  const origin = window.location.origin
  const openAIBase = `${origin}/v1`
  const samples = useMemo(() => guideSamples(origin), [origin])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">接入指南</h1>
        <p className="text-sm text-muted-foreground">使用本站 API Key 接入支持 OpenAI、Anthropic 或 Gemini 自定义地址的客户端。</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <GuideStep icon={KeyRoundIcon} number="1" title="创建 API Key">在“API Keys”页面创建密钥。完整密钥只在创建后显示。</GuideStep>
        <GuideStep icon={MonitorCogIcon} number="2" title="填写服务地址">OpenAI-compatible 客户端使用 <code>{openAIBase}</code>。Claude Code 和 Gemini 原生协议使用 <code>{origin}</code>。</GuideStep>
        <GuideStep icon={CheckIcon} number="3" title="验证模型">先请求 <code>GET /v1/models</code>，再从返回结果中复制模型名称。</GuideStep>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>连接参数</CardTitle>
          <CardDescription>客户端名称不同，填写的值相同。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <ConnectionValue label="OpenAI Base URL" value={openAIBase} />
          <ConnectionValue label="Anthropic Base URL" value={origin} />
          <ConnectionValue label="Gemini Base URL" value={origin} />
          <ConnectionValue label="API Key" value="relay_…" secret />
        </CardContent>
      </Card>

      <Alert>
        <BookOpenIcon />
        <AlertTitle>模型名称必须来自本站</AlertTitle>
        <AlertDescription>客户端内置的模型列表可能与本站不同。调用前用下方命令读取当前可用模型。</AlertDescription>
      </Alert>

      <Tabs defaultValue="quick" className="gap-4">
        <TabsList className="grid h-auto w-full grid-cols-2 gap-1 p-1 lg:w-fit lg:grid-cols-4">
          <TabsTrigger value="quick"><TerminalIcon />快速验证</TabsTrigger>
          <TabsTrigger value="cli"><CodeXmlIcon />编程 CLI</TabsTrigger>
          <TabsTrigger value="sdk"><BookOpenIcon />SDK 与 REST</TabsTrigger>
          <TabsTrigger value="gui"><MonitorCogIcon />桌面与 IDE</TabsTrigger>
        </TabsList>

        <TabsContent value="quick" className="grid gap-4 xl:grid-cols-2">
          <SampleCard title="读取模型" description="成功时返回 data 数组。401 表示 Key 不正确或已停用。">
            <CodeSample label="复制 curl 命令" code={samples.models} />
          </SampleCard>
          <SampleCard title="发送一条消息" description="把模型名称替换为 /v1/models 返回的值。">
            <CodeSample label="复制 curl 命令" code={samples.chat} />
          </SampleCard>
        </TabsContent>

        <TabsContent value="cli" className="grid gap-4 xl:grid-cols-2">
          <SampleCard title="Codex CLI" description="配置写入用户级 ~/.codex/config.toml。provider 配置不会从项目级 .codex/config.toml 读取。">
            <CodeSample label="复制 config.toml" code={samples.codex} />
            <CodeSample label="复制环境变量" code={samples.relayEnv} />
          </SampleCard>
          <SampleCard title="Claude Code" description="Base URL 不带 /v1。模型名称使用本站模型列表中的值。">
            <CodeSample label="复制环境变量" code={samples.claudeCode} />
          </SampleCard>
          <SampleCard title="OpenCode" description="Responses 模型使用 @ai-sdk/openai；只支持 Chat Completions 的模型可改用 @ai-sdk/openai-compatible。">
            <CodeSample label="复制 opencode.json" code={samples.opencode} />
          </SampleCard>
          <SampleCard title="Aider" description="Aider 通过 OpenAI-compatible 地址调用。模型名称需要带 openai/ 前缀。">
            <CodeSample label="复制启动命令" code={samples.aider} />
          </SampleCard>
        </TabsContent>

        <TabsContent value="sdk" className="grid gap-4 xl:grid-cols-2">
          <SampleCard title="OpenAI Python" description="适合 Responses API、工具调用和流式输出。">
            <CodeSample label="复制 Python 示例" code={samples.python} />
          </SampleCard>
          <SampleCard title="OpenAI Node.js" description="baseURL 必须包含 /v1。">
            <CodeSample label="复制 Node.js 示例" code={samples.node} />
          </SampleCard>
          <SampleCard title="Anthropic 原生协议" description="本站接受 x-api-key，并提供 /v1/messages。">
            <CodeSample label="复制 Anthropic 请求" code={samples.anthropic} />
          </SampleCard>
          <SampleCard title="Gemini 原生协议" description="本站接受 x-goog-api-key，并提供 /v1beta 路径。">
            <CodeSample label="复制 Gemini 请求" code={samples.gemini} />
          </SampleCard>
        </TabsContent>

        <TabsContent value="gui" className="grid gap-4 xl:grid-cols-2">
          <ClientGroup title="聊天客户端" clients={["Cherry Studio", "Chatbox", "LobeChat", "NextChat"]}>
            选择“OpenAI”或“OpenAI-compatible”，填写 OpenAI Base URL 和 API Key。关闭客户端自带的模型过滤后，从本站模型列表添加模型。
          </ClientGroup>
          <ClientGroup title="VS Code 扩展" clients={["Cline", "Roo Code", "Kilo Code", "Continue"]}>
            选择 OpenAI-compatible provider。API Base 填写 OpenAI Base URL，API Key 填写本站密钥，模型名称使用本站返回值。
          </ClientGroup>
          <ClientGroup title="工作流与自动化" clients={["Dify", "FastGPT", "n8n", "LangChain"]}>
            使用 OpenAI-compatible 连接器。健康检查应调用 /v1/models，不要用聊天请求作为定时探测。
          </ClientGroup>
          <ClientGroup title="原生协议客户端" clients={["Claude Code", "Anthropic SDK", "Gemini REST 客户端"]}>
            Anthropic 使用站点根地址和 x-api-key。Gemini 使用站点根地址和 x-goog-api-key。本站会在转发前移除用户密钥。
          </ClientGroup>
        </TabsContent>
      </Tabs>

      <Card>
        <CardHeader>
          <CardTitle>协议路径</CardTitle>
          <CardDescription>只有客户端要求手动填写完整路径时才需要使用这些值。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <Endpoint path="/v1/responses" use="OpenAI Responses，Codex 和智能体客户端优先使用" />
          <Endpoint path="/v1/chat/completions" use="OpenAI Chat Completions 兼容客户端" />
          <Endpoint path="/v1/messages" use="Anthropic Messages 和 Claude Code" />
          <Endpoint path="/v1beta/models/{model}:generateContent" use="Gemini 原生 REST" />
          <Endpoint path="/v1/models" use="读取当前 Key 可访问的模型" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>常见错误</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <Troubleshooting code="401" text="Key 不正确、已删除或已停用。重新复制完整 Key。" />
          <Troubleshooting code="403" text="模型不在当前 Key 或订阅的允许范围内。使用 /v1/models 中的模型。" />
          <Troubleshooting code="429" text="余额、订阅额度、请求频率或 Token 限制已达到上限。查看“我的订阅”和“用量”。" />
          <Troubleshooting code="502" text="上游账户或网络暂时不可用。保留 X-Relay-Request-ID，并在“请求日志”中查看对应记录。" />
        </CardContent>
      </Card>
    </div>
  )
}

function guideSamples(origin: string) {
  const base = `${origin}/v1`
  return {
    models: `curl ${origin}/v1/models \\\n  -H "Authorization: Bearer relay_你的密钥"`,
    chat: `curl ${origin}/v1/chat/completions \\\n  -H "Authorization: Bearer relay_你的密钥" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"从模型列表复制","messages":[{"role":"user","content":"你好"}]}'`,
    relayEnv: `export RELAY_API_KEY="relay_你的密钥"`,
    codex: `model = "从模型列表复制"
model_provider = "relayapi"

[model_providers.relayapi]
name = "RelayAPI"
base_url = "${base}"
env_key = "RELAY_API_KEY"
wire_api = "responses"`,
    claudeCode: `export ANTHROPIC_BASE_URL="${origin}"
export ANTHROPIC_AUTH_TOKEN="relay_你的密钥"
export ANTHROPIC_MODEL="从模型列表复制"

claude`,
    opencode: `{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "relayapi": {
      "npm": "@ai-sdk/openai",
      "name": "RelayAPI",
      "options": {
        "baseURL": "${base}",
        "apiKey": "{env:RELAY_API_KEY}"
      },
      "models": {
        "从模型列表复制": { "name": "从模型列表复制" }
      }
    }
  }
}`,
    aider: `export OPENAI_API_KEY="relay_你的密钥"
export OPENAI_API_BASE="${base}"
aider --model openai/从模型列表复制`,
    python: `from openai import OpenAI

client = OpenAI(
    api_key="relay_你的密钥",
    base_url="${base}",
)

response = client.responses.create(
    model="从模型列表复制",
    input="你好",
)
print(response.output_text)`,
    node: `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "relay_你的密钥",
  baseURL: "${base}",
});

const response = await client.responses.create({
  model: "从模型列表复制",
  input: "你好",
});
console.log(response.output_text);`,
    anthropic: `curl ${origin}/v1/messages \\\n  -H "x-api-key: relay_你的密钥" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"从模型列表复制","max_tokens":256,"messages":[{"role":"user","content":"你好"}]}'`,
    gemini: `curl "${origin}/v1beta/models/从模型列表复制:generateContent" \\\n  -H "x-goog-api-key: relay_你的密钥" \\\n  -H "content-type: application/json" \\\n  -d '{"contents":[{"role":"user","parts":[{"text":"你好"}]}]}'`,
  }
}

function GuideStep({ icon: Icon, number, title, children }: { icon: typeof KeyRoundIcon; number: string; title: string; children: ReactNode }) {
  return <Card><CardHeader><div className="flex items-center gap-3"><div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Icon /></div><div><Badge variant="outline">步骤 {number}</Badge><CardTitle className="mt-2">{title}</CardTitle></div></div></CardHeader><CardContent className="text-sm leading-6 text-muted-foreground">{children}</CardContent></Card>
}

function ConnectionValue({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  return <div className="flex min-w-0 items-center gap-3 rounded-lg border p-3"><div className="min-w-0 flex-1"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 truncate font-mono text-sm">{value}</p></div>{secret ? null : <Button variant="ghost" size="icon-sm" aria-label={`复制 ${label}`} onClick={() => void copy(value, label)}><ClipboardIcon /></Button>}</div>
}

function SampleCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3">{children}</CardContent></Card>
}

function CodeSample({ code, label }: CodeSampleProps) {
  return <div className="overflow-hidden rounded-lg border bg-muted/20"><div className="flex items-center justify-between border-b px-3 py-2"><span className="text-xs text-muted-foreground">{label}</span><Button variant="ghost" size="icon-xs" aria-label={label} onClick={() => void copy(code, "配置")}><ClipboardIcon /></Button></div><pre className="overflow-x-auto p-3 text-xs leading-5"><code>{code}</code></pre></div>
}

function ClientGroup({ title, clients, children }: { title: string; clients: string[]; children: ReactNode }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle><div className="flex flex-wrap gap-1.5">{clients.map((client) => <Badge key={client} variant="outline">{client}</Badge>)}</div></CardHeader><CardContent className="text-sm leading-6 text-muted-foreground">{children}</CardContent></Card>
}

function Endpoint({ path, use }: { path: string; use: string }) {
  return <div className="grid gap-1 sm:grid-cols-[18rem_1fr]"><code className="font-mono text-xs">{path}</code><span className="text-muted-foreground">{use}</span></div>
}

function Troubleshooting({ code, text }: { code: string; text: string }) {
  return <div className="flex items-start gap-3"><Badge variant="outline" className="font-mono">{code}</Badge><p className="text-muted-foreground">{text}</p></div>
}

async function copy(value: string, label: string) {
  try {
    await copyText(value)
    toast.success(`${label}已复制`)
  } catch {
    toast.error("复制失败")
  }
}

"use client";

import * as React from "react";
import {
  CircleAlertIcon,
  ClipboardCopyIcon,
  KeyRoundIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  TerminalIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createTenantApiKey, tenantErrorMessage } from "@/lib/tenant-api";
import {
  buildCodexConfig,
  buildOpenAIEnvironment,
  buildOpenCodeConfig,
  CODEX_DEFAULT_MODEL,
  type CodexPlatform,
  type CodexModelManifest,
  normalizeRelayBaseUrl,
  parseCodexModelManifest,
  RELAY_DEFAULT_BASE_URL,
} from "@/src/shared/codexSetup";
import type {
  CreatedApiKey,
  PublicApiKey,
  PublicTenant,
  TenantResources,
} from "@/src/shared/types/entities";

type SetupClient = "codex" | "opencode" | "openai";

type CodexSetupSectionProps = {
  apiKeys: PublicApiKey[];
  initialSecret?: string;
  resources: TenantResources;
  tenant: PublicTenant;
  onApiKeyCreated: (apiKey: CreatedApiKey) => void;
};

export function TenantCodexSetupSection({
  apiKeys,
  initialSecret = "",
  onApiKeyCreated,
  resources,
  tenant,
}: CodexSetupSectionProps) {
  const [client, setClient] = React.useState<SetupClient>("codex");
  const [codexPlatform, setCodexPlatform] = React.useState<CodexPlatform>("windows");
  const [secret, setSecret] = React.useState(initialSecret);
  const [creating, setCreating] = React.useState(false);
  const [model, setModel] = React.useState(CODEX_DEFAULT_MODEL);
  const [manifest, setManifest] = React.useState<CodexModelManifest | null>(null);
  const [modelsError, setModelsError] = React.useState("");
  const [modelsLoading, setModelsLoading] = React.useState(true);
  const relayBaseUrl = normalizeRelayBaseUrl(React.useSyncExternalStore(
    subscribeToBrowserOrigin,
    readBrowserOrigin,
    readServerOrigin,
  ));

  const loadModels = React.useCallback(async (notify = false) => {
    setModelsLoading(true);
    try {
      const response = await fetch("/api/model-catalog?format=codex", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("模型目录暂时不可用");
      const nextManifest = parseCodexModelManifest(await response.json());
      const nextModels = nextManifest.models.map((entry) => entry.slug);
      setManifest(nextManifest);
      setModelsError("");
      setModel((current) => nextModels.includes(current) ? current : nextModels[0]);
      if (notify) toast.success(`已同步 ${nextModels.length} 个可路由模型`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setManifest(null);
      setModelsError(message);
      if (notify) toast.error(message);
    } finally {
      setModelsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const timer = window.setTimeout(() => void loadModels(), 0);
    return () => window.clearTimeout(timer);
  }, [loadModels]);

  async function createDedicatedKey() {
    setCreating(true);
    try {
      const created = await createTenantApiKey({
        name: "客户端接入",
        enabled: true,
        scopes: ["relay"],
        modelAllowlist: [],
        channelAllowlist: [],
        tokenLimitDaily: null,
        rateLimitPerMinute: null,
        expiresAt: null,
      });
      onApiKeyCreated(created);
      setSecret(created.key);
      toast.success("已创建客户端专用 Key");
    } catch (error) {
      toast.error(tenantErrorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  const models = manifest?.models.map((entry) => entry.slug) || [];
  const keyValue = secret || "sk-填入你的租户 API Key";
  const providers = providersForModel(resources, model);
  const codexConfig = buildCodexConfig(model, keyValue, relayBaseUrl, codexPlatform);
  const openCodeConfig = manifest
    ? buildOpenCodeConfig(model, manifest, keyValue, relayBaseUrl)
    : "";

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>客户端接入</CardTitle>
          <CardDescription>
            配置会使用当前 RelayAPI 地址，并只展示你的子订阅实际授权、可路由的模型。
          </CardDescription>
          <CardAction>
            <Button
              type="button"
              disabled={creating || tenant.enabledApiKeyCount >= (tenant.maxApiKeys ?? Infinity)}
              onClick={createDedicatedKey}
            >
              {creating ? <Spinner data-icon="inline-start" /> : <KeyRoundIcon data-icon="inline-start" />}
              创建专用 Key
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {secret ? (
            <Alert>
              <ShieldCheckIcon />
              <AlertTitle>新 Key 已就绪，仅在本次会话显示</AlertTitle>
              <AlertDescription className="flex flex-col gap-3">
                <code className="break-all rounded-md bg-background px-3 py-2 text-foreground ring-1 ring-foreground/10">
                  {secret}
                </code>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => void copyText(secret, "Key 已复制")}>
                    <ClipboardCopyIcon data-icon="inline-start" />
                    复制 Key
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setSecret("")}>
                    已保存，隐藏明文
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : (
            <p className="text-sm text-muted-foreground">
              {apiKeys.length > 0
                ? "已有 Key 的明文无法再次查看。请使用已保存的 Key，或创建一个新的客户端专用 Key。"
                : "你还没有 API Key。创建后，页面会自动填入下面的配置。"}
            </p>
          )}

          <FieldGroup>
            <Field>
              <div className="flex items-center justify-between gap-3">
                <FieldLabel>默认模型</FieldLabel>
                <Button type="button" variant="ghost" size="sm" disabled={modelsLoading} onClick={() => void loadModels(true)}>
                  {modelsLoading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
                  同步模型
                </Button>
              </div>
              <Select value={model} onValueChange={(value) => value && setModel(value)}>
                <SelectTrigger className="w-full sm:max-w-md">
                  <SelectValue placeholder="选择模型" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {models.map((modelId) => (
                      <SelectItem key={modelId} value={modelId}>
                        {modelId}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                {modelsLoading
                  ? "正在同步可路由模型…"
                  : modelsError
                    ? `同步失败：${modelsError}`
                    : `${models.length} 个模型可用。Grok 等模型同样按通道声明匹配，不按名称前缀分类。`}
              </FieldDescription>
              {providers.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {providers.map((provider) => <Badge key={provider} variant="outline">{providerLabel(provider)} 通道</Badge>)}
                </div>
              )}
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Tabs value={client} onValueChange={(value) => setClient(value as SetupClient)}>
        <TabsList>
          <TabsTrigger value="codex">Codex</TabsTrigger>
          <TabsTrigger value="opencode">OpenCode</TabsTrigger>
          <TabsTrigger value="openai">OpenAI 兼容</TabsTrigger>
        </TabsList>

        <TabsContent value="codex" className="flex flex-col gap-4">
          <SetupIntro
            title="Codex CLI"
            description="跨平台单文件配置：选择操作系统后，页面会生成对应的命令认证配置；Codex 会从 RelayAPI 的 /v1/models 自动加载该用户可路由的完整模型目录。"
            steps={[
              "创建客户端专用 Key，页面会自动写入下方配置",
              `将完整配置保存为 ${codexConfigPath(codexPlatform)}`,
              "完全重启 Codex，随后可使用 /model 选择 RelayAPI 返回的模型",
            ]}
          />
          <Tabs value={codexPlatform} onValueChange={(value) => setCodexPlatform(value as CodexPlatform)}>
            <TabsList>
              <TabsTrigger value="windows">Windows</TabsTrigger>
              <TabsTrigger value="macos">macOS</TabsTrigger>
              <TabsTrigger value="linux">Linux</TabsTrigger>
            </TabsList>
          </Tabs>
          <Alert>
            <CircleAlertIcon />
            <AlertTitle>Key 会以明文保存在配置文件中</AlertTitle>
            <AlertDescription>
              请只在自己的设备上使用，并限制 config.toml 的读取权限。复制配置前确认页面已填入真实 Key；不要把该文件提交到 Git。
            </AlertDescription>
          </Alert>
          {providers.includes("grok") && (
            <Alert>
              <ShieldCheckIcon />
              <AlertTitle>已选择 Grok 订阅可用模型</AlertTitle>
              <AlertDescription>
                Codex 仍通过同一个 Responses Provider 接入；RelayAPI 的 /v1/models 会返回 Grok 的上下文和推理元数据，不需要 OAuth 模式或模型前缀判断。
              </AlertDescription>
            </Alert>
          )}
          <div className="grid gap-4 xl:grid-cols-2">
            <ConfigPanel filename={codexConfigPath(codexPlatform)} value={codexConfig} />
            <ConfigPanel filename="Codex 远程模型目录" value={`${relayBaseUrl}/models?format=codex`} />
          </div>
        </TabsContent>

        <TabsContent value="opencode" className="flex flex-col gap-4">
          <SetupIntro
            title="OpenCode"
            description="RelayAPI 提供 Responses API，因此按 OpenCode 最新文档使用 @ai-sdk/openai。配置包含你的全部可路由模型。"
            steps={[
              "把下方文件保存为项目 opencode.json，或保存为 ~/.config/opencode/opencode.json",
              "完全重启 OpenCode",
              "运行 /models，选择 relayapi 下的模型",
            ]}
          />
          {openCodeConfig ? (
            <ConfigPanel filename="opencode.json" value={openCodeConfig} />
          ) : (
            <ModelsUnavailable loading={modelsLoading} error={modelsError} />
          )}
        </TabsContent>

        <TabsContent value="openai" className="flex flex-col gap-4">
          <SetupIntro
            title="通用 OpenAI 兼容客户端"
            description="支持 Responses API 的客户端优先使用 /v1/responses；旧客户端也可以使用 /v1/chat/completions。"
            steps={[
              "设置下面两个环境变量",
              "在客户端中选择上方模型",
              "如客户端要求接口类型，优先选择 Responses API",
            ]}
          />
          <div className="grid gap-4 xl:grid-cols-2">
            <ConfigPanel filename="环境变量" value={buildOpenAIEnvironment(keyValue, relayBaseUrl)} />
            <ConfigPanel filename="模型目录接口" value={`${relayBaseUrl}/models`} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SetupIntro({ title, description, steps }: { title: string; description: string; steps: string[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-3">
          {steps.map((step, index) => (
            <li key={step} className="flex items-start gap-3 text-sm">
              <Badge variant="outline">{index + 1}</Badge>
              <span className="pt-0.5">{step}</span>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function ConfigPanel({ filename, value }: { filename: string; value: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><TerminalIcon />{filename}</CardTitle>
        <CardAction>
          <Button type="button" variant="outline" onClick={() => void copyText(value, `${filename} 已复制`)}>
            <ClipboardCopyIcon data-icon="inline-start" />复制
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <pre className="max-h-[32rem] overflow-auto rounded-md bg-muted p-4 text-xs leading-relaxed"><code>{value}</code></pre>
      </CardContent>
    </Card>
  );
}

function ModelsUnavailable({ loading, error }: { loading: boolean; error: string }) {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertTitle>暂时无法生成完整配置</AlertTitle>
      <AlertDescription>
        {loading ? "正在加载模型元数据…" : error || "模型元数据不可用，请重试同步。"}
      </AlertDescription>
    </Alert>
  );
}

function providersForModel(resources: TenantResources, model: string) {
  return [...new Set(
    resources.channels
      .filter((channel) => channel.enabled && channel.modelAllowlist.includes(model))
      .map((channel) => channel.provider),
  )];
}

function providerLabel(provider: string) {
  if (provider === "grok") return "Grok";
  if (provider === "codex") return "Codex";
  return provider;
}

function codexConfigPath(platform: CodexPlatform) {
  return platform === "windows"
    ? "%USERPROFILE%\\.codex\\config.toml"
    : "~/.codex/config.toml";
}

async function copyText(value: string, message: string) {
  await navigator.clipboard.writeText(value);
  toast.success(message);
}

function subscribeToBrowserOrigin() {
  return () => undefined;
}

function readBrowserOrigin() {
  return window.location.origin;
}

function readServerOrigin() {
  return RELAY_DEFAULT_BASE_URL;
}

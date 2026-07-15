"use client";

import * as React from "react";
import {
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
import type { CreatedApiKey, PublicApiKey, PublicTenant } from "@/src/shared/types/entities";

const DEFAULT_BASE_URL = "https://ai.cafebabe.top/v1";
const PROVIDER_NAME = "cliproxyapi";
const DEFAULT_MODEL = "gpt-5.6-sol";

type SetupMode = "oauth" | "api";
type ModelCatalogResponse = { data?: string[] };

type CodexSetupSectionProps = {
  apiKeys: PublicApiKey[];
  initialSecret?: string;
  tenant: PublicTenant;
  onApiKeyCreated: (apiKey: CreatedApiKey) => void;
};

export function TenantCodexSetupSection({
  apiKeys,
  initialSecret = "",
  onApiKeyCreated,
  tenant,
}: CodexSetupSectionProps) {
  const [mode, setMode] = React.useState<SetupMode>("oauth");
  const [secret, setSecret] = React.useState(initialSecret);
  const [creating, setCreating] = React.useState(false);
  const [model, setModel] = React.useState(DEFAULT_MODEL);
  const [models, setModels] = React.useState<string[]>([DEFAULT_MODEL]);
  const [modelsLoading, setModelsLoading] = React.useState(true);

  const loadModels = React.useCallback(async (notify = false) => {
    setModelsLoading(true);
    try {
      const response = await fetch("/api/model-catalog", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("模型目录暂时不可用");
      const result = (await response.json()) as ModelCatalogResponse;
      const nextModels = Array.isArray(result.data)
        ? [...new Set(result.data.map((value) => String(value || "").trim()).filter(Boolean))]
        : [];
      if (nextModels.length === 0) throw new Error("上游没有返回可用模型");
      setModels(nextModels);
      setModel((current) => nextModels.includes(current) ? current : nextModels[0]);
      if (notify) toast.success(`已同步 ${nextModels.length} 个模型`);
    } catch (error) {
      if (notify) toast.error(error instanceof Error ? error.message : String(error));
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
        name: "Codex CLI",
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
      toast.success("已创建 Codex 专用 Key");
    } catch (error) {
      toast.error(tenantErrorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  const keyValue = secret || "sk-填入你的租户 API Key";
  const config = mode === "oauth"
    ? buildOAuthConfig(model, keyValue)
    : buildApiConfig(model);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>连接 Codex</CardTitle>
          <CardDescription>
            选择登录方式，复制配置，然后在 Codex CLI 或 Codex App 中开始使用。
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
                ? "已有 Key 的明文无法再次查看。请使用刚创建并保存的 Key，或新建一个 Codex 专用 Key。"
                : "你还没有 API Key。先创建专用 Key，页面会自动把它填入配置。"}
            </p>
          )}

          <FieldGroup>
            <Field>
              <div className="flex items-center justify-between gap-3">
                <FieldLabel>模型</FieldLabel>
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
                    {models.map((modelId) => <SelectItem key={modelId} value={modelId}>{modelId}</SelectItem>)}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                {modelsLoading ? "正在同步可用模型…" : `${models.length} 个模型可用，推荐从 ${DEFAULT_MODEL} 开始。`}
              </FieldDescription>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Tabs value={mode} onValueChange={(value) => setMode(value as SetupMode)}>
        <TabsList>
          <TabsTrigger value="oauth">OAuth 登录（推荐）</TabsTrigger>
          <TabsTrigger value="api">API 模式</TabsTrigger>
        </TabsList>

        <TabsContent value="oauth" className="flex flex-col gap-4">
          <SetupIntro
            title="使用 ChatGPT 账户登录"
            description="适用于任意 ChatGPT 订阅，包括免费账户。只需写入 config.toml，不要修改 auth.json。"
            steps={["启动 CLIProxyAPI 服务器", "写入下方 config.toml", "打开 Codex CLI 或 Codex App，按提示登录 ChatGPT"]}
          />
          <ConfigPanel filename="~/.codex/config.toml" value={config} />
        </TabsContent>

        <TabsContent value="api" className="flex flex-col gap-4">
          <SetupIntro
            title="使用 API Key 连接"
            description="适合不需要 ChatGPT OAuth 登录的环境。config.toml 和 auth.json 都需要写入。"
            steps={["启动 CLIProxyAPI 服务器", "写入 config.toml", "将 Key 写入 auth.json，然后启动 Codex"]}
          />
          <div className="grid gap-4 xl:grid-cols-2">
            <ConfigPanel filename="~/.codex/config.toml" value={config} />
            <ConfigPanel filename="~/.codex/auth.json" value={buildCodexAuthJson(keyValue)} />
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

async function copyText(value: string, message: string) {
  await navigator.clipboard.writeText(value);
  toast.success(message);
}

function safetyOptions() {
  return `# 无需确认是否执行操作，危险指令，初次接触 Codex 不建议开启，移除 # 号即可开启
# approval_policy = "never"

# 沙箱模式超高权限，危险指令，初次接触 Codex 不建议开启，移除 # 号即可开启
# sandbox_mode = "danger-full-access"`;
}

function buildOAuthConfig(model: string, apiKey: string) {
  return `model = "${model}"
model_provider = "${PROVIDER_NAME}"
model_reasoning_effort = "xhigh"
plan_mode_reasoning_effort = "xhigh"

${safetyOptions()}

[model_providers.${PROVIDER_NAME}]
base_url = "${DEFAULT_BASE_URL}"
experimental_bearer_token = "${apiKey}"
name = "OpenAI"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = true
`;
}

function buildApiConfig(model: string) {
  return `${safetyOptions()}

model_provider = "${PROVIDER_NAME}"
model = "${model}"
model_reasoning_effort = "high"

[model_providers.${PROVIDER_NAME}]
name = "${PROVIDER_NAME}"
base_url = "${DEFAULT_BASE_URL}"
wire_api = "responses"
`;
}

function buildCodexAuthJson(apiKey: string) {
  return JSON.stringify({ OPENAI_API_KEY: apiKey }, null, 2);
}

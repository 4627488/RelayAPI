"use client";

import * as React from "react";
import {
  CheckIcon,
  ClipboardCopyIcon,
  KeyRoundIcon,
  ShieldAlertIcon,
  SparklesIcon,
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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { createTenantApiKey, tenantErrorMessage } from "@/lib/tenant-api";
import type {
  CreatedApiKey,
  PublicApiKey,
  PublicTenant,
} from "@/src/shared/types/entities";

const DEFAULT_BASE_URL = "https://ai.cafebabe.top/v1";
const PROVIDER_NAME = "cliproxyapi";
const DEFAULT_MODEL = "gpt-5.5";

type CodexSetupSectionProps = {
  apiKeys: PublicApiKey[];
  tenant: PublicTenant;
  onApiKeyCreated: (apiKey: CreatedApiKey) => void;
};

export function TenantCodexSetupSection({
  apiKeys,
  onApiKeyCreated,
  tenant,
}: CodexSetupSectionProps) {
  const enabledKeys = apiKeys.filter((apiKey) => apiKey.enabled);
  const [selectedKeyId, setSelectedKeyId] = React.useState(
    enabledKeys[0]?.id || "",
  );
  const [createdSecret, setCreatedSecret] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [model, setModel] = React.useState([DEFAULT_MODEL]);

  const effectiveSelectedKeyId = apiKeys.some(
    (apiKey) => apiKey.id === selectedKeyId,
  )
    ? selectedKeyId
    : enabledKeys[0]?.id || "";
  const selectedKey = apiKeys.find(
    (apiKey) => apiKey.id === effectiveSelectedKeyId,
  );
  const apiKeyForAuth = createdSecret || "sk-填入你的租户 API Key";
  const selectedModel = model[0] || DEFAULT_MODEL;
  const keyReady = Boolean(createdSecret);
  const configToml = buildCodexConfigToml(selectedModel);
  const authJson = buildCodexAuthJson(apiKeyForAuth);

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
      setSelectedKeyId(created.id);
      setCreatedSecret(created.key);
      toast.success("已创建 Codex CLI 专用 Key");
    } catch (error) {
      toast.error(tenantErrorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Codex 首次配置</CardTitle>
          <CardDescription>
            生成可直接写入本机 `~/.codex` 的配置，并使用租户 Key 接入 Relay。
          </CardDescription>
          <CardAction>
            <Button
              type="button"
              disabled={
                creating ||
                tenant.enabledApiKeyCount >= (tenant.maxApiKeys ?? Infinity)
              }
              onClick={createDedicatedKey}
            >
              {creating ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <KeyRoundIcon data-icon="inline-start" />
              )}
              创建专用 Key
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-5">
          <Alert>
            <ShieldAlertIcon />
            <AlertTitle>安全开关默认保持关闭</AlertTitle>
            <AlertDescription>
              <code>approval_policy = &quot;never&quot;</code> 和{" "}
              <code>sandbox_mode = &quot;danger-full-access&quot;</code>
              已保留为注释，熟悉 Codex 后再手动开启。
            </AlertDescription>
          </Alert>

          <FieldGroup>
            <Field>
              <FieldLabel>模型</FieldLabel>
              <ToggleGroup
                value={model}
                onValueChange={(value) => {
                  if (value[0]) {
                    setModel([value[0]]);
                  }
                }}
                size="sm"
                variant="outline"
              >
                <ToggleGroupItem value="gpt-5.5">gpt-5.5</ToggleGroupItem>
                <ToggleGroupItem value="gpt-5.4">gpt-5.4</ToggleGroupItem>
              </ToggleGroup>
              <FieldDescription>
                也可以把生成后的 `model` 改成任意已支持模型。
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel>API Key</FieldLabel>
              {apiKeys.length === 0 ? (
                <Empty className="min-h-36">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <KeyRoundIcon />
                    </EmptyMedia>
                    <EmptyTitle>还没有租户 Key</EmptyTitle>
                    <EmptyDescription>
                      创建专用 Key 后会自动填入 `auth.json`。
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Select
                    value={effectiveSelectedKeyId}
                    onValueChange={(value) => setSelectedKeyId(value || "")}
                  >
                    <SelectTrigger className="w-full sm:min-w-64">
                      <SelectValue placeholder="选择已有 Key" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {apiKeys.map((apiKey) => (
                          <SelectItem key={apiKey.id} value={apiKey.id}>
                            {apiKey.name || apiKey.prefix}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Badge variant={selectedKey?.enabled ? "secondary" : "outline"}>
                      {selectedKey?.enabled ? "启用" : "停用"}
                    </Badge>
                    <span className="font-mono text-xs">
                      {selectedKey?.prefix || "未选择"}
                    </span>
                  </div>
                </div>
              )}
              <FieldDescription>
                已有 Key 只能显示前缀；新建专用 Key 后会在本页临时保留明文用于生成配置。
              </FieldDescription>
            </Field>
          </FieldGroup>

          <div className="grid gap-3 md:grid-cols-3">
            <SetupStep
              active
              title="1. 创建目录"
              value="mkdir -p ~/.codex"
            />
            <SetupStep
              active={keyReady}
              title="2. 准备 Key"
              value={keyReady ? "auth.json 已填入" : "创建专用 Key"}
            />
            <SetupStep active title="3. 写入文件" value="config.toml + auth.json" />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <ConfigPanel
          filename="~/.codex/config.toml"
          icon={<TerminalIcon />}
          value={configToml}
        />
        <ConfigPanel
          filename="~/.codex/auth.json"
          icon={<SparklesIcon />}
          muted={!keyReady}
          value={authJson}
        />
      </div>
    </div>
  );
}

function SetupStep({
  active,
  title,
  value,
}: {
  active: boolean;
  title: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-background/60 p-3">
      <Badge variant={active ? "secondary" : "outline"}>
        <CheckIcon />
      </Badge>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{title}</div>
        <div className="truncate text-xs text-muted-foreground">{value}</div>
      </div>
    </div>
  );
}

function ConfigPanel({
  filename,
  icon,
  muted = false,
  value,
}: {
  filename: string;
  icon: React.ReactNode;
  muted?: boolean;
  value: string;
}) {
  async function copy() {
    await navigator.clipboard.writeText(value);
    toast.success(`${filename} 已复制`);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {icon}
          {filename}
        </CardTitle>
        <CardDescription>
          {muted ? "先创建专用 Key，即可得到完整 auth.json。" : "复制后写入对应文件。"}
        </CardDescription>
        <CardAction>
          <Button type="button" variant="outline" onClick={copy}>
            <ClipboardCopyIcon data-icon="inline-start" />
            复制
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <pre className="max-h-96 overflow-auto rounded-lg bg-muted/45 p-3 text-xs leading-relaxed">
          <code>{value}</code>
        </pre>
      </CardContent>
    </Card>
  );
}

function buildCodexConfigToml(model: string) {
  return `# 无需确认是否执行操作，危险指令，初次接触codex不建议开启，移除#号即可开启
# approval_policy = "never"

# 沙箱模式超高权限，危险指令，初次接触codex不建议开启，移除#号即可开启
# sandbox_mode = "danger-full-access"

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

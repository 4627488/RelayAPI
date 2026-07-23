"use client";
import * as React from "react";
import { toast } from "sonner";
import { SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ProviderCredentialCard } from "@/components/admin/provider-credential-card";
import { QuotaResetHistorySheet } from "@/components/quota-reset-history-sheet";
import { ProviderCredentialRoutingFields } from "@/components/admin/provider-credential-routing-fields";
import { ProviderQuotaWindows } from "@/components/admin/provider-quota-windows";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { formatDateTime } from "@/components/workspace/format";
import type { GrokCredentialRecord } from "@/src/shared/types/entities";
import {
  deleteProviderCredential,
  getProviderCredentialQuota,
  getProviderCredentialResetEvents,
  updateProviderCredential,
} from "@/lib/admin-api";
import {
  providerCredentialDefaultBaseUrl,
  providerPlanLabel,
} from "@/src/shared/providerCapabilities";
import {
  grokQuotaWindowViews,
  type GrokQuotaReport,
} from "@/src/shared/providerQuota";

export function GrokCredentialCards({
  credentials,
  onRoutingChanged,
}: {
  credentials: GrokCredentialRecord[];
  onRoutingChanged?: () => Promise<unknown>;
}) {
  const [quotas, setQuotas] = React.useState<Record<string, GrokQuotaReport>>(
    {},
  );
  const [quotaErrors, setQuotaErrors] = React.useState<Record<string, string>>(
    {},
  );
  const [quotaLoading, setQuotaLoading] = React.useState<Set<string>>(
    new Set(),
  );
  const loadQuota = React.useCallback(
    async (credential: GrokCredentialRecord) => {
      if (credential.authType !== "oauth") return;
      setQuotaLoading((current) => new Set(current).add(credential.id));
      try {
        const report = await getProviderCredentialQuota("grok", credential.id);
        setQuotas((current) => ({ ...current, [credential.id]: report }));
        setQuotaErrors((current) => {
          const next = { ...current };
          delete next[credential.id];
          return next;
        });
      } catch (error) {
        setQuotaErrors((current) => ({
          ...current,
          [credential.id]:
            error instanceof Error ? error.message : String(error),
        }));
      } finally {
        setQuotaLoading((current) => {
          const next = new Set(current);
          next.delete(credential.id);
          return next;
        });
      }
    },
    [],
  );
  React.useEffect(() => {
    void Promise.all(credentials.map(loadQuota));
  }, [credentials, loadQuota]);
  React.useEffect(() => {
    const reload = () => void onRoutingChanged?.();
    window.addEventListener("grok-credentials-changed", reload);
    window.addEventListener("grok-quota-refresh", reload);
    return () => {
      window.removeEventListener("grok-credentials-changed", reload);
      window.removeEventListener("grok-quota-refresh", reload);
    };
  }, [onRoutingChanged]);
  async function createChannel(credential: GrokCredentialRecord) {
    const catalogResponse = await fetch("/api/model-catalog?provider=grok", {
      cache: "no-store",
    });
    if (!catalogResponse.ok)
      return toast.error(await errorText(catalogResponse));
    const catalog = (await catalogResponse.json()) as { data?: string[] };
    const modelAllowlist = Array.isArray(catalog.data)
      ? catalog.data.filter(
          (model) => typeof model === "string" && model.trim(),
        )
      : [];
    if (!modelAllowlist.length)
      return toast.error("Grok 上游没有返回可声明的模型");
    const response = await fetch("/api/admin/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "grok",
        name: `Grok · ${credential.email || credential.subject || credential.id}`,
        credentialIds: [credential.id],
        baseUrl: providerCredentialDefaultBaseUrl(credential, ""),
        modelAllowlist,
      }),
    });
    if (!response.ok) return toast.error(await errorText(response));
    await onRoutingChanged?.();
    toast.success(`Grok 通道已创建，已声明 ${modelAllowlist.length} 个模型`);
  }
  async function remove(id: string) {
    try {
      await deleteProviderCredential("grok", id);
      await onRoutingChanged?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }
  return (
    <>
      {credentials.map((item) => {
        return (
          <ProviderCredentialCard
            key={item.id}
            credential={item}
            planLabel={providerPlanLabel(
              "grok",
              quotas[item.id]?.planType || item.planType,
            )}
            actions={
              <GrokSettingsDialog
                credential={item}
                onCreateChannel={() => createChannel(item)}
                onDeleted={() => remove(item.id)}
                onSaved={async () => {
                  await onRoutingChanged?.();
                }}
              />
            }
            notice={!item.enabled ? <Badge variant="outline">off</Badge> : null}
            proxy={
              <Badge variant="outline">
                {item.useGlobalProxy
                  ? "跟随全局"
                  : item.proxy?.enabled
                    ? `已启用 · ${item.proxy.type}`
                    : "未配置"}
              </Badge>
            }
            quotaAction={
              <div className="flex items-center gap-1">
                <QuotaResetHistorySheet
                  description={`${item.email || item.subject || item.id} · ${providerPlanLabel("grok", item.planType)}`}
                  load={() =>
                    getProviderCredentialResetEvents("grok", item.id).then(
                      (result) => result.events,
                    )
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={
                    quotaLoading.has(item.id) || item.authType !== "oauth"
                  }
                  onClick={() => void loadQuota(item)}
                >
                  刷新
                </Button>
              </div>
            }
            quotaContent={
              <GrokQuotaProgress
                report={quotas[item.id]}
                error={quotaErrors[item.id]}
                apiKey={item.authType === "api_key"}
              />
            }
          />
        );
      })}
    </>
  );
}
async function errorText(response: Response) {
  try {
    const body = await response.json();
    return (
      body?.error?.message || body?.message || `请求失败 (${response.status})`
    );
  } catch {
    return `请求失败 (${response.status})`;
  }
}

function GrokQuotaProgress({
  report,
  error,
  apiKey,
}: {
  report?: GrokQuotaReport;
  error?: string;
  apiKey: boolean;
}) {
  if (apiKey)
    return (
      <div className="text-xs text-muted-foreground">
        xAI API Key 的额度由 API 账单管理，不提供订阅余额。
      </div>
    );
  if (error) return <div className="text-xs text-destructive">{error}</div>;
  if (!report)
    return (
      <div className="text-xs text-muted-foreground">
        正在读取 Grok 上游额度…
      </div>
    );
  const windows = grokQuotaWindowViews(report, formatDateTime);
  if (!windows.length)
    return (
      <div className="text-xs text-muted-foreground">
        Grok 上游未返回可计算的额度。
      </div>
    );
  return <ProviderQuotaWindows windows={windows} />;
}

function GrokSettingsDialog({
  credential,
  onCreateChannel,
  onDeleted,
  onSaved,
}: {
  credential: GrokCredentialRecord;
  onCreateChannel: () => Promise<unknown>;
  onDeleted: () => Promise<unknown>;
  onSaved: () => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [enabled, setEnabled] = React.useState(credential.enabled);
  const [priority, setPriority] = React.useState(String(credential.priority));
  const [weight, setWeight] = React.useState(String(credential.weight));
  const [transport, setTransport] = React.useState(
    credential.upstreamTransport,
  );
  const [baseUrl, setBaseUrl] = React.useState(credential.grokBaseUrl || "");
  const [nativeXSearch, setNativeXSearch] = React.useState(
    credential.grokNativeXSearch,
  );
  const [clientToolCache, setClientToolCache] = React.useState(
    credential.grokClientToolCache,
  );
  const [headersText, setHeadersText] = React.useState(
    Object.keys(credential.grokHeaders).length
      ? JSON.stringify(credential.grokHeaders, null, 2)
      : "",
  );
  const [modelAliasesText, setModelAliasesText] = React.useState(
    Object.keys(credential.grokModelAliases).length
      ? JSON.stringify(credential.grokModelAliases, null, 2)
      : "",
  );
  const [excludedModelsText, setExcludedModelsText] = React.useState(
    credential.grokExcludedModels.join("\n"),
  );
  async function save() {
    setPending(true);
    try {
      const grokHeaders = jsonObject(headersText, "自定义请求头");
      const grokModelAliases = jsonObject(modelAliasesText, "模型别名");
      await updateProviderCredential("grok", credential.id, {
        enabled,
        priority: Number(priority),
        weight: Number(weight),
        upstreamTransport: transport,
        grokBaseUrl: baseUrl,
        grokNativeXSearch: nativeXSearch,
        grokClientToolCache: clientToolCache,
        grokHeaders,
        grokModelAliases,
        grokExcludedModels: excludedModelsText,
      });
      await onSaved();
      setOpen(false);
      toast.success("Grok 凭据设置已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="凭据设置"
          />
        }
      >
        <SettingsIcon />
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>凭据设置</DialogTitle>
          <DialogDescription>
            {credential.email || credential.subject || credential.id} · Grok
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="routing">
          <TabsList>
            <TabsTrigger value="routing">分发</TabsTrigger>
            <TabsTrigger value="grok">Grok</TabsTrigger>
            <TabsTrigger value="models">模型</TabsTrigger>
          </TabsList>
          <TabsContent value="routing">
            <ProviderCredentialRoutingFields
              credentialId={credential.id}
              enabled={enabled}
              priority={priority}
              weight={weight}
              onEnabledChange={setEnabled}
              onPriorityChange={setPriority}
              onWeightChange={setWeight}
            />
          </TabsContent>
          <TabsContent value="grok">
            <FieldGroup>
              <Field>
                <FieldLabel>上游传输</FieldLabel>
                <Select
                  value={transport}
                  onValueChange={(value) =>
                    setTransport(
                      value as GrokCredentialRecord["upstreamTransport"],
                    )
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="auto">
                        自动（WebSocket 失败回退 HTTP）
                      </SelectItem>
                      <SelectItem value="websocket">仅 WebSocket</SelectItem>
                      <SelectItem value="http">仅 HTTP</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  WebSocket 仅用于流式 Responses 请求；非流式请求始终使用 HTTP。
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={`grok-base-url-${credential.id}`}>
                  自定义上游地址
                </FieldLabel>
                <Input
                  id={`grok-base-url-${credential.id}`}
                  placeholder={
                    credential.authType === "oauth"
                      ? "https://cli-chat-proxy.grok.com/v1"
                      : "https://api.x.ai/v1"
                  }
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
                <FieldDescription>
                  改变对话和额度探测端点，不改变 OAuth 授权和令牌刷新地址。
                </FieldDescription>
              </Field>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor={`grok-x-search-${credential.id}`}>
                    原生 X Search
                  </FieldLabel>
                  <FieldDescription>
                    自动向 Grok 提供
                    x_search；关闭后只保留客户端声明的受支持工具。
                  </FieldDescription>
                </FieldContent>
                <Switch
                  id={`grok-x-search-${credential.id}`}
                  checked={nativeXSearch}
                  onCheckedChange={(value) => setNativeXSearch(Boolean(value))}
                />
              </Field>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor={`grok-tool-cache-${credential.id}`}>
                    客户端工具缓存
                  </FieldLabel>
                  <FieldDescription>
                    保留
                    prompt_cache_key，提高多轮工具请求的上游缓存命中；关闭会移除该字段。
                  </FieldDescription>
                </FieldContent>
                <Switch
                  id={`grok-tool-cache-${credential.id}`}
                  checked={clientToolCache}
                  onCheckedChange={(value) =>
                    setClientToolCache(Boolean(value))
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`grok-headers-${credential.id}`}>
                  自定义请求头
                </FieldLabel>
                <Textarea
                  id={`grok-headers-${credential.id}`}
                  value={headersText}
                  onChange={(event) => setHeadersText(event.target.value)}
                  placeholder={'{\n  "X-Custom-Header": "value"\n}'}
                />
                <FieldDescription>
                  JSON 对象。认证、Host、Content-Type 等安全敏感请求头不可覆盖。
                </FieldDescription>
              </Field>
            </FieldGroup>
          </TabsContent>
          <TabsContent value="models">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`grok-aliases-${credential.id}`}>
                  模型别名
                </FieldLabel>
                <Textarea
                  id={`grok-aliases-${credential.id}`}
                  value={modelAliasesText}
                  onChange={(event) => setModelAliasesText(event.target.value)}
                  placeholder="可选；通常留空并直接使用上游模型名"
                />
                <FieldDescription>
                  仅用于兼容旧客户端；正常情况下直接使用上游模型目录返回的名称。
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={`grok-excluded-${credential.id}`}>
                  排除模型
                </FieldLabel>
                <Textarea
                  id={`grok-excluded-${credential.id}`}
                  value={excludedModelsText}
                  onChange={(event) =>
                    setExcludedModelsText(event.target.value)
                  }
                  placeholder={"grok-*\n*-preview"}
                />
                <FieldDescription>
                  每行一个模型或通配模式。命中后该凭据不会参与该模型的分发。
                </FieldDescription>
              </Field>
            </FieldGroup>
          </TabsContent>
        </Tabs>
        <DialogFooter className="flex-wrap">
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => void onDeleted()}
          >
            删除
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => void onCreateChannel()}
          >
            创建路由池
          </Button>
          <Button type="button" disabled={pending} onClick={() => void save()}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function jsonObject(value: string, label: string) {
  if (!value.trim()) return {};
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${label}必须是 JSON 对象`);
  return parsed as Record<string, string>;
}

"use client";
import * as React from "react";
import { toast } from "sonner";
import { SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { WorkspaceStatusBadge } from "@/components/workspace/status-badge";
import { formatDateTime } from "@/components/workspace/format";
import type { GrokCredentialRecord } from "@/src/shared/types/entities";
import type { GrokQuotaReport } from "@/src/server/services/grokQuota";

export function GrokCredentialCards() {
  const [items, setItems] = React.useState<GrokCredentialRecord[]>([]);
  const [quotas, setQuotas] = React.useState<Record<string, GrokQuotaReport>>({});
  const [quotaErrors, setQuotaErrors] = React.useState<Record<string, string>>({});
  const [quotaLoading, setQuotaLoading] = React.useState<Set<string>>(new Set());
  const loadQuota = React.useCallback(async (credential: GrokCredentialRecord) => {
    if (credential.authType !== "oauth") return;
    setQuotaLoading((current) => new Set(current).add(credential.id));
    try { const response = await fetch(`/api/admin/grok/credentials/${credential.id}/quota`); if (!response.ok) throw new Error(await errorText(response)); const report: GrokQuotaReport = await response.json(); setQuotas((current) => ({ ...current, [credential.id]: report })); setQuotaErrors((current) => { const next = { ...current }; delete next[credential.id]; return next; }); }
    catch (error) { setQuotaErrors((current) => ({ ...current, [credential.id]: error instanceof Error ? error.message : String(error) })); }
    finally { setQuotaLoading((current) => { const next = new Set(current); next.delete(credential.id); return next; }); }
  }, []);
  const load = React.useCallback(async () => {
    const response = await fetch("/api/admin/grok/credentials");
    if (response.ok) { const next: GrokCredentialRecord[] = await response.json(); setItems(next); await Promise.all(next.map(loadQuota)); }
  }, [loadQuota]);
  React.useEffect(() => {
    let active = true;
    void fetch("/api/admin/grok/credentials").then(async (response) => {
      if (active && response.ok) setItems(await response.json());
    });
    return () => { active = false; };
  }, []);
  React.useEffect(() => { const reload = () => void load(); window.addEventListener("grok-credentials-changed", reload); window.addEventListener("grok-quota-refresh", reload); return () => { window.removeEventListener("grok-credentials-changed", reload); window.removeEventListener("grok-quota-refresh", reload); }; }, [load]);
  async function createChannel(credential: GrokCredentialRecord) { const response = await fetch("/api/admin/channels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "grok", name: `Grok · ${credential.email || credential.subject || credential.id}`, credentialIds: [credential.id], baseUrl: credential.authType === "oauth" ? "https://cli-chat-proxy.grok.com/v1" : "https://api.x.ai/v1", modelAllowlist: ["grok-4.5", "grok-4.3"] }) }); if (!response.ok) return toast.error(await errorText(response)); toast.success("Grok 通道已创建，刷新页面后可见"); }
  async function remove(id: string) { const response = await fetch(`/api/admin/grok/credentials/${id}`, { method: "DELETE" }); if (!response.ok) return toast.error(await errorText(response)); await load(); }
  return <>{items.map((item) => {
    const name = item.email || item.subject || item.id;
    return <Card key={item.id} className="relative shadow-sm">
      <CardContent className="grid gap-3">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <div className="flex min-w-0 items-center gap-2 overflow-hidden">
            <Badge variant="outline" className="h-6 shrink-0 px-2 text-sm font-semibold">Grok</Badge>
            <div className="min-w-0 flex-1 truncate text-base font-medium" title={name}>{name}</div>
          </div>
          <GrokSettingsDialog credential={item} onCreateChannel={() => createChannel(item)} onDeleted={() => remove(item.id)} onSaved={load} />
        </div>
        {!item.enabled && <div className="flex flex-wrap gap-1.5"><WorkspaceStatusBadge tone="muted">off</WorkspaceStatusBadge></div>}
        <div className="grid gap-2 text-sm">
          <div className="flex items-center gap-2"><span className="shrink-0 text-muted-foreground">用量采样：</span><WorkspaceStatusBadge tone={item.lastError ? "danger" : "muted"}>{item.lastError ? "error" : "unknown"}</WorkspaceStatusBadge></div>
          {item.cooldownUntil && <div className="flex items-center gap-2 text-xs text-muted-foreground"><WorkspaceStatusBadge tone="warning">cooldown</WorkspaceStatusBadge>{formatDateTime(item.cooldownUntil)}</div>}
          {item.lastError && <div className="text-xs text-destructive">{item.lastError}</div>}
        </div>
        <div className="flex items-center gap-2 text-sm"><span className="shrink-0 text-muted-foreground">请求代理：</span><Badge variant="outline">{item.useGlobalProxy ? "跟随全局" : item.proxy ? "独立代理" : "直连"}</Badge></div>
        <div className="flex items-center gap-2 text-sm"><span className="shrink-0 text-muted-foreground">过期时间：</span><span className="min-w-0 truncate">{item.expiresAt ? formatDateTime(item.expiresAt) : "-"}</span></div>
        <div className="grid gap-2 text-sm">
          <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground">剩余额度：</span><Button type="button" variant="ghost" size="sm" disabled={quotaLoading.has(item.id) || item.authType !== "oauth"} onClick={() => void loadQuota(item)}>刷新</Button></div>
          <div className="rounded-lg border border-border/60 bg-muted/35 p-3"><GrokQuotaProgress report={quotas[item.id]} error={quotaErrors[item.id]} apiKey={item.authType === "api_key"} /></div>
        </div>
      </CardContent>
    </Card>;
  })}</>;
}
async function errorText(response: Response) { try { const body = await response.json(); return body?.error?.message || body?.message || `请求失败 (${response.status})`; } catch { return `请求失败 (${response.status})`; } }

function GrokQuotaProgress({ report, error, apiKey }: { report?: GrokQuotaReport; error?: string; apiKey: boolean }) {
  if (apiKey) return <div className="text-xs text-muted-foreground">xAI API Key 的额度由 API 账单管理，不提供订阅余额。</div>;
  if (error) return <div className="text-xs text-destructive">{error}</div>;
  if (!report) return <div className="text-xs text-muted-foreground">正在读取 Grok 上游额度…</div>;
  const windows = [report.weekly, report.monthly, report.rateLimit].filter((window) => window && (window.usedPercent !== null || window.remainingPercent !== null));
  if (!windows.length) return <div className="text-xs text-muted-foreground">Grok 上游未返回可计算的额度。</div>;
  return <div className="grid gap-3">{windows.map((window) => {
    const label = window!.label;
    const used = window!.usedPercent;
    return <div key={label} className="grid gap-1"><div className="flex items-center justify-between text-xs"><span className="font-medium">{label}</span><span className="text-muted-foreground">{window!.remainingPercent !== null ? `${Math.round(window!.remainingPercent! * 10) / 10}% 可用` : "上游未返回"}</span></div><Progress value={used ?? 0} />{window!.resetsAt && <div className="text-xs text-muted-foreground">重置 {formatDateTime(window!.resetsAt)}</div>}</div>;
  })}</div>;
}

function GrokSettingsDialog({ credential, onCreateChannel, onDeleted, onSaved }: { credential: GrokCredentialRecord; onCreateChannel: () => Promise<unknown>; onDeleted: () => Promise<unknown>; onSaved: () => Promise<void> }) {
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [enabled, setEnabled] = React.useState(credential.enabled);
  const [priority, setPriority] = React.useState(String(credential.priority));
  const [weight, setWeight] = React.useState(String(credential.weight));
  const [transport, setTransport] = React.useState(credential.upstreamTransport);
  const [baseUrl, setBaseUrl] = React.useState(credential.grokBaseUrl || "");
  const [nativeXSearch, setNativeXSearch] = React.useState(credential.grokNativeXSearch);
  const [clientToolCache, setClientToolCache] = React.useState(credential.grokClientToolCache);
  const [headersText, setHeadersText] = React.useState(Object.keys(credential.grokHeaders).length ? JSON.stringify(credential.grokHeaders, null, 2) : "");
  const [modelAliasesText, setModelAliasesText] = React.useState(Object.keys(credential.grokModelAliases).length ? JSON.stringify(credential.grokModelAliases, null, 2) : "");
  const [excludedModelsText, setExcludedModelsText] = React.useState(credential.grokExcludedModels.join("\n"));
  async function save() { setPending(true); try { const grokHeaders = jsonObject(headersText, "自定义请求头"); const grokModelAliases = jsonObject(modelAliasesText, "模型别名"); const response = await fetch(`/api/admin/grok/credentials/${credential.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled, priority: Number(priority), weight: Number(weight), upstreamTransport: transport, grokBaseUrl: baseUrl, grokNativeXSearch: nativeXSearch, grokClientToolCache: clientToolCache, grokHeaders, grokModelAliases, grokExcludedModels: excludedModelsText }) }); if (!response.ok) throw new Error(await errorText(response)); await onSaved(); setOpen(false); toast.success("Grok 凭据设置已保存"); } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); } finally { setPending(false); } }
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger render={<Button type="button" variant="ghost" size="icon" aria-label="凭据设置" />}><SettingsIcon /></DialogTrigger><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>凭据设置</DialogTitle><DialogDescription>{credential.email || credential.subject || credential.id} · Grok</DialogDescription></DialogHeader><Tabs defaultValue="routing"><TabsList><TabsTrigger value="routing">分发</TabsTrigger><TabsTrigger value="grok">Grok</TabsTrigger><TabsTrigger value="models">模型</TabsTrigger></TabsList><TabsContent value="routing"><FieldGroup><Field orientation="horizontal"><FieldContent><FieldLabel htmlFor={`grok-enabled-${credential.id}`}>启用凭据</FieldLabel><FieldDescription>关闭后不再参与路由和订阅分发。</FieldDescription></FieldContent><Switch id={`grok-enabled-${credential.id}`} checked={enabled} onCheckedChange={(value) => setEnabled(Boolean(value))} /></Field><Field><FieldLabel htmlFor={`grok-priority-${credential.id}`}>优先级</FieldLabel><Input id={`grok-priority-${credential.id}`} inputMode="numeric" value={priority} onChange={(event) => setPriority(event.target.value)} /></Field><Field><FieldLabel htmlFor={`grok-weight-${credential.id}`}>权重</FieldLabel><Input id={`grok-weight-${credential.id}`} inputMode="numeric" value={weight} onChange={(event) => setWeight(event.target.value)} /></Field></FieldGroup></TabsContent><TabsContent value="grok"><FieldGroup><Field><FieldLabel>上游传输</FieldLabel><Select value={transport} onValueChange={(value) => setTransport(value as GrokCredentialRecord["upstreamTransport"])}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="auto">自动（WebSocket 失败回退 HTTP）</SelectItem><SelectItem value="websocket">仅 WebSocket</SelectItem><SelectItem value="http">仅 HTTP</SelectItem></SelectGroup></SelectContent></Select><FieldDescription>WebSocket 仅用于流式 Responses 请求；非流式请求始终使用 HTTP。</FieldDescription></Field><Field><FieldLabel htmlFor={`grok-base-url-${credential.id}`}>自定义上游地址</FieldLabel><Input id={`grok-base-url-${credential.id}`} placeholder={credential.authType === "oauth" ? "https://cli-chat-proxy.grok.com/v1" : "https://api.x.ai/v1"} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /><FieldDescription>改变对话和额度探测端点，不改变 OAuth 授权和令牌刷新地址。</FieldDescription></Field><Field orientation="horizontal"><FieldContent><FieldLabel htmlFor={`grok-x-search-${credential.id}`}>原生 X Search</FieldLabel><FieldDescription>自动向 Grok 提供 x_search；关闭后只保留客户端声明的受支持工具。</FieldDescription></FieldContent><Switch id={`grok-x-search-${credential.id}`} checked={nativeXSearch} onCheckedChange={(value) => setNativeXSearch(Boolean(value))} /></Field><Field orientation="horizontal"><FieldContent><FieldLabel htmlFor={`grok-tool-cache-${credential.id}`}>客户端工具缓存</FieldLabel><FieldDescription>保留 prompt_cache_key，提高多轮工具请求的上游缓存命中；关闭会移除该字段。</FieldDescription></FieldContent><Switch id={`grok-tool-cache-${credential.id}`} checked={clientToolCache} onCheckedChange={(value) => setClientToolCache(Boolean(value))} /></Field><Field><FieldLabel htmlFor={`grok-headers-${credential.id}`}>自定义请求头</FieldLabel><Textarea id={`grok-headers-${credential.id}`} value={headersText} onChange={(event) => setHeadersText(event.target.value)} placeholder={'{\n  "X-Custom-Header": "value"\n}'} /><FieldDescription>JSON 对象。认证、Host、Content-Type 等安全敏感请求头不可覆盖。</FieldDescription></Field></FieldGroup></TabsContent><TabsContent value="models"><FieldGroup><Field><FieldLabel htmlFor={`grok-aliases-${credential.id}`}>模型别名</FieldLabel><Textarea id={`grok-aliases-${credential.id}`} value={modelAliasesText} onChange={(event) => setModelAliasesText(event.target.value)} placeholder={'{\n  "grok-latest": "grok-4.5"\n}'} /><FieldDescription>JSON 对象：客户端模型名映射到上游模型名；响应中的模型名会还原为客户端别名。</FieldDescription></Field><Field><FieldLabel htmlFor={`grok-excluded-${credential.id}`}>排除模型</FieldLabel><Textarea id={`grok-excluded-${credential.id}`} value={excludedModelsText} onChange={(event) => setExcludedModelsText(event.target.value)} placeholder={'grok-3-*\n*-mini'} /><FieldDescription>每行一个模型或通配模式。命中后该凭据不会参与该模型的分发。</FieldDescription></Field></FieldGroup></TabsContent></Tabs><DialogFooter className="flex-wrap"><Button type="button" variant="destructive" disabled={pending} onClick={() => void onDeleted()}>删除</Button><Button type="button" variant="outline" disabled={pending} onClick={() => void onCreateChannel()}>创建路由池</Button><Button type="button" disabled={pending} onClick={() => void save()}>保存</Button></DialogFooter></DialogContent></Dialog>;
}

function jsonObject(value: string, label: string) { if (!value.trim()) return {}; const parsed: unknown = JSON.parse(value); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label}必须是 JSON 对象`); return parsed as Record<string, string>; }

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
  async function save() { setPending(true); try { const response = await fetch(`/api/admin/grok/credentials/${credential.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled, priority: Number(priority), weight: Number(weight) }) }); if (!response.ok) throw new Error(await errorText(response)); await onSaved(); setOpen(false); toast.success("Grok 凭据设置已保存"); } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); } finally { setPending(false); } }
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger render={<Button type="button" variant="ghost" size="icon" aria-label="凭据设置" />}><SettingsIcon /></DialogTrigger><DialogContent><DialogHeader><DialogTitle>凭据设置</DialogTitle><DialogDescription>{credential.email || credential.subject || credential.id} · Grok</DialogDescription></DialogHeader><FieldGroup><Field orientation="horizontal"><FieldContent><FieldLabel htmlFor={`grok-enabled-${credential.id}`}>启用凭据</FieldLabel><FieldDescription>关闭后不再参与路由和订阅分发。</FieldDescription></FieldContent><Switch id={`grok-enabled-${credential.id}`} checked={enabled} onCheckedChange={(value) => setEnabled(Boolean(value))} /></Field><Field><FieldLabel htmlFor={`grok-priority-${credential.id}`}>优先级</FieldLabel><Input id={`grok-priority-${credential.id}`} inputMode="numeric" value={priority} onChange={(event) => setPriority(event.target.value)} /></Field><Field><FieldLabel htmlFor={`grok-weight-${credential.id}`}>权重</FieldLabel><Input id={`grok-weight-${credential.id}`} inputMode="numeric" value={weight} onChange={(event) => setWeight(event.target.value)} /></Field></FieldGroup><DialogFooter className="flex-wrap"><Button type="button" variant="destructive" disabled={pending} onClick={() => void onDeleted()}>删除</Button><Button type="button" variant="outline" disabled={pending} onClick={() => void onCreateChannel()}>创建路由池</Button><Button type="button" disabled={pending} onClick={() => void save()}>保存</Button></DialogFooter></DialogContent></Dialog>;
}

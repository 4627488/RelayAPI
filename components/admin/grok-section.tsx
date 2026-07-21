"use client";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { WorkspaceStatusBadge } from "@/components/workspace/status-badge";
import { formatDateTime } from "@/components/workspace/format";
import type { GrokCredentialRecord } from "@/src/shared/types/entities";

export function GrokCredentialCards() {
  const [items, setItems] = React.useState<GrokCredentialRecord[]>([]);
  const load = React.useCallback(async () => { const response = await fetch("/api/admin/grok/credentials"); if (response.ok) setItems(await response.json()); }, []);
  React.useEffect(() => {
    let active = true;
    void fetch("/api/admin/grok/credentials").then(async (response) => {
      if (active && response.ok) setItems(await response.json());
    });
    return () => { active = false; };
  }, []);
  React.useEffect(() => { const reload = () => void load(); window.addEventListener("grok-credentials-changed", reload); return () => window.removeEventListener("grok-credentials-changed", reload); }, [load]);
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
          <Button type="button" size="sm" variant="outline" onClick={() => remove(item.id)}>删除</Button>
        </div>
        {!item.enabled && <div className="flex flex-wrap gap-1.5"><WorkspaceStatusBadge tone="muted">off</WorkspaceStatusBadge></div>}
        <div className="grid gap-2 text-sm">
          <div className="flex items-center gap-2"><span className="shrink-0 text-muted-foreground">用量采样：</span><WorkspaceStatusBadge tone={item.lastError ? "danger" : "muted"}>{item.lastError ? "error" : "unknown"}</WorkspaceStatusBadge></div>
          {item.cooldownUntil && <div className="flex items-center gap-2 text-xs text-muted-foreground"><WorkspaceStatusBadge tone="warning">cooldown</WorkspaceStatusBadge>{formatDateTime(item.cooldownUntil)}</div>}
          {item.lastError && <div className="text-xs text-destructive">{item.lastError}</div>}
        </div>
        <div className="flex items-center gap-2 text-sm"><span className="shrink-0 text-muted-foreground">请求代理：</span><Badge variant="outline">{item.useGlobalProxy ? "跟随全局" : item.proxy ? "独立代理" : "直连"}</Badge></div>
        <div className="flex items-center gap-2 text-sm"><span className="shrink-0 text-muted-foreground">过期时间：</span><span className="min-w-0 truncate">{item.expiresAt ? formatDateTime(item.expiresAt) : "-"}</span></div>
        <div className="grid gap-2 text-sm"><div className="flex items-center justify-between gap-2"><span className="text-muted-foreground">凭据类型：</span><Badge variant="secondary">{item.authType === "oauth" ? "订阅 OAuth" : "API Key"}</Badge></div><div className="rounded-lg border border-border/60 bg-muted/35 p-3 text-xs text-muted-foreground">优先级 {item.priority} · 权重 {item.weight}</div></div>
        <Button type="button" variant="outline" onClick={() => createChannel(item)}>创建路由池</Button>
      </CardContent>
    </Card>;
  })}</>;
}
async function errorText(response: Response) { try { const body = await response.json(); return body?.error?.message || body?.message || `请求失败 (${response.status})`; } catch { return `请求失败 (${response.status})`; } }

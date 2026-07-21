"use client";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import type { GrokCredentialRecord } from "@/src/shared/types/entities";

export function GrokSection() {
  const [items, setItems] = React.useState<GrokCredentialRecord[]>([]); const [key, setKey] = React.useState(""); const [name, setName] = React.useState("");
  const [session, setSession] = React.useState<{ sessionId: string; userCode: string; verificationUriComplete: string; verificationUri: string } | null>(null);
  const load = React.useCallback(async () => { const response = await fetch("/api/admin/grok/credentials"); if (response.ok) setItems(await response.json()); }, []);
  React.useEffect(() => {
    let active = true;
    void fetch("/api/admin/grok/credentials").then(async (response) => {
      if (active && response.ok) setItems(await response.json());
    });
    return () => { active = false; };
  }, []);
  async function addKey() { const response = await fetch("/api/admin/grok/credentials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: key, name }) }); if (!response.ok) return toast.error(await errorText(response)); setKey(""); await load(); toast.success("Grok API Key 已添加"); }
  async function startOAuth() { const response = await fetch("/api/admin/grok/credentials/oauth/start", { method: "POST" }); if (!response.ok) return toast.error(await errorText(response)); const value = await response.json(); setSession(value); window.open(value.verificationUriComplete || value.verificationUri, "_blank", "noopener,noreferrer"); }
  async function pollOAuth() { if (!session) return; const response = await fetch("/api/admin/grok/credentials/oauth/poll", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: session.sessionId }) }); if (response.status === 202) return toast.info("仍在等待 Grok 授权"); if (!response.ok) return toast.error(await errorText(response)); setSession(null); await load(); toast.success("Grok 订阅已连接"); }
  async function createChannel(credential: GrokCredentialRecord) { const response = await fetch("/api/admin/channels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "grok", name: `Grok · ${credential.email || credential.subject || credential.id}`, credentialIds: [credential.id], baseUrl: credential.authType === "oauth" ? "https://cli-chat-proxy.grok.com/v1" : "https://api.x.ai/v1", modelAllowlist: ["grok-4.5", "grok-4.3"] }) }); if (!response.ok) return toast.error(await errorText(response)); toast.success("Grok 通道已创建，刷新页面后可见"); }
  async function remove(id: string) { const response = await fetch(`/api/admin/grok/credentials/${id}`, { method: "DELETE" }); if (!response.ok) return toast.error(await errorText(response)); await load(); }
  return <div className="mt-4 flex flex-col gap-4">
    <Separator />
    <div className="flex flex-wrap items-center justify-between gap-2"><div><div className="font-medium">Grok</div><div className="text-sm text-muted-foreground">与 Codex 共用订阅分配、路由池和额度工作台。</div></div><div className="flex flex-wrap gap-2"><Button onClick={startOAuth}>连接 Grok 订阅</Button>{session && <><span className="self-center font-mono text-sm">验证码 {session.userCode}</span><Button variant="outline" onClick={pollOAuth}>我已授权</Button></>}</div></div>
    <FieldGroup className="grid md:grid-cols-[1fr_2fr_auto]">
      <Field><FieldLabel htmlFor="grok-key-name">名称</FieldLabel><Input id="grok-key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="可选"/></Field>
      <Field><FieldLabel htmlFor="grok-api-key">xAI API Key</FieldLabel><Input id="grok-api-key" type="password" value={key} onChange={(e) => setKey(e.target.value)} /></Field>
      <Field className="justify-end"><Button onClick={addKey} disabled={!key.trim()}>添加 API Key</Button></Field>
    </FieldGroup>
    <div className="grid gap-2">{items.length ? items.map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-3"><div><div className="font-medium">{item.email || item.subject || item.id}</div><div className="text-sm text-muted-foreground">{item.authType === "oauth" ? "Grok 订阅 OAuth" : "xAI API Key"} · 权重 {item.weight}</div></div><div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => createChannel(item)}>创建通道</Button><Button size="sm" variant="destructive" onClick={() => remove(item.id)}>删除</Button></div></div>) : <div className="text-sm text-muted-foreground">尚未添加 Grok 凭据。</div>}</div>
  </div>;
}
async function errorText(response: Response) { try { const body = await response.json(); return body?.error?.message || body?.message || `请求失败 (${response.status})`; } catch { return `请求失败 (${response.status})`; } }

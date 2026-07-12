"use client";

import * as React from "react";
import { AlertTriangleIcon, CheckIcon, PlusIcon, RefreshCwIcon, SaveIcon, Trash2Icon, UsersIcon } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  adminErrorMessage,
  createTenantSubscription,
  deleteTenantSubscription,
  listTenantSubscriptions,
  updateTenantSubscription,
  type TenantSubscriptionRecord,
} from "@/lib/admin-api";
import { codexPlanLabel, codexPlanShares } from "@/src/shared/codexPlans";
import type { CodexCredentialRecord, PublicTenant } from "@/src/shared/types/entities";

type Draft = { id: string; tenantId: string; units: number };
type EditDraft = { units: number; priority: number; enabled: boolean };

export function SubscriptionAllocationSection({ credentials, tenants }: { credentials: CodexCredentialRecord[]; tenants: PublicTenant[] }) {
  const [credentialId, setCredentialId] = React.useState<string | null>(null);
  const [subscriptions, setSubscriptions] = React.useState<TenantSubscriptionRecord[]>([]);
  const [drafts, setDrafts] = React.useState<Draft[]>([]);
  const [edits, setEdits] = React.useState<Record<string, EditDraft>>({});
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [savingId, setSavingId] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const items = await listTenantSubscriptions();
      setSubscriptions(items);
      setEdits(Object.fromEntries(items.map((item) => [item.id, editFrom(item)])));
    } catch (error) { toast.error(adminErrorMessage(error)); }
    finally { setLoading(false); }
  }, []);

  React.useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void load(); });
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  const credential = credentials.find((item) => item.id === credentialId);
  const denominator = credential ? codexPlanShares(credential.planType) : 1;
  const assigned = credentialId ? subscriptions.filter((item) => item.credentialId === credentialId && item.enabled) : [];
  const currentUnits = assigned.reduce((sum, item) => sum + item.units / item.unitsPerCredential, 0) * denominator;
  const draftUnits = drafts.reduce((sum, item) => sum + item.units, 0);
  const totalUnits = currentUnits + draftUnits;
  const ratio = denominator ? totalUnits / denominator : 0;
  const availableTenants = tenants.filter((tenant) => tenant.enabled);

  function addDraft() {
    const usedIds = new Set(drafts.map((item) => item.tenantId));
    const tenant = availableTenants.find((item) => !usedIds.has(item.id));
    if (!tenant) { toast.info("没有更多可选租户"); return; }
    setDrafts((items) => [...items, { id: crypto.randomUUID(), tenantId: tenant.id, units: 1 }]);
  }

  async function saveAll() {
    if (!credential || drafts.length === 0) return;
    setSaving(true);
    try {
      for (const draft of drafts) {
        const tenant = tenants.find((item) => item.id === draft.tenantId);
        await createTenantSubscription({ tenantId: draft.tenantId, credentialId: credential.id, name: `${codexPlanLabel(credential.planType)} · ${tenant?.name || "子订阅"}`, units: draft.units, unitsPerCredential: denominator });
      }
      setDrafts([]);
      await load();
      toast.success(`已批量下发 ${drafts.length} 个子订阅`);
    } catch (error) { toast.error(adminErrorMessage(error)); }
    finally { setSaving(false); }
  }

  async function saveItem(item: TenantSubscriptionRecord) {
    const edit = edits[item.id];
    if (!edit) return;
    setSavingId(item.id);
    try {
      const updated = await updateTenantSubscription(item.id, edit);
      setSubscriptions((items) => items.map((current) => current.id === item.id ? { ...updated, quota: current.quota } : current));
      setEdits((current) => ({ ...current, [item.id]: editFrom(updated) }));
      toast.success("子订阅已更新");
    } catch (error) { toast.error(adminErrorMessage(error)); }
    finally { setSavingId(null); }
  }

  async function remove(item: TenantSubscriptionRecord) {
    setRemoving(item.id);
    try {
      await deleteTenantSubscription(item.id);
      setSubscriptions((items) => items.filter((current) => current.id !== item.id));
      toast.success("子订阅已收回");
    } catch (error) { toast.error(adminErrorMessage(error)); }
    finally { setRemoving(null); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>订阅分配</CardTitle>
        <CardDescription>分配父订阅容量，并集中维护已下发的子订阅及其本地用量。</CardDescription>
        <CardAction><Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}>{loading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}刷新</Button></CardAction>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="allocation">
          <TabsList>
            <TabsTrigger value="allocation">父订阅分配</TabsTrigger>
            <TabsTrigger value="subscriptions">子订阅管理 <Badge variant="secondary">{subscriptions.length}</Badge></TabsTrigger>
          </TabsList>
          <TabsContent value="allocation" className="flex flex-col gap-5 pt-4">
            <FieldGroup><Field><FieldLabel>父订阅</FieldLabel><Select value={credentialId} onValueChange={(value) => { setCredentialId(value); setDrafts([]); }}><SelectTrigger className="w-full"><SelectValue placeholder="选择一个上游账号 / 父订阅" /></SelectTrigger><SelectContent><SelectGroup>{credentials.map((item) => { const used = subscriptions.filter((sub) => sub.credentialId === item.id && sub.enabled).reduce((sum, sub) => sum + sub.units / sub.unitsPerCredential, 0); return <SelectItem key={item.id} value={item.id} disabled={!item.enabled}>{item.email || item.accountId || item.id} · {codexPlanLabel(item.planType)} · 已分配 {percent(used)}</SelectItem>; })}</SelectGroup></SelectContent></Select><FieldDescription>计划类型自动决定整份拆分数；允许超卖，但子订阅会共享实际上游额度。</FieldDescription></Field></FieldGroup>
            {credential ? <>
              <div className="grid gap-3 sm:grid-cols-3"><Metric label="物理容量" value={`${denominator} 份`} /><Metric label="配置后分配" value={`${trim(totalUnits)} 份`} /><Metric label="售卖比例" value={percent(ratio)} badge={ratio > 1 ? "超卖" : "容量内"} /></div>
              <Progress value={Math.min(100, ratio * 100)} />
              {ratio > 1 ? <Alert variant="destructive"><AlertTriangleIcon /><AlertTitle>当前将超卖 {percent(ratio - 1)}</AlertTitle><AlertDescription>这些子订阅会共享同一个父订阅的实际上游额度。</AlertDescription></Alert> : null}
              <div className="flex items-center justify-between gap-3"><div><div className="font-medium">批量分配清单</div><div className="text-sm text-muted-foreground">连续添加租户和份数，然后一次下发。</div></div><Button type="button" variant="outline" onClick={addDraft}><PlusIcon data-icon="inline-start" />添加租户</Button></div>
              {drafts.length ? <Table><TableHeader><TableRow><TableHead>租户</TableHead><TableHead>分配份数</TableHead><TableHead>占父订阅</TableHead><TableHead /></TableRow></TableHeader><TableBody>{drafts.map((draft) => <TableRow key={draft.id}><TableCell><Select value={draft.tenantId} onValueChange={(value) => setDrafts((items) => items.map((item) => item.id === draft.id ? { ...item, tenantId: value || item.tenantId } : item))}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{availableTenants.map((tenant) => <SelectItem key={tenant.id} value={tenant.id}>{tenant.name}{tenant.ownerEmail ? ` · ${tenant.ownerEmail}` : ""}</SelectItem>)}</SelectGroup></SelectContent></Select></TableCell><TableCell><Select value={String(draft.units)} onValueChange={(value) => setDrafts((items) => items.map((item) => item.id === draft.id ? { ...item, units: Number(value) || 1 } : item))}><SelectTrigger className="w-32"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{shareOptions(denominator).map((units) => <SelectItem key={units} value={String(units)}>{units} 份</SelectItem>)}</SelectGroup></SelectContent></Select></TableCell><TableCell>{percent(draft.units / denominator)}</TableCell><TableCell className="text-right"><Button type="button" variant="ghost" size="icon" aria-label="移除待分配租户" onClick={() => setDrafts((items) => items.filter((item) => item.id !== draft.id))}><Trash2Icon /></Button></TableCell></TableRow>)}</TableBody></Table> : null}
              <div className="flex justify-end"><Button type="button" onClick={() => void saveAll()} disabled={saving || drafts.length === 0}>{saving ? <Spinner data-icon="inline-start" /> : <UsersIcon data-icon="inline-start" />}批量下发 {drafts.length || ""}</Button></div>
            </> : null}
          </TabsContent>
          <TabsContent value="subscriptions" className="pt-4">
            {loading ? <div className="flex h-32 items-center justify-center"><Spinner /></div> : subscriptions.length === 0 ? <div className="py-10 text-center text-sm text-muted-foreground">还没有子订阅。</div> : <Table><TableHeader><TableRow><TableHead>租户 / 父订阅</TableHead><TableHead>用量</TableHead><TableHead className="w-24">份数</TableHead><TableHead className="w-24">优先级</TableHead><TableHead className="w-20">启用</TableHead><TableHead className="w-24" /></TableRow></TableHeader><TableBody>{subscriptions.map((item) => { const edit = edits[item.id] || editFrom(item); const dirty = edit.units !== item.units || edit.priority !== item.priority || edit.enabled !== item.enabled; const tenant = tenants.find((value) => value.id === item.tenantId); const parent = credentials.find((value) => value.id === item.credentialId); return <TableRow key={item.id}><TableCell><div className="font-medium">{tenant?.name || item.tenantId}</div><div className="mt-0.5 max-w-64 truncate text-xs text-muted-foreground">{parent?.email || parent?.accountId || item.credentialId} · {item.name}</div></TableCell><TableCell><QuotaUsage item={item} /></TableCell><TableCell><Input type="number" min={1} value={edit.units} onChange={(event) => setEdits((current) => ({ ...current, [item.id]: { ...edit, units: Math.max(1, Number(event.target.value) || 1) } }))} /></TableCell><TableCell><Input type="number" value={edit.priority} onChange={(event) => setEdits((current) => ({ ...current, [item.id]: { ...edit, priority: Number(event.target.value) || 0 } }))} /></TableCell><TableCell><Switch checked={edit.enabled} onCheckedChange={(checked) => setEdits((current) => ({ ...current, [item.id]: { ...edit, enabled: checked } }))} aria-label={`${tenant?.name || item.tenantId} 启用状态`} /></TableCell><TableCell><div className="flex justify-end gap-1"><Button type="button" variant={dirty ? "default" : "ghost"} size="icon" disabled={!dirty || savingId === item.id} aria-label="保存子订阅" onClick={() => void saveItem(item)}>{savingId === item.id ? <Spinner /> : dirty ? <SaveIcon /> : <CheckIcon />}</Button><Button type="button" variant="ghost" size="icon" disabled={removing === item.id} aria-label="收回子订阅" onClick={() => void remove(item)}>{removing === item.id ? <Spinner /> : <Trash2Icon />}</Button></div></TableCell></TableRow>; })}</TableBody></Table>}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function QuotaUsage({ item }: { item: TenantSubscriptionRecord }) {
  return <div className="flex min-w-40 flex-col gap-2">{(["5h", "7d"] as const).map((kind) => { const window = item.quota?.[kind]; if (!window) return <div key={kind} className="flex items-center gap-2 text-[10px] text-muted-foreground"><span className="w-5 font-mono">{kind}</span><div className="h-1.5 flex-1 rounded-full bg-muted" /><span>待产生</span></div>; const limit = Number(window.limitNanoUsd); const used = Number(window.settledNanoUsd) + Number(window.reservedNanoUsd); const ratio = limit > 0 ? Math.min(1, used / limit) : 0; return <div key={kind} className="flex items-center gap-2 text-[10px]"><span className="w-5 font-mono text-muted-foreground">{kind}</span><Progress value={ratio * 100} className="h-1.5 flex-1" /><span className="w-9 text-right font-mono">{percent(ratio)}</span></div>; })}</div>;
}

function editFrom(item: TenantSubscriptionRecord): EditDraft { return { units: item.units, priority: item.priority, enabled: item.enabled }; }
function Metric({ label, value, badge }: { label: string; value: string; badge?: string }) { return <Card size="sm"><CardHeader><CardDescription>{label}</CardDescription><CardTitle>{value}</CardTitle>{badge ? <CardAction><Badge variant={badge === "超卖" ? "destructive" : "secondary"}>{badge}</Badge></CardAction> : null}</CardHeader></Card>; }
function percent(value: number) { return `${Math.round(value * 1000) / 10}%`; }
function trim(value: number) { return Math.round(value * 100) / 100; }
function shareOptions(total: number) { return Array.from(new Set([1, 2, 3, 5, 10, total].filter((value) => value > 0 && value <= Math.max(total, 10)))).sort((a, b) => a - b); }

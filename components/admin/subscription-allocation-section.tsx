"use client";

import * as React from "react";
import { AlertTriangleIcon, PlusIcon, RefreshCwIcon, Trash2Icon, UsersIcon } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  adminErrorMessage,
  createTenantSubscription,
  deleteTenantSubscription,
  listTenantSubscriptions,
  type TenantSubscriptionRecord,
} from "@/lib/admin-api";
import { codexPlanLabel, codexPlanShares } from "@/src/shared/codexPlans";
import type { CodexCredentialRecord, PublicTenant } from "@/src/shared/types/entities";

type Draft = { id: string; tenantId: string; units: number };

export function SubscriptionAllocationSection({ credentials, tenants }: { credentials: CodexCredentialRecord[]; tenants: PublicTenant[] }) {
  const [credentialId, setCredentialId] = React.useState<string | null>(null);
  const [subscriptions, setSubscriptions] = React.useState<TenantSubscriptionRecord[]>([]);
  const [drafts, setDrafts] = React.useState<Draft[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [removing, setRemoving] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try { setSubscriptions(await listTenantSubscriptions()); }
    catch (error) { toast.error(adminErrorMessage(error)); }
    finally { setLoading(false); }
  }, []);

  React.useEffect(() => {
    let active = true;
    void listTenantSubscriptions()
      .then((items) => { if (active) setSubscriptions(items); })
      .catch((error) => { if (active) toast.error(adminErrorMessage(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const credential = credentials.find((item) => item.id === credentialId);
  const denominator = credential ? codexPlanShares(credential.planType) : 1;
  const assigned = credentialId ? subscriptions.filter((item) => item.credentialId === credentialId && item.enabled) : [];
  const currentUnits = assigned.reduce((sum, item) => sum + item.units / item.unitsPerCredential, 0) * denominator;
  const draftUnits = drafts.reduce((sum, item) => sum + item.units, 0);
  const totalUnits = currentUnits + draftUnits;
  const ratio = denominator ? totalUnits / denominator : 0;
  const availableTenants = tenants.filter((tenant) => tenant.enabled);

  function selectCredential(value: string | null) {
    setCredentialId(value);
    setDrafts([]);
  }

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
      const created: TenantSubscriptionRecord[] = [];
      for (const draft of drafts) {
        const tenant = tenants.find((item) => item.id === draft.tenantId);
        created.push(await createTenantSubscription({
          tenantId: draft.tenantId,
          credentialId: credential.id,
          name: `${codexPlanLabel(credential.planType)} · ${tenant?.name || "子订阅"}`,
          units: draft.units,
          unitsPerCredential: denominator,
        }));
      }
      setSubscriptions((items) => [...created, ...items]);
      setDrafts([]);
      toast.success(`已批量下发 ${created.length} 个子订阅`);
    } catch (error) { toast.error(adminErrorMessage(error)); }
    finally { setSaving(false); }
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

  return <Card>
    <CardHeader>
      <CardTitle>父订阅分配</CardTitle>
      <CardDescription>选一个上游订阅，连续选择租户和份数后一次下发。允许超卖，系统不会阻止超过物理容量的配置。</CardDescription>
      <CardAction><Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}>{loading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}刷新</Button></CardAction>
    </CardHeader>
    <CardContent className="flex flex-col gap-5">
      <FieldGroup>
        <Field>
          <FieldLabel>父订阅</FieldLabel>
          <Select value={credentialId} onValueChange={selectCredential}>
            <SelectTrigger className="w-full"><SelectValue placeholder="选择一个上游账号 / 父订阅" /></SelectTrigger>
            <SelectContent><SelectGroup>{credentials.map((item) => {
              const used = subscriptions.filter((sub) => sub.credentialId === item.id && sub.enabled).reduce((sum, sub) => sum + sub.units / sub.unitsPerCredential, 0);
              return <SelectItem key={item.id} value={item.id} disabled={!item.enabled}>{item.email || item.accountId || item.id} · {codexPlanLabel(item.planType)} · 已分配 {percent(used)}</SelectItem>;
            })}</SelectGroup></SelectContent>
          </Select>
          <FieldDescription>计划类型会自动决定整份拆分数：Plus 1 份、Pro 5x 5 份、Pro 20x 20 份。</FieldDescription>
        </Field>
      </FieldGroup>

      {credential && <>
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="物理容量" value={`${denominator} 份`} />
          <Metric label="配置后分配" value={`${trim(totalUnits)} 份`} />
          <Metric label="售卖比例" value={percent(ratio)} badge={ratio > 1 ? "超卖" : "容量内"} />
        </div>
        <Progress value={Math.min(100, ratio * 100)} />
        {ratio > 1 && <Alert variant="destructive"><AlertTriangleIcon /><AlertTitle>当前将超卖 {percent(ratio - 1)}</AlertTitle><AlertDescription>这是允许的配置；这些子订阅会共享同一个父订阅的实际上游额度。</AlertDescription></Alert>}

        <div className="flex items-center justify-between gap-3">
          <div><div className="font-medium">批量分配清单</div><div className="text-sm text-muted-foreground">租户和份数都用选项完成，名称按“计划 · 租户”自动生成。</div></div>
          <Button type="button" variant="outline" onClick={addDraft}><PlusIcon data-icon="inline-start" />添加租户</Button>
        </div>
        {drafts.length > 0 && <Table><TableHeader><TableRow><TableHead>租户</TableHead><TableHead>分配份数</TableHead><TableHead>占父订阅</TableHead><TableHead /></TableRow></TableHeader><TableBody>{drafts.map((draft) => <TableRow key={draft.id}>
          <TableCell><Select value={draft.tenantId} onValueChange={(value) => setDrafts((items) => items.map((item) => item.id === draft.id ? { ...item, tenantId: value || item.tenantId } : item))}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{availableTenants.map((tenant) => <SelectItem key={tenant.id} value={tenant.id}>{tenant.name}{tenant.ownerEmail ? ` · ${tenant.ownerEmail}` : ""}</SelectItem>)}</SelectGroup></SelectContent></Select></TableCell>
          <TableCell><Select value={String(draft.units)} onValueChange={(value) => setDrafts((items) => items.map((item) => item.id === draft.id ? { ...item, units: Number(value) || 1 } : item))}><SelectTrigger className="w-32"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{shareOptions(denominator).map((units) => <SelectItem key={units} value={String(units)}>{units} 份</SelectItem>)}</SelectGroup></SelectContent></Select></TableCell>
          <TableCell>{percent(draft.units / denominator)}</TableCell><TableCell className="text-right"><Button type="button" variant="ghost" size="icon" aria-label="移除待分配租户" onClick={() => setDrafts((items) => items.filter((item) => item.id !== draft.id))}><Trash2Icon /></Button></TableCell>
        </TableRow>)}</TableBody></Table>}
        <div className="flex justify-end"><Button type="button" onClick={() => void saveAll()} disabled={saving || drafts.length === 0}>{saving ? <Spinner data-icon="inline-start" /> : <UsersIcon data-icon="inline-start" />}批量下发 {drafts.length || ""}</Button></div>

        <div className="flex flex-col gap-2"><div className="font-medium">已下发子订阅</div>{assigned.length === 0 ? <div className="text-sm text-muted-foreground">这个父订阅还没有分配给任何人。</div> : <Table><TableHeader><TableRow><TableHead>租户</TableHead><TableHead>份额</TableHead><TableHead>占比</TableHead><TableHead>状态</TableHead><TableHead /></TableRow></TableHeader><TableBody>{assigned.map((item) => <TableRow key={item.id}><TableCell>{tenants.find((tenant) => tenant.id === item.tenantId)?.name || item.tenantId}</TableCell><TableCell>{item.units}/{item.unitsPerCredential}</TableCell><TableCell>{percent(item.units / item.unitsPerCredential)}</TableCell><TableCell><Badge variant="secondary">启用</Badge></TableCell><TableCell className="text-right"><Button type="button" variant="outline" size="icon" aria-label="收回子订阅" disabled={removing === item.id} onClick={() => void remove(item)}>{removing === item.id ? <Spinner /> : <Trash2Icon />}</Button></TableCell></TableRow>)}</TableBody></Table>}</div>
      </>}
    </CardContent>
  </Card>;
}

function Metric({ label, value, badge }: { label: string; value: string; badge?: string }) { return <Card size="sm"><CardHeader><CardDescription>{label}</CardDescription><CardTitle>{value}</CardTitle>{badge && <CardAction><Badge variant={badge === "超卖" ? "destructive" : "secondary"}>{badge}</Badge></CardAction>}</CardHeader></Card>; }
function percent(value: number) { return `${Math.round(value * 1000) / 10}%`; }
function trim(value: number) { return Math.round(value * 100) / 100; }
function shareOptions(total: number) { return Array.from(new Set([1, 2, 3, 5, 10, total].filter((value) => value > 0 && value <= Math.max(total, 10)))).sort((a, b) => a - b); }

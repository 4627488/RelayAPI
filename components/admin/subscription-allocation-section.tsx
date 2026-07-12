"use client";

import * as React from "react";
import {
  AlertTriangleIcon,
  BoxesIcon,
  CheckIcon,
  GaugeIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  adminErrorMessage,
  createTenantSubscription,
  deleteTenantSubscription,
  getSubscriptionAllocationOverview,
  updateTenantSubscription,
  type SubscriptionAllocationOverview,
  type SubscriptionCapacityPool,
  type TenantSubscriptionRecord,
} from "@/lib/admin-api";
import { codexPlanLabel } from "@/src/shared/codexPlans";
import type { PublicTenant } from "@/src/shared/types/entities";

type AllocationDraft = { tenantId: string; units: number; priority: number };
type EditDraft = { units: number; priority: number; enabled: boolean };

const EMPTY_DRAFT: AllocationDraft = { tenantId: "", units: 1, priority: 100 };

export function SubscriptionAllocationSection({ tenants }: { tenants: PublicTenant[] }) {
  const [overview, setOverview] = React.useState<SubscriptionAllocationOverview | null>(null);
  const [selectedPoolId, setSelectedPoolId] = React.useState("");
  const [edits, setEdits] = React.useState<Record<string, EditDraft>>({});
  const [loading, setLoading] = React.useState(true);
  const [savingId, setSavingId] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [draft, setDraft] = React.useState(EMPTY_DRAFT);
  const [pendingDelete, setPendingDelete] = React.useState<TenantSubscriptionRecord | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const next = await getSubscriptionAllocationOverview();
      setOverview(next);
      setSelectedPoolId((current) => next.pools.some((pool) => pool.id === current) ? current : next.pools[0]?.id || "");
      setEdits(Object.fromEntries(next.pools.flatMap((pool) => pool.subscriptions.map((item) => [item.id, editFrom(item)]))));
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  const selectedPool = overview?.pools.find((pool) => pool.id === selectedPoolId) || null;
  const availableTenants = tenants.filter((tenant) => tenant.enabled);

  function openCreate() {
    setDraft({ ...EMPTY_DRAFT, tenantId: availableTenants[0]?.id || "" });
    setCreateOpen(true);
  }

  async function createAllocation() {
    if (!selectedPool || !draft.tenantId) return;
    setCreating(true);
    try {
      const tenant = tenants.find((item) => item.id === draft.tenantId);
      await createTenantSubscription({
        tenantId: draft.tenantId,
        credentialId: selectedPool.id,
        name: `${codexPlanLabel(selectedPool.planType)} · ${tenant?.name || "子订阅"}`,
        units: draft.units,
        priority: draft.priority,
      });
      setCreateOpen(false);
      await load();
      toast.success("分配已创建");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  async function saveAllocation(item: TenantSubscriptionRecord) {
    const edit = edits[item.id];
    if (!edit) return;
    setSavingId(item.id);
    try {
      await updateTenantSubscription(item.id, edit);
      await load();
      toast.success("分配已更新");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setSavingId(null);
    }
  }

  async function removeAllocation() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteTenantSubscription(pendingDelete.id);
      setPendingDelete(null);
      await load();
      toast.success("分配已回收");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>订阅容量工作台</CardTitle>
          <CardDescription>从 Codex 凭据容量池出发，分配、调整和回收租户子订阅。</CardDescription>
          <CardAction>
            <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void load()}>
              {loading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
              刷新
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {overview ? <Summary overview={overview} /> : null}
        </CardContent>
      </Card>

      {loading && !overview ? (
        <Card><CardContent className="flex min-h-72 items-center justify-center"><Spinner /></CardContent></Card>
      ) : !overview?.pools.length ? (
        <Card><CardContent><Empty className="min-h-72"><EmptyHeader><EmptyMedia variant="icon"><BoxesIcon /></EmptyMedia><EmptyTitle>还没有 Codex 凭据</EmptyTitle><EmptyDescription>先导入并启用凭据，才能建立可分配的容量池。</EmptyDescription></EmptyHeader></Empty></CardContent></Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[22rem_minmax(0,1fr)]">
          <Card>
            <CardHeader>
              <CardTitle>容量池</CardTitle>
              <CardDescription>选择一个凭据查看其租户分配。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {overview.pools.map((pool) => (
                <PoolButton key={pool.id} pool={pool} active={pool.id === selectedPoolId} onClick={() => setSelectedPoolId(pool.id)} />
              ))}
            </CardContent>
          </Card>

          {selectedPool ? (
            <PoolWorkspace
              pool={selectedPool}
              edits={edits}
              savingId={savingId}
              onEdit={(id, edit) => setEdits((current) => ({ ...current, [id]: edit }))}
              onSave={saveAllocation}
              onDelete={setPendingDelete}
              onCreate={openCreate}
            />
          ) : null}
        </div>
      )}

      <CreateAllocationDialog open={createOpen} pool={selectedPool} tenants={availableTenants} draft={draft} pending={creating} onDraftChange={setDraft} onOpenChange={setCreateOpen} onSubmit={createAllocation} />
      <AlertDialog open={Boolean(pendingDelete)} onOpenChange={(open) => { if (!open && !deleting) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>回收这条分配？</AlertDialogTitle><AlertDialogDescription>租户将立即失去通过该父凭据获得的额度；已有用量记录会保留。</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel><AlertDialogAction disabled={deleting} onClick={(event) => { event.preventDefault(); void removeAllocation(); }}>{deleting && <Spinner data-icon="inline-start" />}确认回收</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Summary({ overview }: { overview: SubscriptionAllocationOverview }) {
  const { summary } = overview;
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric icon={<BoxesIcon />} label="凭据容量池" value={`${summary.usableCredentialCount}/${summary.credentialCount}`} hint="可用 / 全部" /><Metric icon={<GaugeIcon />} label="总容量" value={`${summary.capacityUnits} 份`} hint="由计划类型自动换算" /><Metric icon={<UsersIcon />} label="已分配" value={`${summary.allocatedUnits} 份`} hint={summary.capacityUnits ? percent(summary.allocatedUnits / summary.capacityUnits) : "0%"} /><Metric icon={<AlertTriangleIcon />} label="超卖风险" value={`${summary.oversoldCredentialCount} 个`} hint="已超过物理份数的凭据" danger={summary.oversoldCredentialCount > 0} /></div>;
}

function PoolButton({ pool, active, onClick }: { pool: SubscriptionCapacityPool; active: boolean; onClick: () => void }) {
  const ratio = pool.capacityUnits ? pool.allocatedUnits / pool.capacityUnits : 0;
  return <Button type="button" variant={active ? "secondary" : "outline"} className="h-auto w-full justify-start p-3" onClick={onClick}><div className="flex min-w-0 flex-1 flex-col gap-2 text-left"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="truncate font-medium">{pool.email || pool.accountId || pool.id}</div><div className="text-xs text-muted-foreground">{codexPlanLabel(pool.planType)} · {pool.activeAllocationCount} 个生效分配</div></div><PoolStatus pool={pool} /></div><Progress value={Math.min(100, ratio * 100)} /><div className="flex justify-between text-xs text-muted-foreground"><span>{pool.allocatedUnits}/{pool.capacityUnits} 份</span><span>{pool.remainingUnits >= 0 ? `剩余 ${pool.remainingUnits}` : `超卖 ${Math.abs(pool.remainingUnits)}`}</span></div></div></Button>;
}

function PoolWorkspace({ pool, edits, savingId, onEdit, onSave, onDelete, onCreate }: { pool: SubscriptionCapacityPool; edits: Record<string, EditDraft>; savingId: string | null; onEdit: (id: string, edit: EditDraft) => void; onSave: (item: TenantSubscriptionRecord) => void; onDelete: (item: TenantSubscriptionRecord) => void; onCreate: () => void }) {
  return <Card><CardHeader><div className="flex min-w-0 flex-col gap-1"><CardTitle className="truncate">{pool.email || pool.accountId || pool.id}</CardTitle><CardDescription>{codexPlanLabel(pool.planType)} · 物理容量 {pool.capacityUnits} 份 · {pool.allocationCount} 条分配</CardDescription></div><CardAction><Button type="button" disabled={!pool.enabled} onClick={onCreate}><PlusIcon data-icon="inline-start" />新增分配</Button></CardAction></CardHeader><CardContent className="flex flex-col gap-4">{pool.remainingUnits < 0 ? <Alert variant="destructive"><AlertTriangleIcon /><AlertTitle>当前超卖 {Math.abs(pool.remainingUnits)} 份</AlertTitle><AlertDescription>允许继续运行，但这些租户会竞争同一个上游账号的实际额度。</AlertDescription></Alert> : null}{pool.lastError ? <Alert variant="destructive"><AlertTriangleIcon /><AlertTitle>凭据最近异常</AlertTitle><AlertDescription>{pool.lastError}</AlertDescription></Alert> : null}{pool.subscriptions.length === 0 ? <Empty className="min-h-64"><EmptyHeader><EmptyMedia variant="icon"><UsersIcon /></EmptyMedia><EmptyTitle>这个容量池还没有租户</EmptyTitle><EmptyDescription>创建第一条分配后，租户即可使用该凭据对应的本地额度。</EmptyDescription></EmptyHeader></Empty> : <AllocationTable pool={pool} edits={edits} savingId={savingId} onEdit={onEdit} onSave={onSave} onDelete={onDelete} />}</CardContent></Card>;
}

function AllocationTable({ pool, edits, savingId, onEdit, onSave, onDelete }: { pool: SubscriptionCapacityPool; edits: Record<string, EditDraft>; savingId: string | null; onEdit: (id: string, edit: EditDraft) => void; onSave: (item: TenantSubscriptionRecord) => void; onDelete: (item: TenantSubscriptionRecord) => void }) {
  return <Table><TableHeader><TableRow><TableHead>租户</TableHead><TableHead>本地用量</TableHead><TableHead className="w-24">份数</TableHead><TableHead className="w-24">优先级</TableHead><TableHead className="w-20">启用</TableHead><TableHead className="w-24" /></TableRow></TableHeader><TableBody>{pool.subscriptions.map((item) => { const edit = edits[item.id] || editFrom(item); const dirty = edit.units !== item.units || edit.priority !== item.priority || edit.enabled !== item.enabled; return <TableRow key={item.id}><TableCell><div className="flex flex-col gap-1"><div className="font-medium">{item.tenant?.name || item.tenantId}</div><div className="flex flex-wrap items-center gap-1"><LifecycleBadge lifecycle={item.lifecycle} />{item.tenant && !item.tenant.enabled ? <Badge variant="destructive">租户停用</Badge> : null}<span className="text-xs text-muted-foreground">占池 {percent(item.units / pool.capacityUnits)}</span></div></div></TableCell><TableCell><QuotaUsage item={item} /></TableCell><TableCell><Input type="number" min={1} value={edit.units} onChange={(event) => onEdit(item.id, { ...edit, units: Math.max(1, Number(event.target.value) || 1) })} /></TableCell><TableCell><Input type="number" value={edit.priority} onChange={(event) => onEdit(item.id, { ...edit, priority: Number(event.target.value) || 0 })} /></TableCell><TableCell><Switch checked={edit.enabled} onCheckedChange={(checked) => onEdit(item.id, { ...edit, enabled: checked })} aria-label={`${item.tenant?.name || item.tenantId} 启用状态`} /></TableCell><TableCell><div className="flex justify-end gap-1"><Button type="button" variant={dirty ? "default" : "ghost"} size="icon" disabled={!dirty || savingId === item.id} aria-label="保存分配" onClick={() => onSave(item)}>{savingId === item.id ? <Spinner /> : dirty ? <SaveIcon /> : <CheckIcon />}</Button><Button type="button" variant="ghost" size="icon" aria-label="回收分配" onClick={() => onDelete(item)}><Trash2Icon /></Button></div></TableCell></TableRow>; })}</TableBody></Table>;
}

function CreateAllocationDialog({ open, pool, tenants, draft, pending, onDraftChange, onOpenChange, onSubmit }: { open: boolean; pool: SubscriptionCapacityPool | null; tenants: PublicTenant[]; draft: AllocationDraft; pending: boolean; onDraftChange: (draft: AllocationDraft) => void; onOpenChange: (open: boolean) => void; onSubmit: () => void }) {
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>新增租户分配</DialogTitle><DialogDescription>{pool ? `从 ${pool.email || pool.accountId} 的 ${pool.capacityUnits} 份容量中分配。允许超卖。` : "选择容量池后再分配。"}</DialogDescription></DialogHeader><FieldGroup><Field><FieldLabel>租户</FieldLabel><Select value={draft.tenantId} onValueChange={(value) => onDraftChange({ ...draft, tenantId: value || "" })}><SelectTrigger className="w-full"><SelectValue placeholder="选择租户" /></SelectTrigger><SelectContent><SelectGroup>{tenants.map((tenant) => <SelectItem key={tenant.id} value={tenant.id}>{tenant.name}{tenant.ownerEmail ? ` · ${tenant.ownerEmail}` : ""}</SelectItem>)}</SelectGroup></SelectContent></Select></Field><Field><FieldLabel>分配份数</FieldLabel><Input type="number" min={1} value={draft.units} onChange={(event) => onDraftChange({ ...draft, units: Math.max(1, Number(event.target.value) || 1) })} /><FieldDescription>{pool ? `1 份等于该 ${codexPlanLabel(pool.planType)} 凭据总容量的 ${percent(1 / pool.capacityUnits)}。` : null}</FieldDescription></Field><Field><FieldLabel>路由优先级</FieldLabel><Input type="number" value={draft.priority} onChange={(event) => onDraftChange({ ...draft, priority: Number(event.target.value) || 0 })} /><FieldDescription>同一租户拥有多个可用子订阅时，优先选择数值更高的项。</FieldDescription></Field></FieldGroup><DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>取消</Button><Button type="button" disabled={pending || !draft.tenantId} onClick={onSubmit}>{pending && <Spinner data-icon="inline-start" />}确认分配</Button></DialogFooter></DialogContent></Dialog>;
}

function QuotaUsage({ item }: { item: TenantSubscriptionRecord }) {
  return <div className="flex min-w-44 flex-col gap-2">{(["5h", "7d"] as const).map((kind) => { const window = item.quota?.[kind]; if (!window) return <div key={kind} className="flex items-center gap-2 text-xs text-muted-foreground"><span className="w-6 font-mono">{kind}</span><Progress value={0} className="flex-1" /><span>待产生</span></div>; const limit = Number(window.limitNanoUsd); const used = Number(window.settledNanoUsd) + Number(window.reservedNanoUsd); const ratio = limit > 0 ? used / limit : 0; return <div key={kind} className="flex items-center gap-2 text-xs"><span className="w-6 font-mono text-muted-foreground">{kind}</span><Progress value={Math.min(100, ratio * 100)} className="flex-1" /><span className="w-12 text-right font-mono">{percent(ratio)}</span></div>; })}</div>;
}

function Metric({ icon, label, value, hint, danger = false }: { icon: React.ReactNode; label: string; value: string; hint: string; danger?: boolean }) {
  return <Card size="sm"><CardHeader><CardDescription className="flex items-center gap-2">{icon}{label}</CardDescription><CardTitle>{value}</CardTitle><CardAction>{danger ? <Badge variant="destructive">需处理</Badge> : null}</CardAction></CardHeader><CardContent className="text-xs text-muted-foreground">{hint}</CardContent></Card>;
}

function PoolStatus({ pool }: { pool: SubscriptionCapacityPool }) {
  if (!pool.enabled) return <Badge variant="outline">停用</Badge>;
  if (pool.remainingUnits < 0) return <Badge variant="destructive">超卖</Badge>;
  if (pool.cooldownUntil && pool.cooldownUntil > new Date().toISOString()) return <Badge variant="outline">冷却</Badge>;
  return <Badge variant="secondary">可用</Badge>;
}

function LifecycleBadge({ lifecycle }: { lifecycle?: TenantSubscriptionRecord["lifecycle"] }) {
  if (lifecycle === "active") return <Badge variant="secondary">生效</Badge>;
  if (lifecycle === "scheduled") return <Badge variant="outline">待生效</Badge>;
  if (lifecycle === "expired") return <Badge variant="destructive">已过期</Badge>;
  return <Badge variant="outline">停用</Badge>;
}

function editFrom(item: TenantSubscriptionRecord): EditDraft { return { units: item.units, priority: item.priority, enabled: item.enabled }; }
function percent(value: number) { return `${Math.round(value * 1000) / 10}%`; }

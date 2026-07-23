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
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  adminErrorMessage,
  createTenantSubscription,
  deleteTenantSubscription,
  getSubscriptionAllocationOverview,
  getSubscriptionCalibration,
  startSubscriptionCalibration,
  updateSubscriptionPoolQuotaEstimates,
  updateTenantSubscription,
  type SubscriptionAllocationOverview,
  type SubscriptionCapacityPool,
  type TenantSubscriptionRecord,
} from "@/lib/admin-api";
import {
  providerLabel,
  providerPlanLabel,
} from "@/src/shared/providerCapabilities";
import type { PublicTenant } from "@/src/shared/types/entities";

type AllocationDraft = {
  tenantId: string;
  units: string;
  unitsPerCredential: string;
  priority: number;
};
type EditDraft = {
  units: string;
  unitsPerCredential: string;
  priority: number;
  enabled: boolean;
};

const EMPTY_DRAFT: AllocationDraft = {
  tenantId: "",
  units: "1",
  unitsPerCredential: "1",
  priority: 100,
};

export function SubscriptionAllocationSection({
  tenants,
}: {
  tenants: PublicTenant[];
}) {
  const [overview, setOverview] =
    React.useState<SubscriptionAllocationOverview | null>(null);
  const [selectedPoolId, setSelectedPoolId] = React.useState("");
  const [edits, setEdits] = React.useState<Record<string, EditDraft>>({});
  const [loading, setLoading] = React.useState(true);
  const [savingId, setSavingId] = React.useState<string | null>(null);
  const [equalizing, setEqualizing] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [draft, setDraft] = React.useState(EMPTY_DRAFT);
  const [pendingDelete, setPendingDelete] =
    React.useState<TenantSubscriptionRecord | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [calibratingIds, setCalibratingIds] = React.useState<Set<string>>(
    new Set(),
  );

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const next = await getSubscriptionAllocationOverview();
      setOverview(next);
      setSelectedPoolId((current) =>
        next.pools.some((pool) => pool.id === current)
          ? current
          : next.pools[0]?.id || "",
      );
      setEdits(
        Object.fromEntries(
          next.pools.flatMap((pool) =>
            pool.subscriptions.map((item) => [item.id, editFrom(item)]),
          ),
        ),
      );
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

  const selectedPool =
    overview?.pools.find((pool) => pool.id === selectedPoolId) || null;
  const availableTenants = tenants.filter((tenant) => tenant.enabled);

  function openCreate() {
    setDraft({
      ...EMPTY_DRAFT,
      tenantId: availableTenants[0]?.id || "",
      unitsPerCredential: String(selectedPool?.capacityUnits || 1),
    });
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
        name: `${providerPlanLabel(selectedPool.provider, selectedPool.planType)} · ${tenant?.name || "子订阅"}`,
        units: parsePositiveUnits(draft.units),
        unitsPerCredential: parsePositiveUnits(draft.unitsPerCredential),
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
      await updateTenantSubscription(item.id, {
        ...edit,
        units: parsePositiveUnits(edit.units),
        unitsPerCredential: parsePositiveUnits(edit.unitsPerCredential),
      });
      await load();
      toast.success("分配已更新");
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setSavingId(null);
    }
  }

  async function equalizeAllocations(pool: SubscriptionCapacityPool) {
    const items = pool.subscriptions.filter((item) => item.enabled);
    if (!items.length) return;
    setEqualizing(true);
    try {
      const units = equalUnits(pool.capacityUnits, items.length);
      await Promise.all(
        items.map((item, index) =>
          updateTenantSubscription(item.id, {
            ...(edits[item.id] || editFrom(item)),
            units: units[index],
            unitsPerCredential: pool.capacityUnits,
          }),
        ),
      );
      await load();
      toast.success(
        `已将 ${pool.capacityUnits} 份容量均分给 ${items.length} 个启用分配`,
      );
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setEqualizing(false);
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

  async function recalculateUsage(item: TenantSubscriptionRecord) {
    setCalibratingIds((current) => new Set(current).add(item.id));
    try {
      await startSubscriptionCalibration(item.id);
      for (;;) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        const task = await getSubscriptionCalibration(item.id);
        if (task.status === "completed") {
          await load();
          toast.success(
            `重新核算完成：5h ${task.windows?.["5h"].requestCount || 0} 个请求，7d ${task.windows?.["7d"].requestCount || 0} 个请求`,
          );
          break;
        }
        if (task.status === "failed") {
          throw new Error(task.error || "重新核算失败");
        }
      }
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setCalibratingIds((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>订阅容量工作台</CardTitle>
          <CardDescription>
            统一管理 Codex 与 Grok 的容量分发；推测额度归属于每个主订阅容量池。
          </CardDescription>
          <CardAction>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => void load()}
            >
              {loading ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RefreshCwIcon data-icon="inline-start" />
              )}
              刷新
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {overview ? <Summary overview={overview} /> : null}
        </CardContent>
      </Card>

      {loading && !overview ? (
        <Card>
          <CardContent className="flex min-h-72 items-center justify-center">
            <Spinner />
          </CardContent>
        </Card>
      ) : !overview?.pools.length ? (
        <Card>
          <CardContent>
            <Empty className="min-h-72">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <BoxesIcon />
                </EmptyMedia>
                <EmptyTitle>还没有可分配凭据</EmptyTitle>
                <EmptyDescription>
                  先导入并启用凭据，才能建立可分配的容量池。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[22rem_minmax(0,1fr)]">
          <Card>
            <CardHeader>
              <CardTitle>容量池</CardTitle>
              <CardDescription>选择一个凭据查看其租户分配。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {overview.pools.map((pool) => (
                <PoolButton
                  key={pool.id}
                  pool={pool}
                  active={pool.id === selectedPoolId}
                  onClick={() => setSelectedPoolId(pool.id)}
                />
              ))}
            </CardContent>
          </Card>

          {selectedPool ? (
            <PoolWorkspace
              pool={selectedPool}
              edits={edits}
              savingId={savingId}
              calibratingIds={calibratingIds}
              equalizing={equalizing}
              onReload={load}
              onEdit={(id, edit) =>
                setEdits((current) => ({ ...current, [id]: edit }))
              }
              onSave={saveAllocation}
              onRecalculateUsage={recalculateUsage}
              onDelete={setPendingDelete}
              onCreate={openCreate}
              onEqualize={equalizeAllocations}
            />
          ) : null}
        </div>
      )}

      <CreateAllocationDialog
        open={createOpen}
        pool={selectedPool}
        tenants={availableTenants}
        draft={draft}
        pending={creating}
        onDraftChange={setDraft}
        onOpenChange={setCreateOpen}
        onSubmit={createAllocation}
      />
      <AlertDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>回收这条分配？</AlertDialogTitle>
            <AlertDialogDescription>
              租户将立即失去通过该父凭据获得的额度；已有用量记录会保留。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                void removeAllocation();
              }}
            >
              {deleting && <Spinner data-icon="inline-start" />}确认回收
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Summary({ overview }: { overview: SubscriptionAllocationOverview }) {
  const { summary } = overview;
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Metric
        icon={<BoxesIcon />}
        label="凭据容量池"
        value={`${summary.usableCredentialCount}/${summary.credentialCount}`}
        hint="可用 / 全部"
      />
      <Metric
        icon={<GaugeIcon />}
        label="总容量"
        value={`${summary.capacityUnits} 份`}
        hint="由计划类型自动换算"
      />
      <Metric
        icon={<UsersIcon />}
        label="已分配"
        value={`${summary.allocatedUnits} 份`}
        hint={
          summary.capacityUnits
            ? percent(summary.allocatedUnits / summary.capacityUnits)
            : "0%"
        }
      />
      <Metric
        icon={<AlertTriangleIcon />}
        label="超卖风险"
        value={`${summary.oversoldCredentialCount} 个`}
        hint="已超过物理份数的凭据"
        danger={summary.oversoldCredentialCount > 0}
      />
    </div>
  );
}

function PoolButton({
  pool,
  active,
  onClick,
}: {
  pool: SubscriptionCapacityPool;
  active: boolean;
  onClick: () => void;
}) {
  const ratio = pool.capacityUnits
    ? pool.allocatedUnits / pool.capacityUnits
    : 0;
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "outline"}
      className="h-auto w-full justify-start p-3"
      onClick={onClick}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2 text-left">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate font-medium">
              {pool.email || pool.accountId || pool.id}
            </div>
            <div className="text-xs text-muted-foreground">
              {providerLabel(pool.provider)} ·{" "}
              {providerPlanLabel(pool.provider, pool.planType)} ·{" "}
              {pool.activeAllocationCount} 个生效分配
            </div>
          </div>
          <PoolStatus pool={pool} />
        </div>
        <Progress value={Math.min(100, ratio * 100)} />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>
            {pool.allocatedUnits}/{pool.capacityUnits} 份
          </span>
          <span>已分配 {percent(ratio)}</span>
        </div>
      </div>
    </Button>
  );
}

function PoolWorkspace({
  pool,
  edits,
  savingId,
  calibratingIds,
  equalizing,
  onReload,
  onEdit,
  onSave,
  onRecalculateUsage,
  onDelete,
  onCreate,
  onEqualize,
}: {
  pool: SubscriptionCapacityPool;
  edits: Record<string, EditDraft>;
  savingId: string | null;
  calibratingIds: Set<string>;
  equalizing: boolean;
  onReload: () => Promise<void>;
  onEdit: (id: string, edit: EditDraft) => void;
  onSave: (item: TenantSubscriptionRecord) => void;
  onRecalculateUsage: (item: TenantSubscriptionRecord) => void;
  onDelete: (item: TenantSubscriptionRecord) => void;
  onCreate: () => void;
  onEqualize: (pool: SubscriptionCapacityPool) => void;
}) {
  const enabledCount = pool.subscriptions.filter((item) => item.enabled).length;
  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle className="truncate">
            {pool.email || pool.accountId || pool.id}
          </CardTitle>
          <CardDescription>
            {providerLabel(pool.provider)} ·{" "}
            {providerPlanLabel(pool.provider, pool.planType)} · 物理容量{" "}
            {pool.capacityUnits} 份 · {pool.allocationCount} 条分配
          </CardDescription>
        </div>
        <CardAction>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={equalizing || enabledCount === 0}
              onClick={() => onEqualize(pool)}
            >
              {equalizing && <Spinner data-icon="inline-start" />}一键均分
            </Button>
            <Button
              type="button"
              disabled={!pool.enabled || equalizing}
              onClick={onCreate}
            >
              <PlusIcon data-icon="inline-start" />
              新增分配
            </Button>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <PoolQuotaEstimates key={pool.id} pool={pool} onSaved={onReload} />
        {pool.allocatedUnits > pool.capacityUnits ? (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>
              当前超卖 {pool.allocatedUnits - pool.capacityUnits} 份
            </AlertTitle>
            <AlertDescription>
              允许继续运行，但这些租户会竞争同一个上游账号的实际额度。
            </AlertDescription>
          </Alert>
        ) : null}
        {pool.lastError ? (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>凭据最近异常</AlertTitle>
            <AlertDescription>{pool.lastError}</AlertDescription>
          </Alert>
        ) : null}
        {pool.subscriptions.length === 0 ? (
          <Empty className="min-h-64">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UsersIcon />
              </EmptyMedia>
              <EmptyTitle>这个容量池还没有租户</EmptyTitle>
              <EmptyDescription>
                创建第一条分配后，租户即可使用该凭据对应的本地额度。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <AllocationTable
            pool={pool}
            edits={edits}
            savingId={savingId}
            calibratingIds={calibratingIds}
            onEdit={onEdit}
            onSave={onSave}
            onRecalculateUsage={onRecalculateUsage}
            onDelete={onDelete}
          />
        )}
      </CardContent>
    </Card>
  );
}

function AllocationTable({
  pool,
  edits,
  savingId,
  calibratingIds,
  onEdit,
  onSave,
  onRecalculateUsage,
  onDelete,
}: {
  pool: SubscriptionCapacityPool;
  edits: Record<string, EditDraft>;
  savingId: string | null;
  calibratingIds: Set<string>;
  onEdit: (id: string, edit: EditDraft) => void;
  onSave: (item: TenantSubscriptionRecord) => void;
  onRecalculateUsage: (item: TenantSubscriptionRecord) => void;
  onDelete: (item: TenantSubscriptionRecord) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>租户</TableHead>
          <TableHead>本地用量</TableHead>
          <TableHead className="w-24">份数</TableHead>
          <TableHead className="w-24">拆分基数</TableHead>
          <TableHead className="w-24">优先级</TableHead>
          <TableHead className="w-20">启用</TableHead>
          <TableHead className="w-24" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {pool.subscriptions.map((item) => {
          const edit = edits[item.id] || editFrom(item);
          const dirty =
            Number(edit.units) !== item.units ||
            Number(edit.unitsPerCredential) !== item.unitsPerCredential ||
            edit.priority !== item.priority ||
            edit.enabled !== item.enabled;
          return (
            <TableRow key={item.id}>
              <TableCell>
                <div className="flex flex-col gap-1">
                  <div className="font-medium">
                    {item.tenant?.name || item.tenantId}
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <LifecycleBadge lifecycle={item.lifecycle} />
                    {item.tenant && !item.tenant.enabled ? (
                      <Badge variant="destructive">租户停用</Badge>
                    ) : null}
                    <span className="text-xs text-muted-foreground">
                      占池 {percent(item.units / item.unitsPerCredential)}
                    </span>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <QuotaUsage item={item} />
              </TableCell>
              <TableCell>
                <Input
                  type="number"
                  min="0.01"
                  step="any"
                  value={edit.units}
                  onChange={(event) =>
                    onEdit(item.id, { ...edit, units: event.target.value })
                  }
                />
              </TableCell>
              <TableCell>
                <Input
                  type="number"
                  value={edit.priority}
                  onChange={(event) =>
                    onEdit(item.id, {
                      ...edit,
                      priority: Number(event.target.value) || 0,
                    })
                  }
                />
              </TableCell>
              <TableCell>
                <Input
                  type="number"
                  min="0.01"
                  step="any"
                  value={edit.unitsPerCredential}
                  onChange={(event) =>
                    onEdit(item.id, {
                      ...edit,
                      unitsPerCredential: event.target.value,
                    })
                  }
                />
              </TableCell>
              <TableCell>
                <Switch
                  checked={edit.enabled}
                  onCheckedChange={(checked) =>
                    onEdit(item.id, { ...edit, enabled: checked })
                  }
                  aria-label={`${item.tenant?.name || item.tenantId} 启用状态`}
                />
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-1">
                  <Button
                    type="button"
                    variant={dirty ? "default" : "ghost"}
                    size="icon"
                    disabled={!dirty || savingId === item.id}
                    aria-label="保存分配"
                    onClick={() => onSave(item)}
                  >
                    {savingId === item.id ? (
                      <Spinner />
                    ) : dirty ? (
                      <SaveIcon />
                    ) : (
                      <CheckIcon />
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={
                      calibratingIds.has(item.id) ||
                      !item.quota?.["5h"] ||
                      !item.quota?.["7d"]
                    }
                    aria-label="重新核算子订阅用量"
                    title="重新核算子订阅用量"
                    onClick={() => onRecalculateUsage(item)}
                  >
                    {calibratingIds.has(item.id) ? <Spinner /> : <RefreshCwIcon />}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="回收分配"
                    onClick={() => onDelete(item)}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function CreateAllocationDialog({
  open,
  pool,
  tenants,
  draft,
  pending,
  onDraftChange,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  pool: SubscriptionCapacityPool | null;
  tenants: PublicTenant[];
  draft: AllocationDraft;
  pending: boolean;
  onDraftChange: (draft: AllocationDraft) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新增租户分配</DialogTitle>
          <DialogDescription>
            {pool
              ? `从 ${pool.email || pool.accountId} 的 ${pool.capacityUnits} 份容量中分配。允许超卖。`
              : "选择容量池后再分配。"}
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel>租户</FieldLabel>
            <Select
              value={draft.tenantId}
              onValueChange={(value) =>
                onDraftChange({ ...draft, tenantId: value || "" })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择租户" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {tenants.map((tenant) => (
                    <SelectItem key={tenant.id} value={tenant.id}>
                      {tenant.name}
                      {tenant.ownerEmail ? ` · ${tenant.ownerEmail}` : ""}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>分配份数</FieldLabel>
            <Input
              type="number"
              min="0.01"
              step="any"
              value={draft.units}
              onChange={(event) =>
                onDraftChange({
                  ...draft,
                  units: event.target.value,
                })
              }
            />
            <FieldDescription>
              {pool
                ? `当前是 ${draft.units}/${draft.unitsPerCredential}，占父订阅 ${percent(Number(draft.units) / Math.max(1, Number(draft.unitsPerCredential)))}。`
                : null}
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel>整份拆分数</FieldLabel>
            <Input
              type="number"
              min="0.01"
              step="any"
              value={draft.unitsPerCredential}
              onChange={(event) =>
                onDraftChange({
                  ...draft,
                  unitsPerCredential: event.target.value,
                })
              }
            />
            <FieldDescription>
              所有厂商统一用“持有份数 / 整份拆分数”计算授权比例，例如 Grok 1/5。
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel>路由优先级</FieldLabel>
            <Input
              type="number"
              value={draft.priority}
              onChange={(event) =>
                onDraftChange({
                  ...draft,
                  priority: Number(event.target.value) || 0,
                })
              }
            />
            <FieldDescription>
              同一租户拥有多个可用子订阅时，优先选择数值更高的项。
            </FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={pending || !draft.tenantId}
            onClick={onSubmit}
          >
            {pending && <Spinner data-icon="inline-start" />}确认分配
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function QuotaUsage({ item }: { item: TenantSubscriptionRecord }) {
  return (
    <div className="flex min-w-44 flex-col gap-2">
      {(["5h", "7d"] as const).map((kind) => {
        const window = item.quota?.[kind];
        if (!window)
          return (
            <div
              key={kind}
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <span className="w-6 font-mono">{kind}</span>
              <Progress value={0} className="flex-1" />
              <span>待产生</span>
            </div>
          );
        const limit = Number(window.limitNanoUsd);
        const used =
          Number(window.settledNanoUsd) + Number(window.reservedNanoUsd);
        const ratio = limit > 0 ? used / limit : 0;
        return (
          <div key={kind} className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-xs">
              <span className="w-6 font-mono text-muted-foreground">{kind}</span>
              <Progress value={Math.min(100, ratio * 100)} className="flex-1" />
              <span className="w-12 text-right font-mono">{percent(ratio)}</span>
            </div>
            <div className="pl-8 text-right font-mono text-[0.6875rem] text-muted-foreground">
              {formatQuotaUsd(used)} / {formatQuotaUsd(limit)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PoolQuotaEstimates({
  pool,
  onSaved,
}: {
  pool: SubscriptionCapacityPool;
  onSaved: () => Promise<void>;
}) {
  const [fiveHour, setFiveHour] = React.useState(
    nanoUsdToUsd(pool.quotaEstimates["5h"].overrideNanoUsd),
  );
  const [sevenDay, setSevenDay] = React.useState(
    nanoUsdToUsd(pool.quotaEstimates["7d"].overrideNanoUsd),
  );
  const [pending, setPending] = React.useState(false);
  async function save() {
    setPending(true);
    try {
      const estimates = await updateSubscriptionPoolQuotaEstimates(pool.id, {
        "5h": usdToNanoUsd(fiveHour),
        "7d": usdToNanoUsd(sevenDay),
      }) as SubscriptionCapacityPool["quotaEstimates"];
      await onSaved();
      if (!estimates["5h"].effectiveNanoUsd || !estimates["7d"].effectiveNanoUsd) {
        toast.warning("已保存，但 5h 和 7d 必须同时有有效额度才会启用子订阅成本限制");
      } else {
        toast.success("主订阅推测额度已保存并应用到所有子订阅");
      }
    } catch (error) {
      toast.error(adminErrorMessage(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>主订阅推测额度</CardTitle>
        <CardDescription>
          应用于这个主账号的完整容量；所有子订阅仅按所占份额继承。
          {pool.quotaResetStrategy === "codex-cache"
            ? " 周期边界直接跟随上游订阅。"
            : " 优先跟随已观测到的上游周期；尚未取得上游边界时使用本地滚动周期。"}
        </CardDescription>
        <CardAction>
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={() => void save()}
          >
            {pending && <Spinner data-icon="inline-start" />}保存
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`pool-5h-${pool.id}`}>
            5 小时推测额度（USD）
          </FieldLabel>
          <Input
            id={`pool-5h-${pool.id}`}
            inputMode="decimal"
            value={fiveHour}
            placeholder={quotaEstimatePlaceholder(pool, "5h")}
            onChange={(event) => setFiveHour(event.target.value)}
          />
          <FieldDescription>
            {estimateDescription(pool, pool.quotaEstimates["5h"])}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={`pool-7d-${pool.id}`}>
            7 天推测额度（USD）
          </FieldLabel>
          <Input
            id={`pool-7d-${pool.id}`}
            inputMode="decimal"
            value={sevenDay}
            placeholder={quotaEstimatePlaceholder(pool, "7d")}
            onChange={(event) => setSevenDay(event.target.value)}
          />
          <FieldDescription>
            {estimateDescription(pool, pool.quotaEstimates["7d"])}
          </FieldDescription>
        </Field>
      </CardContent>
    </Card>
  );
}

function estimateDescription(
  pool: SubscriptionCapacityPool,
  estimate: SubscriptionCapacityPool["quotaEstimates"]["5h"],
) {
  if (!pool.automaticQuotaSupported) {
    return "此凭据不提供上游订阅额度采样；可在这里手动设置父容量。";
  }
  return `自动推测 ${nanoUsdToUsd(estimate.automaticNanoUsd) || "暂无"} USD · ${estimate.sampleCount} 个样本 · 置信度 ${percent(estimate.confidence)}；需两次同周期额度快照，使用后最多 5 分钟自动刷新。`;
}

function quotaEstimatePlaceholder(
  pool: SubscriptionCapacityPool,
  kind: "5h" | "7d",
) {
  return (
    nanoUsdToUsd(pool.quotaEstimates[kind].automaticNanoUsd) ||
    (pool.automaticQuotaSupported ? "采样中" : "仅手动设置")
  );
}

function Metric({
  icon,
  label,
  value,
  hint,
  danger = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
  danger?: boolean;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          {icon}
          {label}
        </CardDescription>
        <CardTitle>{value}</CardTitle>
        <CardAction>
          {danger ? <Badge variant="destructive">需处理</Badge> : null}
        </CardAction>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">
        {hint}
      </CardContent>
    </Card>
  );
}

function PoolStatus({ pool }: { pool: SubscriptionCapacityPool }) {
  if (!pool.enabled) return <Badge variant="outline">停用</Badge>;
  if (pool.allocatedUnits > pool.capacityUnits)
    return <Badge variant="destructive">超卖</Badge>;
  if (pool.cooldownUntil && pool.cooldownUntil > new Date().toISOString())
    return <Badge variant="outline">冷却</Badge>;
  return <Badge variant="secondary">可用</Badge>;
}

function LifecycleBadge({
  lifecycle,
}: {
  lifecycle?: TenantSubscriptionRecord["lifecycle"];
}) {
  if (lifecycle === "active") return <Badge variant="secondary">生效</Badge>;
  if (lifecycle === "scheduled") return <Badge variant="outline">待生效</Badge>;
  if (lifecycle === "expired")
    return <Badge variant="destructive">已过期</Badge>;
  return <Badge variant="outline">停用</Badge>;
}

function editFrom(item: TenantSubscriptionRecord): EditDraft {
  return {
    units: String(item.units),
    unitsPerCredential: String(item.unitsPerCredential),
    priority: item.priority,
    enabled: item.enabled,
  };
}
function parsePositiveUnits(value: string) {
  const units = Number(value);
  if (!Number.isFinite(units) || units <= 0)
    throw new Error("份数必须是大于 0 的数字");
  return units;
}
function equalUnits(capacity: number, count: number) {
  const scale = 1_000_000;
  const total = Math.round(capacity * scale);
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return Array.from(
    { length: count },
    (_, index) => (base + (index < remainder ? 1 : 0)) / scale,
  );
}
function percent(value: number) {
  return `${Math.round(value * 1000) / 10}%`;
}
function formatQuotaUsd(value: number) {
  return `$${(value / 1_000_000_000).toLocaleString("zh-CN", {
    maximumFractionDigits: 4,
  })}`;
}
function usdToNanoUsd(value: string) {
  const parsed = Number(value.trim());
  if (!value.trim()) return null;
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error("推测额度必须是大于 0 的数字");
  return String(Math.round(parsed * 1_000_000_000));
}
function nanoUsdToUsd(value?: string | null) {
  return value ? String(Number(value) / 1_000_000_000) : "";
}

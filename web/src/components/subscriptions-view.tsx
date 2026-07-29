import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react"
import { PackageOpenIcon, PlusIcon, RefreshCwIcon, SaveIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress, ProgressLabel } from "@/components/ui/progress"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ModelSelector } from "@/components/model-selector"
import { QuotaSnapshot } from "@/components/quota-snapshot"
import {
  api,
  deleteRequest,
  postJSON,
  type CapacityMode,
  type ChildQuotaWindow,
  type ChildSubscription,
  type ParentSubscriptionView,
  type User,
} from "@/lib/api"
import { dateTime, money } from "@/lib/format"

const capacityModes: Array<{ value: CapacityMode; label: string }> = [
  { value: "unmetered", label: "不计上游额度" },
  { value: "manual", label: "手动容量窗口" },
  { value: "observed", label: "自动观测/校准容量" },
]

function isCapacityMode(value: unknown): value is CapacityMode {
  return capacityModes.some((item) => item.value === value)
}

export function AdminSubscriptionsView() {
  const [parents, setParents] = useState<ParentSubscriptionView[]>([])
  const [children, setChildren] = useState<ChildSubscription[]>([])
  const [tenants, setTenants] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [parentEditor, setParentEditor] = useState<ParentSubscriptionView | null>(null)
  const [childEditor, setChildEditor] = useState<ChildSubscription | null>(null)
  const [childOpen, setChildOpen] = useState(false)
  const [newChildParentID, setNewChildParentID] = useState("")
  const [newChildModels, setNewChildModels] = useState<string[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [parentValue, childValue, tenantValue] = await Promise.all([
        api<{ items: ParentSubscriptionView[] }>("/api/admin/subscriptions/parents"),
        api<{ items: ChildSubscription[] }>("/api/admin/subscriptions/children"),
        api<{ items: User[] }>("/api/admin/tenants"),
      ])
      setParents(parentValue.items ?? [])
      setChildren(childValue.items ?? [])
      setTenants(tenantValue.items ?? [])
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "无法读取订阅数据")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function syncParents() {
    setPending(true)
    try {
      const result = await postJSON<{ synced: number; quota?: Array<{ status: string; supported: boolean }> }>("/api/admin/subscriptions/sync", {})
      const supported = result.quota?.filter((item) => item.supported && item.status !== "error").length ?? 0
      toast.success(`已同步 ${result.synced} 个 CPA 父账户，${supported} 个支持自动额度`)
      await load()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "同步失败")
    } finally {
      setPending(false)
    }
  }

  async function syncParentQuota(id: string) {
    setPending(true)
    try {
      const result = await postJSON<{ status: string; supported: boolean; windows: number; error?: string }>(`/api/admin/subscriptions/parents/${id}/quota/sync`, {})
      if (!result.supported) toast.info("这个提供商暂未暴露可自动读取的额度")
      else toast.success(`额度观测完成，读取 ${result.windows} 个可校准窗口`)
      await load()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "额度同步失败")
    } finally {
      setPending(false)
    }
  }

  async function createChild(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    try {
      if (!newChildParentID) throw new Error("请选择父订阅")
      await postJSON("/api/admin/subscriptions/children", {
        tenant_id: String(form.get("tenant_id") || ""),
        parent_subscription_id: newChildParentID,
        name: String(form.get("name") || ""),
        allocation_ppm: Math.round(Number(form.get("percent") || 0) * 10_000),
        priority: Number(form.get("priority") || 100),
        enabled: true,
        model_allowlist: newChildModels,
        starts_at: new Date().toISOString(),
        expires_at: "",
      })
      setChildOpen(false)
      setNewChildParentID("")
      setNewChildModels([])
      toast.success("子订阅已分配")
      await load()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "分配失败")
    } finally {
      setPending(false)
    }
  }

  async function toggleChild(child: ChildSubscription) {
    setPending(true)
    try {
      await api(`/api/admin/subscriptions/children/${child.id}`, {
        method: "PUT",
        body: JSON.stringify({
          tenant_id: child.tenant_id,
          parent_subscription_id: child.parent_subscription_id,
          name: child.name,
          allocation_ppm: child.allocation_ppm,
          priority: child.priority,
          enabled: !child.enabled,
          model_allowlist: child.model_allowlist ?? [],
          starts_at: child.starts_at,
          expires_at: child.expires_at ?? "",
        }),
      })
      await load()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "更新失败")
    } finally {
      setPending(false)
    }
  }

  async function removeChild(id: string) {
    if (!window.confirm("确认删除这个子订阅？")) return
    try {
      await deleteRequest(`/api/admin/subscriptions/children/${id}`)
      toast.success("子订阅已删除")
      await load()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "删除失败")
    }
  }

  const parentByID = useMemo(() => new Map(parents.map((item) => [item.item.id, item.item])), [parents])
  const tenantByID = useMemo(() => new Map(tenants.map((item) => [item.id, item])), [tenants])
  const newChildParent = parents.find((item) => item.item.id === newChildParentID)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">父订阅与子订阅</h1>
          <p className="text-sm text-muted-foreground">将 CPA AuthID 作为父容量池；上游额度由 bridge 在 CPA 内部脱敏读取，子份额由管理员分配。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void syncParents()} disabled={pending}>
            {pending ? <Spinner /> : <RefreshCwIcon />}同步 CPA 父账户
          </Button>
          <Button onClick={() => setChildOpen(true)} disabled={!parents.length || !tenants.length}>
            <PlusIcon />分配子订阅
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>父订阅容量池</CardTitle>
          <CardDescription>AuthID 只在管理员视图中展示；租户只能看到子订阅名称和自己的额度。</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? <div className="flex justify-center py-12"><Spinner /></div> : parents.length ? (
            <Table>
              <TableHeader><TableRow><TableHead>父订阅</TableHead><TableHead>提供商</TableHead><TableHead>上游额度</TableHead><TableHead>计费策略</TableHead><TableHead>已分配</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
              <TableBody>
                {parents.map((view) => (
                  <TableRow key={view.item.id}>
                    <TableCell><div className="font-medium">{view.item.name}</div><div className="max-w-60 truncate font-mono text-xs text-muted-foreground" title={`Scheduler ID: ${view.item.cpa_auth_id}`}>{view.item.cpa_auth_index}</div></TableCell>
                    <TableCell>{view.item.provider || "未知"}</TableCell>
                    <TableCell><QuotaSnapshot snapshot={view.item.quota_snapshot} status={view.item.quota_probe_status} error={view.item.quota_probe_error} observedAt={view.item.quota_observed_at} compact /></TableCell>
                    <TableCell>{capacityModes.find((mode) => mode.value === view.item.capacity_mode)?.label}</TableCell>
                    <TableCell className="tabular-nums">{percent(view.allocated_ppm)} / {percent(view.item.allocation_limit_ppm)}</TableCell>
                    <TableCell><div className="flex flex-col items-start gap-1"><Badge variant={view.item.enabled && !view.item.cpa_unavailable ? "secondary" : "outline"}>{!view.item.enabled ? "已停用" : view.item.cpa_unavailable ? "CPA 不可用" : view.item.status || "可用"}</Badge><QuotaProbeBadge item={view.item} /></div></TableCell>
                    <TableCell className="text-right"><div className="flex justify-end gap-2"><Button size="sm" variant="outline" disabled={pending} onClick={() => void syncParentQuota(view.item.id)}><RefreshCwIcon />额度</Button><Button size="sm" variant="outline" onClick={() => setParentEditor(view)}>配置</Button></div></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : <Empty><EmptyHeader><EmptyMedia variant="icon"><PackageOpenIcon /></EmptyMedia><EmptyTitle>还没有父订阅</EmptyTitle><EmptyDescription>先同步 CPA 凭据，再配置容量窗口。</EmptyDescription></EmptyHeader></Empty>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>子订阅分配</CardTitle><CardDescription>启用后的分配总额不能超过父订阅上限。</CardDescription></CardHeader>
        <CardContent>
          {children.length ? (
            <Table>
              <TableHeader><TableRow><TableHead>子订阅</TableHead><TableHead>租户</TableHead><TableHead>父订阅</TableHead><TableHead>份额</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
              <TableBody>{children.map((child) => (
                <TableRow key={child.id}>
                  <TableCell><div className="font-medium">{child.name}</div><div className="text-xs text-muted-foreground">优先级 {child.priority}</div></TableCell>
                  <TableCell>{tenantByID.get(child.tenant_id)?.name || child.tenant_id}</TableCell>
                  <TableCell>{parentByID.get(child.parent_subscription_id)?.name || "父订阅不可用"}</TableCell>
                  <TableCell>{percent(child.allocation_ppm)}</TableCell>
                  <TableCell><Badge variant={child.enabled ? "secondary" : "outline"}>{child.enabled ? "启用" : "停用"}</Badge></TableCell>
                  <TableCell><div className="flex justify-end gap-2"><Button size="sm" variant="outline" onClick={() => setChildEditor(child)}>编辑</Button><Button size="sm" variant="outline" disabled={pending} onClick={() => void toggleChild(child)}>{child.enabled ? "停用" : "启用"}</Button><Button size="icon-sm" variant="ghost" aria-label="删除子订阅" onClick={() => void removeChild(child.id)}><Trash2Icon /></Button></div></TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          ) : <Empty><EmptyHeader><EmptyMedia variant="icon"><PackageOpenIcon /></EmptyMedia><EmptyTitle>还没有子订阅</EmptyTitle><EmptyDescription>从任意父账户划分容量给租户。</EmptyDescription></EmptyHeader></Empty>}
        </CardContent>
      </Card>

      <ParentEditor value={parentEditor} pending={pending} onPending={setPending} onClose={() => setParentEditor(null)} onSaved={load} />
      <ChildEditor value={childEditor} parents={parents} pending={pending} onPending={setPending} onClose={() => setChildEditor(null)} onSaved={load} />
      <Dialog open={childOpen} onOpenChange={(open) => { setChildOpen(open); if (!open) { setNewChildParentID(""); setNewChildModels([]) } }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>分配子订阅</DialogTitle><DialogDescription>份额使用精确百万分比存储，不使用浮点计费。</DialogDescription></DialogHeader>
          <form id="child-subscription-form" onSubmit={createChild}>
            <FieldGroup>
              <Field><FieldLabel>租户</FieldLabel><Select name="tenant_id" required><SelectTrigger className="w-full"><SelectValue placeholder="选择租户" /></SelectTrigger><SelectContent><SelectGroup>{tenants.map((tenant) => <SelectItem key={tenant.id} value={tenant.id}>{tenant.name} · {tenant.owner_email}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
              <Field><FieldLabel>父订阅</FieldLabel><Select value={newChildParentID} onValueChange={(next) => { setNewChildParentID(next ?? ""); setNewChildModels([]) }} required><SelectTrigger className="w-full"><SelectValue placeholder="选择父订阅" /></SelectTrigger><SelectContent><SelectGroup>{parents.filter((item) => item.item.enabled && !item.item.cpa_unavailable).map((view) => <SelectItem key={view.item.id} value={view.item.id}>{view.item.name} · 剩余 {percent(view.item.allocation_limit_ppm - view.allocated_ppm)}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
              <Field><FieldLabel htmlFor="child-name">名称</FieldLabel><Input id="child-name" name="name" placeholder="例如：团队 Pro 1/20" required /></Field>
              <div className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel htmlFor="child-percent">父容量占比（%）</FieldLabel><Input id="child-percent" name="percent" type="number" min="0.0001" step="0.0001" defaultValue="5" required /></Field><Field><FieldLabel htmlFor="child-priority">优先级</FieldLabel><Input id="child-priority" name="priority" type="number" defaultValue="100" required /></Field></div>
              <Field><FieldLabel htmlFor="child-models">模型范围</FieldLabel><ModelSelector id="child-models" options={parentModelOptions(newChildParent)} value={newChildModels} onChange={setNewChildModels} allLabel="继承父订阅全部模型" /><FieldDescription>这里只能从父订阅可用模型中收窄；不选择表示全部继承。</FieldDescription></Field>
            </FieldGroup>
          </form>
          <DialogFooter><Button variant="outline" onClick={() => setChildOpen(false)}>取消</Button><Button type="submit" form="child-subscription-form" disabled={pending}>{pending ? <Spinner /> : <PlusIcon />}分配</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ChildEditor({ value, parents, pending, onPending, onClose, onSaved }: { value: ChildSubscription | null; parents: ParentSubscriptionView[]; pending: boolean; onPending: (value: boolean) => void; onClose: () => void; onSaved: () => Promise<void> }) {
  const [parentID, setParentID] = useState("")
  const [models, setModels] = useState<string[]>([])
  useEffect(() => {
    if (!value) return
    setParentID(value.parent_subscription_id)
    setModels(value.model_allowlist ?? [])
  }, [value])
  if (!value) return null
  const current = value
  const selectedParent = parents.find((item) => item.item.id === parentID)
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    onPending(true)
    try {
      if (!parentID) throw new Error("请选择父订阅")
      await api(`/api/admin/subscriptions/children/${current.id}`, {
        method: "PUT",
        body: JSON.stringify({
          tenant_id: current.tenant_id,
          parent_subscription_id: parentID,
          name: String(form.get("name") || ""),
          allocation_ppm: Math.round(Number(form.get("percent") || 0) * 10_000),
          priority: Number(form.get("priority") || 0),
          enabled: form.get("enabled") === "on",
          model_allowlist: models,
          starts_at: new Date(String(form.get("starts_at"))).toISOString(),
          expires_at: form.get("expires_at") ? new Date(String(form.get("expires_at"))).toISOString() : "",
        }),
      })
      toast.success("子订阅已更新")
      onClose()
      await onSaved()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "更新失败")
    } finally {
      onPending(false)
    }
  }
  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>编辑子订阅</DialogTitle><DialogDescription>修改份额、路由优先级、生命周期和模型范围。</DialogDescription></DialogHeader><form id="child-editor-form" onSubmit={save}><FieldGroup>
    <Field><FieldLabel htmlFor="edit-child-name">名称</FieldLabel><Input id="edit-child-name" name="name" defaultValue={current.name} required /></Field>
    <Field><FieldLabel>父订阅</FieldLabel><Select value={parentID} onValueChange={(next) => { setParentID(next ?? ""); setModels([]) }} required><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{parents.map((view) => <SelectItem key={view.item.id} value={view.item.id} disabled={view.item.cpa_unavailable}>{view.item.name} · 已分配 {percent(view.allocated_ppm)}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
    <div className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel htmlFor="edit-child-percent">父容量占比（%）</FieldLabel><Input id="edit-child-percent" name="percent" type="number" min="0.0001" step="0.0001" defaultValue={current.allocation_ppm / 10_000} required /></Field><Field><FieldLabel htmlFor="edit-child-priority">优先级</FieldLabel><Input id="edit-child-priority" name="priority" type="number" defaultValue={current.priority} required /></Field></div>
    <div className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel htmlFor="edit-child-start">生效时间</FieldLabel><Input id="edit-child-start" name="starts_at" type="datetime-local" step="1" defaultValue={localDateTime(current.starts_at)} required /></Field><Field><FieldLabel htmlFor="edit-child-expiry">到期时间</FieldLabel><Input id="edit-child-expiry" name="expires_at" type="datetime-local" step="1" defaultValue={localDateTime(current.expires_at ?? undefined)} /></Field></div>
    <Field><FieldLabel htmlFor="edit-child-models">模型范围</FieldLabel><ModelSelector id="edit-child-models" options={parentModelOptions(selectedParent)} value={models} onChange={setModels} allLabel="继承父订阅全部模型" /></Field>
    <label className="flex items-center gap-2 text-sm"><input name="enabled" type="checkbox" defaultChecked={current.enabled} />启用子订阅</label>
  </FieldGroup></form><DialogFooter><Button variant="outline" onClick={onClose}>取消</Button><Button type="submit" form="child-editor-form" disabled={pending}>{pending ? <Spinner /> : <SaveIcon />}保存</Button></DialogFooter></DialogContent></Dialog>
}

function ParentEditor({ value, pending, onPending, onClose, onSaved }: { value: ParentSubscriptionView | null; pending: boolean; onPending: (value: boolean) => void; onClose: () => void; onSaved: () => Promise<void> }) {
  const [mode, setMode] = useState<CapacityMode>("unmetered")
  const [windows, setWindows] = useState<EditableWindow[]>([])
  const [models, setModels] = useState<string[]>([])
  useEffect(() => {
    if (!value) return
    setMode(value.item.capacity_mode)
    setModels(value.item.model_allowlist ?? [])
    if (!value.windows.length) {
      setWindows([emptyWindow("5h"), emptyWindow("7d")])
      return
    }
    setWindows(value.windows.map((item) => ({
      key: crypto.randomUUID(),
      kind: item.kind,
      limit: item.limit_nano_usd ? String(item.limit_nano_usd / 1_000_000_000) : "",
      reset: localDateTime(item.resets_at),
    })))
  }, [value])
  if (!value) return null
  const current = value

  function updateWindow(key: string, field: keyof Omit<EditableWindow, "key">, next: string) {
    setWindows((items) => items.map((item) => item.key === key ? { ...item, [field]: next } : item))
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    onPending(true)
    try {
      let manualItems: Array<{ kind: string; limit_nano_usd: number; resets_at: string; source: string }> = []
      if (mode === "manual") {
        const configured = windows.filter((item) => item.kind.trim() || item.limit || item.reset)
        if (!configured.length) throw new Error("手动计量父订阅至少需要一个有效容量窗口")
        const names = new Set<string>()
        manualItems = configured.map((item) => {
          const kind = item.kind.trim()
          const limit = Math.round(Number(item.limit) * 1_000_000_000)
          if (!kind || !Number.isFinite(limit) || limit <= 0 || !item.reset) throw new Error("每个额度窗口都需要名称、正数容量和重置时间")
          if (names.has(kind)) throw new Error(`额度窗口名称重复：${kind}`)
          names.add(kind)
          return { kind, limit_nano_usd: limit, resets_at: new Date(item.reset).toISOString(), source: mode }
        })
      }
      await api(`/api/admin/subscriptions/parents/${current.item.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: String(form.get("name") || ""),
          capacity_mode: mode, allocation_limit_ppm: Math.round(Number(form.get("allocation_limit") || 100) * 10_000),
          enabled: form.get("enabled") === "on", model_allowlist: models,
        }),
      })
      if (mode === "manual") {
        await api(`/api/admin/subscriptions/parents/${current.item.id}/windows`, { method: "PUT", body: JSON.stringify({ items: manualItems }) })
      } else if (mode === "observed" && current.item.capacity_mode !== "observed") {
        await api(`/api/admin/subscriptions/parents/${current.item.id}/windows`, { method: "PUT", body: JSON.stringify({ items: [] }) })
      }
      toast.success("父订阅配置已保存")
      onClose()
      await onSaved()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "保存失败")
    } finally {
      onPending(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader><DialogTitle>配置父订阅</DialogTitle><DialogDescription>{current.item.provider} · {current.item.cpa_auth_name || current.item.cpa_auth_id}</DialogDescription></DialogHeader>
        <form id="parent-subscription-form" onSubmit={save}>
          <FieldGroup>
            <Field><FieldLabel htmlFor="parent-name">名称</FieldLabel><Input id="parent-name" name="name" defaultValue={current.item.name} required /></Field>
            <div className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel>容量模式</FieldLabel><Select value={mode} onValueChange={(next) => { if (isCapacityMode(next)) setMode(next) }}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{capacityModes.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field><Field><FieldLabel>上游计划</FieldLabel><div className="flex h-9 items-center gap-2 rounded-md border bg-muted/30 px-3"><Badge variant="secondary">{current.item.plan_type || "未识别"}</Badge><span className="text-xs text-muted-foreground">由 CPA 自动同步</span></div></Field></div>
            <Field><FieldLabel htmlFor="parent-limit">可分配上限（%）</FieldLabel><Input id="parent-limit" name="allocation_limit" type="number" min="0.0001" step="0.0001" defaultValue={current.item.allocation_limit_ppm / 10_000} required /><FieldDescription>这是子订阅业务分配策略；100% 表示不超售，大于 100% 才表示明确允许超售。</FieldDescription></Field>
            <Field><FieldLabel htmlFor="parent-models">模型策略范围</FieldLabel><ModelSelector id="parent-models" options={current.item.cpa_model_allowlist ?? []} value={models} onChange={setModels} /><FieldDescription>CPA 已同步 {current.item.cpa_model_allowlist?.length ?? 0} 个模型；不选择表示允许该凭据的全部模型。</FieldDescription></Field>
            {mode === "observed" ? <div className="flex flex-col gap-3 rounded-lg border p-3">
              <div><p className="font-medium">自动额度</p><p className="text-xs text-muted-foreground">以下数据由 bridge 从 CPA 凭据自动读取。这里不再要求手填百分比、窗口名称或重置时间。</p></div>
              <QuotaSnapshot snapshot={current.item.quota_snapshot} status={current.item.quota_probe_status} error={current.item.quota_probe_error} observedAt={current.item.quota_observed_at} />
              <div className="rounded-md bg-muted/40 p-3"><p className="text-sm font-medium">USD 校准容量</p>{current.windows.length ? <div className="mt-2 flex flex-col gap-1">{current.windows.map((window) => <div key={window.kind} className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"><span>{window.kind} · {money(window.limit_nano_usd)}</span><span>{dateTime(window.resets_at)} 重置</span></div>)}</div> : <p className="mt-1 text-xs text-muted-foreground">正在学习：需要上游百分比发生有效变化，并有对应的本地计价消费后，才会估算完整 USD 容量。</p>}</div>
            </div> : null}
            {mode === "manual" ? <div className="flex flex-col gap-3 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-3"><div><p className="font-medium">手动额度窗口</p><p className="text-xs text-muted-foreground">仅在上游没有可用额度扩展时填写。</p></div><Button type="button" size="sm" variant="outline" onClick={() => setWindows((items) => [...items, emptyWindow("")])}><PlusIcon />添加窗口</Button></div>
              {windows.map((item) => <div key={item.key} className="grid items-end gap-3 rounded-md bg-muted/40 p-3 sm:grid-cols-[0.8fr_1fr_1.2fr_auto]">
                <Field><FieldLabel htmlFor={`${item.key}-kind`}>名称</FieldLabel><Input id={`${item.key}-kind`} value={item.kind} onChange={(event) => updateWindow(item.key, "kind", event.target.value)} placeholder="5h / monthly" /></Field>
                <Field><FieldLabel htmlFor={`${item.key}-limit`}>容量（USD）</FieldLabel><Input id={`${item.key}-limit`} type="number" min="0" step="0.000001" value={item.limit} onChange={(event) => updateWindow(item.key, "limit", event.target.value)} /></Field>
                <Field><FieldLabel htmlFor={`${item.key}-reset`}>上游重置时间</FieldLabel><Input id={`${item.key}-reset`} type="datetime-local" step="1" value={item.reset} onChange={(event) => updateWindow(item.key, "reset", event.target.value)} /></Field>
                <Button type="button" size="icon-sm" variant="ghost" aria-label="删除额度窗口" onClick={() => setWindows((items) => items.filter((window) => window.key !== item.key))}><Trash2Icon /></Button>
              </div>)}
            </div> : null}
            <label className="flex items-center gap-2 text-sm"><input name="enabled" type="checkbox" defaultChecked={current.item.enabled} />启用父订阅</label>
          </FieldGroup>
        </form>
        <DialogFooter><Button variant="outline" onClick={onClose}>取消</Button><Button type="submit" form="parent-subscription-form" disabled={pending}>{pending ? <Spinner /> : <SaveIcon />}保存</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function QuotaProbeBadge({ item }: { item: ParentSubscriptionView["item"] }) {
  if (item.quota_probe_status === "supported") return <Badge variant="outline" title={item.quota_observed_at ? `最近观测：${dateTime(item.quota_observed_at)}` : undefined}>自动额度</Badge>
  if (item.quota_probe_status === "unsupported") return <Badge variant="outline">额度需手动配置</Badge>
  if (item.quota_probe_status === "error") return <Badge variant="destructive" title={item.quota_probe_error || "额度探测失败"}>额度探测失败</Badge>
  return <Badge variant="outline">额度待探测</Badge>
}

type EditableWindow = { key: string; kind: string; limit: string; reset: string }
function emptyWindow(kind: string): EditableWindow { return { key: crypto.randomUUID(), kind, limit: "", reset: "" } }

export function TenantSubscriptionsView() {
  const [items, setItems] = useState<ChildSubscription[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    api<{ items: ChildSubscription[] }>("/api/subscriptions").then((value) => setItems(value.items ?? [])).catch((cause) => toast.error(cause instanceof Error ? cause.message : "无法读取订阅")).finally(() => setLoading(false))
  }, [])
  return <div className="flex flex-col gap-4"><div><h1 className="text-2xl font-semibold tracking-tight">我的订阅</h1><p className="text-sm text-muted-foreground">每个子订阅独立继承父账户的容量窗口和重置时间。</p></div>{loading ? <div className="flex justify-center py-12"><Spinner /></div> : items.length ? <div className="grid gap-4 xl:grid-cols-2">{items.map((item) => <TenantSubscriptionCard key={item.id} item={item} />)}</div> : <Empty><EmptyHeader><EmptyMedia variant="icon"><PackageOpenIcon /></EmptyMedia><EmptyTitle>尚未分配子订阅</EmptyTitle><EmptyDescription>当前账户继续使用余额计费；管理员分配后将启用严格父账户路由。</EmptyDescription></EmptyHeader></Empty>}</div>
}

function TenantSubscriptionCard({ item }: { item: ChildSubscription }) {
  const emptyMessage = item.capacity_mode === "unmetered" ? "此父订阅不计量上游容量，仍受账户余额和 API Key 策略限制。" : "额度窗口会在首次成功预留时初始化。"
  return <Card><CardHeader><div className="flex items-start justify-between gap-3"><div><CardTitle>{item.name}</CardTitle><CardDescription>父容量份额 {percent(item.allocation_ppm)} · 优先级 {item.priority}</CardDescription></div><Badge variant={item.enabled ? "secondary" : "outline"}>{item.enabled ? "可用" : "停用"}</Badge></div></CardHeader><CardContent className="flex flex-col gap-4">{item.windows?.length ? item.windows.map((window) => <QuotaProgress key={window.kind} window={window} />) : <p className="text-sm text-muted-foreground">{emptyMessage}</p>}<div className="text-xs text-muted-foreground">模型：{item.model_allowlist?.length ? item.model_allowlist.join(", ") : "继承父订阅"}{item.expires_at ? ` · 到期 ${dateTime(item.expires_at)}` : ""}</div></CardContent></Card>
}

function QuotaProgress({ window }: { window: ChildQuotaWindow }) {
  const used = window.settled_nano_usd + window.reserved_nano_usd
  const ratio = window.limit_nano_usd > 0 ? Math.min(100, used / window.limit_nano_usd * 100) : 100
  return <Progress value={ratio}><ProgressLabel>{window.kind} · 已用 {money(used)}</ProgressLabel><span className="ml-auto text-sm tabular-nums text-muted-foreground">{ratio.toFixed(1)}%</span><p className="w-full text-xs text-muted-foreground">总额 {money(window.limit_nano_usd)} · {dateTime(window.resets_at)} 重置</p></Progress>
}

function percent(ppm: number) { return `${(ppm / 10_000).toFixed(ppm % 10_000 ? 2 : 0)}%` }
function localDateTime(value?: string) { if (!value) return ""; const date = new Date(value); const offset = date.getTimezoneOffset() * 60_000; return new Date(date.getTime() - offset).toISOString().slice(0, 19) }
function parentModelOptions(parent?: ParentSubscriptionView) { return parent?.item.model_allowlist?.length ? parent.item.model_allowlist : parent?.item.cpa_model_allowlist ?? [] }

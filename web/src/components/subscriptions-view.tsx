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
  { value: "observed", label: "观测/校准容量" },
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
      const result = await postJSON<{ synced: number }>("/api/admin/subscriptions/sync", {})
      toast.success(`已同步 ${result.synced} 个 CPA 父账户`)
      await load()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "同步失败")
    } finally {
      setPending(false)
    }
  }

  async function createChild(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    try {
      await postJSON("/api/admin/subscriptions/children", {
        tenant_id: String(form.get("tenant_id") || ""),
        parent_subscription_id: String(form.get("parent_id") || ""),
        name: String(form.get("name") || ""),
        allocation_ppm: Math.round(Number(form.get("percent") || 0) * 10_000),
        priority: Number(form.get("priority") || 100),
        enabled: true,
        model_allowlist: commaList(form.get("models")),
        starts_at: new Date().toISOString(),
        expires_at: "",
      })
      setChildOpen(false)
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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">父订阅与子订阅</h1>
          <p className="text-sm text-muted-foreground">将 CPA AuthID 作为父容量池，按比例严格分配给租户。</p>
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
              <TableHeader><TableRow><TableHead>父订阅</TableHead><TableHead>提供商</TableHead><TableHead>容量</TableHead><TableHead>已分配</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
              <TableBody>
                {parents.map((view) => (
                  <TableRow key={view.item.id}>
                    <TableCell><div className="font-medium">{view.item.name}</div><div className="max-w-60 truncate font-mono text-xs text-muted-foreground" title={`Scheduler ID: ${view.item.cpa_auth_id}`}>{view.item.cpa_auth_index}</div></TableCell>
                    <TableCell>{view.item.provider || "未知"}</TableCell>
                    <TableCell>{capacityModes.find((mode) => mode.value === view.item.capacity_mode)?.label}</TableCell>
                    <TableCell className="tabular-nums">{percent(view.allocated_ppm)} / {percent(view.item.allocation_limit_ppm)}</TableCell>
                    <TableCell><Badge variant={view.item.enabled && !view.item.cpa_unavailable ? "secondary" : "outline"}>{!view.item.enabled ? "已停用" : view.item.cpa_unavailable ? "CPA 不可用" : view.item.status || "可用"}</Badge></TableCell>
                    <TableCell className="text-right"><Button size="sm" variant="outline" onClick={() => setParentEditor(view)}>配置</Button></TableCell>
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
      <Dialog open={childOpen} onOpenChange={setChildOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>分配子订阅</DialogTitle><DialogDescription>份额使用精确百万分比存储，不使用浮点计费。</DialogDescription></DialogHeader>
          <form id="child-subscription-form" onSubmit={createChild}>
            <FieldGroup>
              <Field><FieldLabel>租户</FieldLabel><Select name="tenant_id" required><SelectTrigger className="w-full"><SelectValue placeholder="选择租户" /></SelectTrigger><SelectContent><SelectGroup>{tenants.map((tenant) => <SelectItem key={tenant.id} value={tenant.id}>{tenant.name} · {tenant.owner_email}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
              <Field><FieldLabel>父订阅</FieldLabel><Select name="parent_id" required><SelectTrigger className="w-full"><SelectValue placeholder="选择父订阅" /></SelectTrigger><SelectContent><SelectGroup>{parents.filter((item) => item.item.enabled && !item.item.cpa_unavailable).map((view) => <SelectItem key={view.item.id} value={view.item.id}>{view.item.name} · 剩余 {percent(view.item.allocation_limit_ppm - view.allocated_ppm)}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
              <Field><FieldLabel htmlFor="child-name">名称</FieldLabel><Input id="child-name" name="name" placeholder="例如：团队 Pro 1/20" required /></Field>
              <div className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel htmlFor="child-percent">父容量占比（%）</FieldLabel><Input id="child-percent" name="percent" type="number" min="0.0001" step="0.0001" defaultValue="5" required /></Field><Field><FieldLabel htmlFor="child-priority">优先级</FieldLabel><Input id="child-priority" name="priority" type="number" defaultValue="100" required /></Field></div>
              <Field><FieldLabel htmlFor="child-models">模型范围</FieldLabel><Input id="child-models" name="models" placeholder="留空继承父订阅全部模型" /><FieldDescription>逗号分隔，支持通配符。</FieldDescription></Field>
            </FieldGroup>
          </form>
          <DialogFooter><Button variant="outline" onClick={() => setChildOpen(false)}>取消</Button><Button type="submit" form="child-subscription-form" disabled={pending}>{pending ? <Spinner /> : <PlusIcon />}分配</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ChildEditor({ value, parents, pending, onPending, onClose, onSaved }: { value: ChildSubscription | null; parents: ParentSubscriptionView[]; pending: boolean; onPending: (value: boolean) => void; onClose: () => void; onSaved: () => Promise<void> }) {
  if (!value) return null
  const current = value
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    onPending(true)
    try {
      await api(`/api/admin/subscriptions/children/${current.id}`, {
        method: "PUT",
        body: JSON.stringify({
          tenant_id: current.tenant_id,
          parent_subscription_id: String(form.get("parent_id") || ""),
          name: String(form.get("name") || ""),
          allocation_ppm: Math.round(Number(form.get("percent") || 0) * 10_000),
          priority: Number(form.get("priority") || 0),
          enabled: form.get("enabled") === "on",
          model_allowlist: commaList(form.get("models")),
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
    <Field><FieldLabel>父订阅</FieldLabel><Select name="parent_id" defaultValue={current.parent_subscription_id} required><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{parents.map((view) => <SelectItem key={view.item.id} value={view.item.id} disabled={view.item.cpa_unavailable}>{view.item.name} · 已分配 {percent(view.allocated_ppm)}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
    <div className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel htmlFor="edit-child-percent">父容量占比（%）</FieldLabel><Input id="edit-child-percent" name="percent" type="number" min="0.0001" step="0.0001" defaultValue={current.allocation_ppm / 10_000} required /></Field><Field><FieldLabel htmlFor="edit-child-priority">优先级</FieldLabel><Input id="edit-child-priority" name="priority" type="number" defaultValue={current.priority} required /></Field></div>
    <div className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel htmlFor="edit-child-start">生效时间</FieldLabel><Input id="edit-child-start" name="starts_at" type="datetime-local" step="1" defaultValue={localDateTime(current.starts_at)} required /></Field><Field><FieldLabel htmlFor="edit-child-expiry">到期时间</FieldLabel><Input id="edit-child-expiry" name="expires_at" type="datetime-local" step="1" defaultValue={localDateTime(current.expires_at ?? undefined)} /></Field></div>
    <Field><FieldLabel htmlFor="edit-child-models">模型范围</FieldLabel><Input id="edit-child-models" name="models" defaultValue={(current.model_allowlist ?? []).join(", ")} placeholder="留空继承父订阅" /></Field>
    <label className="flex items-center gap-2 text-sm"><input name="enabled" type="checkbox" defaultChecked={current.enabled} />启用子订阅</label>
  </FieldGroup></form><DialogFooter><Button variant="outline" onClick={onClose}>取消</Button><Button type="submit" form="child-editor-form" disabled={pending}>{pending ? <Spinner /> : <SaveIcon />}保存</Button></DialogFooter></DialogContent></Dialog>
}

function ParentEditor({ value, pending, onPending, onClose, onSaved }: { value: ParentSubscriptionView | null; pending: boolean; onPending: (value: boolean) => void; onClose: () => void; onSaved: () => Promise<void> }) {
  const [mode, setMode] = useState<CapacityMode>("unmetered")
  const [windows, setWindows] = useState<EditableWindow[]>([])
  useEffect(() => {
    if (!value) return
    setMode(value.item.capacity_mode)
    if (!value.windows.length) {
      setWindows([emptyWindow("5h"), emptyWindow("7d")])
      return
    }
    setWindows(value.windows.map((item) => ({
      key: crypto.randomUUID(),
      kind: item.kind,
      limit: item.limit_nano_usd ? String(item.limit_nano_usd / 1_000_000_000) : "",
      reset: localDateTime(item.resets_at),
      usedPercent: item.observed_used_percent == null ? "" : String(item.observed_used_percent),
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
      await api(`/api/admin/subscriptions/parents/${current.item.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: String(form.get("name") || ""), plan_type: String(form.get("plan") || ""),
          capacity_mode: mode, allocation_limit_ppm: Math.round(Number(form.get("allocation_limit") || 100) * 10_000),
          enabled: form.get("enabled") === "on", model_allowlist: commaList(form.get("models")),
        }),
      })
      if (mode !== "unmetered") {
        const configured = windows.filter((item) => item.kind.trim() || item.limit || item.reset)
        if (!configured.length) throw new Error("计量父订阅至少需要一个有效容量窗口")
        const names = new Set<string>()
        const items = configured.map((item) => {
          const kind = item.kind.trim()
          const limit = Math.round(Number(item.limit) * 1_000_000_000)
          if (!kind || !Number.isFinite(limit) || limit <= 0 || !item.reset) throw new Error("每个额度窗口都需要名称、正数容量和重置时间")
          if (names.has(kind)) throw new Error(`额度窗口名称重复：${kind}`)
          names.add(kind)
          return { kind, limit_nano_usd: limit, resets_at: new Date(item.reset).toISOString(), source: mode }
        })
        await api(`/api/admin/subscriptions/parents/${current.item.id}/windows`, { method: "PUT", body: JSON.stringify({ items }) })
        if (mode === "observed") {
          for (const item of configured) {
            if (!item.usedPercent.trim()) continue
            const usedPercent = Number(item.usedPercent)
            if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) throw new Error(`窗口 ${item.kind} 的已用百分比必须在 0 到 100 之间`)
            await postJSON(`/api/admin/subscriptions/parents/${current.item.id}/observations`, {
              kind: item.kind.trim(),
              used_percent: usedPercent,
              resets_at: new Date(item.reset).toISOString(),
              observed_at: new Date().toISOString(),
            })
          }
        }
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
            <div className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel>容量模式</FieldLabel><Select value={mode} onValueChange={(next) => { if (isCapacityMode(next)) setMode(next) }}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{capacityModes.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field><Field><FieldLabel htmlFor="parent-plan">计划标签</FieldLabel><Input id="parent-plan" name="plan" defaultValue={current.item.plan_type} placeholder="Plus / Pro / Team" /></Field></div>
            <div className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel htmlFor="parent-limit">可分配上限（%）</FieldLabel><Input id="parent-limit" name="allocation_limit" type="number" min="0.0001" step="0.0001" defaultValue={current.item.allocation_limit_ppm / 10_000} required /><FieldDescription>大于 100% 表示明确允许超售。</FieldDescription></Field><Field><FieldLabel htmlFor="parent-models">模型策略范围</FieldLabel><Input id="parent-models" name="models" defaultValue={(current.item.model_allowlist ?? []).join(", ")} placeholder="留空使用 CPA 同步能力" /><FieldDescription>CPA 已同步 {current.item.cpa_model_allowlist?.length ?? 0} 个模型；此处仅做额外收窄。</FieldDescription></Field></div>
            {mode !== "unmetered" ? <div className="flex flex-col gap-3 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-3"><div><p className="font-medium">额度窗口</p><p className="text-xs text-muted-foreground">可配置 5h、7d、monthly、credits 等任意上游窗口。</p></div><Button type="button" size="sm" variant="outline" onClick={() => setWindows((items) => [...items, emptyWindow("")])}><PlusIcon />添加窗口</Button></div>
              {windows.map((item) => <div key={item.key} className="grid items-end gap-3 rounded-md bg-muted/40 p-3 sm:grid-cols-[0.8fr_1fr_1.2fr_auto]">
                <Field><FieldLabel htmlFor={`${item.key}-kind`}>名称</FieldLabel><Input id={`${item.key}-kind`} value={item.kind} onChange={(event) => updateWindow(item.key, "kind", event.target.value)} placeholder="5h / monthly" /></Field>
                <Field><FieldLabel htmlFor={`${item.key}-limit`}>容量（USD）</FieldLabel><Input id={`${item.key}-limit`} type="number" min="0" step="0.000001" value={item.limit} onChange={(event) => updateWindow(item.key, "limit", event.target.value)} /></Field>
                <Field><FieldLabel htmlFor={`${item.key}-reset`}>上游重置时间</FieldLabel><Input id={`${item.key}-reset`} type="datetime-local" step="1" value={item.reset} onChange={(event) => updateWindow(item.key, "reset", event.target.value)} /></Field>
                <Button type="button" size="icon-sm" variant="ghost" aria-label="删除额度窗口" onClick={() => setWindows((items) => items.filter((window) => window.key !== item.key))}><Trash2Icon /></Button>
                {mode === "observed" ? <Field className="sm:col-span-3"><FieldLabel htmlFor={`${item.key}-used`}>上游已用百分比</FieldLabel><Input id={`${item.key}-used`} type="number" min="0" max="100" step="0.001" value={item.usedPercent} onChange={(event) => updateWindow(item.key, "usedPercent", event.target.value)} placeholder="可选；连续样本用于自动校准容量" /></Field> : null}
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

type EditableWindow = { key: string; kind: string; limit: string; reset: string; usedPercent: string }
function emptyWindow(kind: string): EditableWindow { return { key: crypto.randomUUID(), kind, limit: "", reset: "", usedPercent: "" } }

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
function commaList(value: FormDataEntryValue | null) { return String(value || "").split(",").map((item) => item.trim()).filter(Boolean) }
function localDateTime(value?: string) { if (!value) return ""; const date = new Date(value); const offset = date.getTimezoneOffset() * 60_000; return new Date(date.getTime() - offset).toISOString().slice(0, 19) }

import { useCallback, useEffect, useState, type FormEvent } from "react"
import { AlertTriangleIcon, CheckCircle2Icon, GaugeIcon, PackageOpenIcon, PlusIcon, RefreshCwIcon, SaveIcon, Trash2Icon, UsersIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress, ProgressLabel } from "@/components/ui/progress"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ModelSelector } from "@/components/model-selector"
import { QuotaSnapshot } from "@/components/quota-snapshot"
import {
  api,
  deleteRequest,
  postJSON,
  type CapacityMode,
  type ChildSubscription,
  type ParentSubscription,
  type ParentSubscriptionView,
  type SubscriptionEntitlementWindow,
  type User,
} from "@/lib/api"
import { dateTime, money } from "@/lib/format"

const capacityModes: Array<{ value: CapacityMode; label: string }> = [
  { value: "unmetered", label: "账户余额计费" },
  { value: "observed", label: "自动观测/校准容量" },
]

type DistributionDraft = { id: string; tenantID: string; name: string; percent: string; priority: string }

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
  const [newChildName, setNewChildName] = useState("")
  const [newChildPercent, setNewChildPercent] = useState("5")
  const [newChildModels, setNewChildModels] = useState<string[]>([])
  const [distributionDrafts, setDistributionDrafts] = useState<Record<string, DistributionDraft[]>>({})

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
        allocation_ppm: newChildParent?.item.capacity_mode === "unmetered"
          ? 1_000_000
          : Math.round(Number(form.get("percent") || 0) * 10_000),
        priority: Number(form.get("priority") || 100),
        enabled: true,
        model_allowlist: newChildModels,
        starts_at: new Date().toISOString(),
        expires_at: "",
      })
      setChildOpen(false)
      setNewChildParentID("")
      setNewChildName("")
      setNewChildPercent("5")
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

  function addDistributionRow(parent: ParentSubscriptionView) {
    setDistributionDrafts((current) => ({
      ...current,
      [parent.item.id]: [...(current[parent.item.id] ?? []), { id: crypto.randomUUID(), tenantID: "", name: defaultChildName(parent.item), percent: "5", priority: "100" }],
    }))
  }

  function updateDistributionRow(parentID: string, rowID: string, field: keyof Omit<DistributionDraft, "id">, value: string) {
    setDistributionDrafts((current) => ({
      ...current,
      [parentID]: (current[parentID] ?? []).map((row) => row.id === rowID ? { ...row, [field]: value } : row),
    }))
  }

  function removeDistributionRow(parentID: string, rowID: string) {
    setDistributionDrafts((current) => ({ ...current, [parentID]: (current[parentID] ?? []).filter((row) => row.id !== rowID) }))
  }

  async function saveDistribution(parent: ParentSubscriptionView) {
    const rows = distributionDrafts[parent.item.id] ?? []
    if (!rows.length) return
    const draftPPM = rows.reduce((sum, row) => sum + Math.round(Number(row.percent || 0) * 10_000), 0)
    if (parent.item.capacity_mode !== "unmetered" && parent.allocated_ppm + draftPPM > parent.item.allocation_limit_ppm) {
      toast.error("本次批量分配超过父订阅可分配上限")
      return
    }
    if (rows.some((row) => !row.tenantID || !row.name.trim() || Number(row.percent) <= 0)) {
      toast.error("请完整填写每一行的租户、名称和份额")
      return
    }
    setPending(true)
    try {
      await Promise.all(rows.map((row) => postJSON("/api/admin/subscriptions/children", {
        tenant_id: row.tenantID,
        parent_subscription_id: parent.item.id,
        name: row.name.trim(),
        allocation_ppm: parent.item.capacity_mode === "unmetered" ? 1_000_000 : Math.round(Number(row.percent) * 10_000),
        priority: Number(row.priority || 100), enabled: true, model_allowlist: [],
        starts_at: new Date().toISOString(), expires_at: "",
      })))
      setDistributionDrafts((current) => ({ ...current, [parent.item.id]: [] }))
      toast.success(`已从 ${parent.item.name} 分配 ${rows.length} 个子订阅`)
      await load()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "批量分配失败")
    } finally {
      setPending(false)
    }
  }

  const newChildParent = parents.find((item) => item.item.id === newChildParentID)
  const newChildPPM = Math.round(Number(newChildPercent || 0) * 10_000)
  const newChildRemainingPPM = newChildParent
    ? newChildParent.item.allocation_limit_ppm - newChildParent.allocated_ppm - newChildPPM
    : 0
  const newChildOverAllocated = Boolean(newChildParent && newChildParent.item.capacity_mode !== "unmetered" && newChildRemainingPPM < 0)
  const readyParents = parents.filter((view) => view.item.enabled && !view.item.cpa_unavailable && (view.item.capacity_mode === "unmetered" || view.windows.length > 0)).length
  const learningParents = parents.filter((view) => view.item.capacity_mode === "observed" && view.item.quota_supported && !view.windows.length).length

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">父订阅与子订阅</h1>
          <p className="text-sm text-muted-foreground">OAuth 账户可拆分上游额度；API Key 账户可作为余额计费通道分发，密钥始终保留在 CPA 内部。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void syncParents()} disabled={pending}>
            {pending ? <Spinner /> : <RefreshCwIcon />}同步 CPA 父账户
          </Button>
        </div>
      </div>

      {parents.length ? <Alert>
        <GaugeIcon />
        <AlertTitle>{readyParents} 个父订阅可以立即分配{learningParents ? `，${learningParents} 个仍在学习额度` : ""}</AlertTitle>
        <AlertDescription>自动额度需要至少两次同一重置周期内的有效观测。学习期间可继续同步和产生计价请求，形成样本后会自动得到美元容量。</AlertDescription>
      </Alert> : null}

      {loading ? <Card><CardContent className="pt-6"><TableSkeleton columns={6} /></CardContent></Card> : parents.length ? <div className="flex flex-col gap-4">{parents.map((view) => <ParentDistributionCard
        key={view.item.id} view={view} children={children.filter((child) => child.parent_subscription_id === view.item.id)} tenants={tenants}
        drafts={distributionDrafts[view.item.id] ?? []} pending={pending}
        onAdd={() => addDistributionRow(view)} onDraftChange={(rowID, field, value) => updateDistributionRow(view.item.id, rowID, field, value)}
        onDraftRemove={(rowID) => removeDistributionRow(view.item.id, rowID)} onSave={() => void saveDistribution(view)}
        onSync={() => void syncParentQuota(view.item.id)} onConfigure={() => setParentEditor(view)} onEdit={setChildEditor}
        onToggle={(child) => void toggleChild(child)} onRemove={(id) => void removeChild(id)}
      />)}</div> : <Empty><EmptyHeader><EmptyMedia variant="icon"><PackageOpenIcon /></EmptyMedia><EmptyTitle>还没有父订阅</EmptyTitle><EmptyDescription>先同步 CPA 凭据，再从父订阅直接分配给多个租户。</EmptyDescription></EmptyHeader></Empty>}

      <ParentEditor value={parentEditor} pending={pending} onPending={setPending} onClose={() => setParentEditor(null)} onSaved={load} />
      <ChildEditor value={childEditor} parents={parents} pending={pending} onPending={setPending} onClose={() => setChildEditor(null)} onSaved={load} />
      <Dialog open={childOpen} onOpenChange={(open) => { setChildOpen(open); if (!open) { setNewChildParentID(""); setNewChildName(""); setNewChildPercent("5"); setNewChildModels([]) } }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>分配子订阅</DialogTitle><DialogDescription>{newChildParent?.item.capacity_mode === "unmetered" ? "该通道不划分上游额度，实际消费统一从所选租户的账户总余额扣除。" : "份额使用精确百万分比存储，不使用浮点计费。"}</DialogDescription></DialogHeader>
          <form id="child-subscription-form" onSubmit={createChild}>
            <FieldGroup>
              <Field><FieldLabel>租户</FieldLabel><Select name="tenant_id" required><SelectTrigger className="w-full"><SelectValue placeholder="选择租户" /></SelectTrigger><SelectContent><SelectGroup>{tenants.map((tenant) => <SelectItem key={tenant.id} value={tenant.id}>{tenant.name} · {tenant.owner_email}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
              <Field><FieldLabel>父订阅</FieldLabel><Select value={newChildParentID} onValueChange={(next) => { const parentID = next ?? ""; setNewChildParentID(parentID); setNewChildName(defaultChildName(parents.find((item) => item.item.id === parentID)?.item)); setNewChildModels([]) }} required><SelectTrigger className="w-full"><SelectValue placeholder="选择父订阅" /></SelectTrigger><SelectContent><SelectGroup>{parents.filter((item) => item.item.enabled && !item.item.cpa_unavailable).map((view) => <SelectItem key={view.item.id} value={view.item.id}>{view.item.name} · {view.item.capacity_mode === "unmetered" ? "账户余额计费" : view.windows.length ? `可分 ${percent(view.item.allocation_limit_ppm - view.allocated_ppm)}` : "额度学习中"}</SelectItem>)}</SelectGroup></SelectContent></Select>{newChildParent ? <FieldDescription>{parentSelectionHint(newChildParent)}</FieldDescription> : null}</Field>
              <Field><FieldLabel htmlFor="child-name">名称</FieldLabel><Input id="child-name" name="name" value={newChildName} onChange={(event) => setNewChildName(event.target.value)} placeholder="选择父订阅后自动生成" required /></Field>
              <div className="grid gap-4 sm:grid-cols-2">{newChildParent?.item.capacity_mode !== "unmetered" ? <Field data-invalid={newChildOverAllocated || undefined}><FieldLabel htmlFor="child-percent">父容量占比（%）</FieldLabel><Input id="child-percent" name="percent" type="number" min="0.0001" max={newChildParent ? Math.max(0, (newChildParent.item.allocation_limit_ppm - newChildParent.allocated_ppm) / 10_000) : undefined} step="0.0001" value={newChildPercent} onChange={(event) => setNewChildPercent(event.target.value)} aria-invalid={newChildOverAllocated || undefined} required /><FieldDescription>{newChildParent ? `分配后父订阅剩余 ${percent(Math.max(0, newChildRemainingPPM))}` : "先选择父订阅"}</FieldDescription></Field> : <Field><FieldLabel htmlFor="child-billing">结算账户</FieldLabel><Input id="child-billing" value="租户总余额" readOnly /><FieldDescription>子订阅本身不保存余额。</FieldDescription></Field>}<Field><FieldLabel htmlFor="child-priority">优先级</FieldLabel><Input id="child-priority" name="priority" type="number" defaultValue="100" required /><FieldDescription>数值越大，越优先用于路由。</FieldDescription></Field></div>
              {newChildParent && newChildParent.item.capacity_mode !== "unmetered" && newChildParent.windows.length ? <Alert><CheckCircle2Icon /><AlertTitle>将同时获得 {newChildParent.windows.length} 个独立额度窗口</AlertTitle><AlertDescription>{newChildParent.windows.map((window) => `${window.kind} ${money(Math.floor(window.limit_nano_usd * newChildPPM / 1_000_000))}`).join(" · ")}</AlertDescription></Alert> : null}
              <Field><FieldLabel htmlFor="child-models">模型范围</FieldLabel><ModelSelector id="child-models" options={parentModelOptions(newChildParent)} value={newChildModels} onChange={setNewChildModels} allLabel="继承父订阅全部模型" /><FieldDescription>这里只能从父订阅可用模型中收窄；不选择表示全部继承。</FieldDescription></Field>
            </FieldGroup>
          </form>
          <DialogFooter><Button variant="outline" onClick={() => setChildOpen(false)}>取消</Button><Button type="submit" form="child-subscription-form" disabled={pending || newChildOverAllocated}>{pending ? <Spinner /> : <PlusIcon data-icon="inline-start" />}确认分配</Button></DialogFooter>
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
          allocation_ppm: selectedParent?.item.capacity_mode === "unmetered"
            ? 1_000_000
            : Math.round(Number(form.get("percent") || 0) * 10_000),
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
  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>编辑子订阅</DialogTitle><DialogDescription>{selectedParent?.item.capacity_mode === "unmetered" ? "该 API Key 通道按租户总余额结算，可修改路由优先级、生命周期和模型范围。" : "修改份额、路由优先级、生命周期和模型范围。"}</DialogDescription></DialogHeader><form id="child-editor-form" onSubmit={save}><FieldGroup>
    <Field><FieldLabel htmlFor="edit-child-name">名称</FieldLabel><Input id="edit-child-name" name="name" defaultValue={current.name} required /></Field>
    <Field><FieldLabel>父订阅</FieldLabel><Select value={parentID} onValueChange={(next) => { setParentID(next ?? ""); setModels([]) }} required><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{parents.map((view) => <SelectItem key={view.item.id} value={view.item.id} disabled={view.item.cpa_unavailable}>{view.item.name} · 已分配 {percent(view.allocated_ppm)}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
    <div className="grid gap-4 sm:grid-cols-2">{selectedParent?.item.capacity_mode !== "unmetered" ? <Field><FieldLabel htmlFor="edit-child-percent">父容量占比（%）</FieldLabel><Input id="edit-child-percent" name="percent" type="number" min="0.0001" step="0.0001" defaultValue={current.allocation_ppm / 10_000} required /></Field> : <Field><FieldLabel htmlFor="edit-child-billing">结算账户</FieldLabel><Input id="edit-child-billing" value="租户总余额" readOnly /><FieldDescription>子订阅本身不保存余额。</FieldDescription></Field>}<Field><FieldLabel htmlFor="edit-child-priority">优先级</FieldLabel><Input id="edit-child-priority" name="priority" type="number" defaultValue={current.priority} required /></Field></div>
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
    setWindows(value.item.capacity_mode === "observed" ? observedEditableWindows(value) : [])
  }, [value])
  if (!value) return null
  const current = value

  function changeMode(next: unknown) {
    if (!isCapacityMode(next)) return
    setMode(next)
    if (next === "observed") setWindows(observedEditableWindows(current))
    else setWindows([])
  }

  function updateWindow(key: string, field: keyof Omit<EditableWindow, "key">, next: string) {
    setWindows((items) => items.map((item) => item.key === key ? { ...item, [field]: next } : item))
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    onPending(true)
    try {
      let windowItems: Array<{ kind: string; limit_nano_usd: number }> = []
      if (mode === "observed") {
        const configured = windows.filter((item) => item.kind.trim() || item.limit || item.reset)
        const names = new Set<string>()
        windowItems = configured.map((item) => {
          const kind = item.kind.trim()
          const limit = Math.round(Number(item.limit) * 1_000_000_000)
          if (!kind || !Number.isFinite(limit) || limit <= 0 || !item.reset) {
            throw new Error("请为每个自动观测窗口填写正数 USD 容量")
          }
          if (names.has(kind)) throw new Error(`额度窗口名称重复：${kind}`)
          names.add(kind)
          return {
            kind,
            limit_nano_usd: limit,
          }
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
      if (mode === "observed" && windowItems.length) {
        await api(`/api/admin/subscriptions/parents/${current.item.id}/windows`, { method: "PUT", body: JSON.stringify({ items: windowItems }) })
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
            <div className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel>容量模式</FieldLabel><Select value={mode} onValueChange={changeMode}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{capacityModes.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field><Field><FieldLabel>上游计划</FieldLabel><div className="flex h-9 items-center gap-2 rounded-md border bg-muted/30 px-3"><Badge variant="secondary">{current.item.plan_type || "未识别"}</Badge><span className="text-xs text-muted-foreground">由 CPA 自动同步</span></div></Field></div>
            {mode !== "unmetered" ? <Field><FieldLabel htmlFor="parent-limit">可分配上限（%）</FieldLabel><Input id="parent-limit" name="allocation_limit" type="number" min="0.0001" step="0.0001" defaultValue={current.item.allocation_limit_ppm / 10_000} required /><FieldDescription>这是子订阅业务分配策略；100% 表示不超售，大于 100% 才表示明确允许超售。</FieldDescription></Field> : <Field><FieldLabel htmlFor="parent-billing-source">结算方式</FieldLabel><Input id="parent-billing-source" value="按租户账户总余额结算" readOnly /><FieldDescription>适用于按量付费的上游 API Key。可创建多个子订阅，实际请求按模型价格预扣并结算。</FieldDescription></Field>}
            <Field><FieldLabel htmlFor="parent-models">模型策略范围</FieldLabel><ModelSelector id="parent-models" options={current.item.cpa_model_allowlist ?? []} value={models} onChange={setModels} /><FieldDescription>CPA 已同步 {current.item.cpa_model_allowlist?.length ?? 0} 个模型；不选择表示允许该凭据的全部模型。</FieldDescription></Field>
            {mode === "observed" ? <div className="flex flex-col gap-3 rounded-lg border p-3">
              <div><p className="font-medium">自动观测窗口</p><p className="text-xs text-muted-foreground">窗口名称、数量、使用率和重置时间由 bridge 自动观测；你只定义每个窗口对应的 USD 容量。</p></div>
              <QuotaSnapshot snapshot={current.item.quota_snapshot} status={current.item.quota_probe_status} error={current.item.quota_probe_error} observedAt={current.item.quota_observed_at} />
              {windows.length ? <FieldGroup>{windows.map((item) => <Field key={item.key} orientation="horizontal">
                <div className="min-w-0 flex-1"><FieldLabel htmlFor={`${item.key}-observed-limit`}>{item.kind}</FieldLabel><FieldDescription>{dateTime(new Date(item.reset).toISOString())} 重置</FieldDescription></div>
                <Input id={`${item.key}-observed-limit`} className="w-40" type="number" min="0.000001" step="0.000001" value={item.limit} onChange={(event) => updateWindow(item.key, "limit", event.target.value)} placeholder="USD 容量" required />
              </Field>)}</FieldGroup> : <p className="text-xs text-muted-foreground">尚未发现可执行窗口。请先同步上游额度；发现 5h、7d 等窗口后即可填写对应的 USD 容量。</p>}
            </div> : null}
            <label className="flex items-center gap-2 text-sm"><input name="enabled" type="checkbox" defaultChecked={current.item.enabled} />启用父订阅</label>
          </FieldGroup>
        </form>
        <DialogFooter><Button variant="outline" onClick={onClose}>取消</Button><Button type="submit" form="parent-subscription-form" disabled={pending}>{pending ? <Spinner /> : <SaveIcon />}保存</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ParentDistributionCard({ view, children, tenants, drafts, pending, onAdd, onDraftChange, onDraftRemove, onSave, onSync, onConfigure, onEdit, onToggle, onRemove }: {
  view: ParentSubscriptionView
  children: ChildSubscription[]
  tenants: User[]
  drafts: DistributionDraft[]
  pending: boolean
  onAdd: () => void
  onDraftChange: (rowID: string, field: keyof Omit<DistributionDraft, "id">, value: string) => void
  onDraftRemove: (rowID: string) => void
  onSave: () => void
  onSync: () => void
  onConfigure: () => void
  onEdit: (child: ChildSubscription) => void
  onToggle: (child: ChildSubscription) => void
  onRemove: (id: string) => void
}) {
  const tenantByID = new Map(tenants.map((tenant) => [tenant.id, tenant]))
  const draftPPM = drafts.reduce((sum, row) => sum + Math.round(Number(row.percent || 0) * 10_000), 0)
  const projectedPPM = view.allocated_ppm + (view.item.capacity_mode === "unmetered" ? 0 : draftPPM)
  const overAllocated = view.item.capacity_mode !== "unmetered" && projectedPPM > view.item.allocation_limit_ppm
  const selectableTenants = tenants.filter((tenant) => tenant.enabled)
  return <Card>
    <CardHeader>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2"><CardTitle>{view.item.name}</CardTitle><Badge variant="outline">{view.item.provider || "未知提供商"}</Badge><ParentReadiness view={view} /><QuotaProbeBadge item={view.item} /></div>
          <CardDescription>{capacityModes.find((mode) => mode.value === view.item.capacity_mode)?.label} · {view.item.plan_type || "未识别计划"} · {view.windows.length ? view.windows.map((window) => `${quotaWindowLabel(window.kind)} ${money(window.limit_nano_usd)}`).join(" · ") : "尚无美元额度窗口"}</CardDescription>
        </div>
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={pending} onClick={onSync}><RefreshCwIcon data-icon="inline-start" />同步额度</Button><Button size="sm" variant="outline" onClick={onConfigure}>配置父订阅</Button></div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm"><Badge variant="secondary"><UsersIcon data-icon="inline-start" />{children.length} 个子订阅</Badge>{view.item.capacity_mode !== "unmetered" ? <span className="text-muted-foreground">已分 {percent(view.allocated_ppm)}{drafts.length ? `，保存后 ${percent(projectedPPM)}` : ""} / 上限 {percent(view.item.allocation_limit_ppm)}</span> : <span className="text-muted-foreground">所有子订阅按各自租户余额结算</span>}</div>
    </CardHeader>
    <CardContent className="flex flex-col gap-4">
      <Table>
        <TableHeader><TableRow><TableHead>租户</TableHead><TableHead>子订阅名称</TableHead>{view.item.capacity_mode !== "unmetered" ? <TableHead>父容量份额</TableHead> : null}<TableHead>优先级</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
        <TableBody>
          {children.map((child) => <TableRow key={child.id}>
            <TableCell><div className="font-medium">{tenantByID.get(child.tenant_id)?.name || child.tenant_id}</div><div className="text-xs text-muted-foreground">{tenantByID.get(child.tenant_id)?.owner_email}</div></TableCell>
            <TableCell>{child.name}</TableCell>
            {view.item.capacity_mode !== "unmetered" ? <TableCell className="tabular-nums">{percent(child.allocation_ppm)}</TableCell> : null}
            <TableCell className="tabular-nums">{child.priority}</TableCell>
            <TableCell><Badge variant={child.enabled ? "secondary" : "outline"}>{child.enabled ? "启用" : "停用"}</Badge></TableCell>
            <TableCell><div className="flex justify-end gap-2"><Button size="sm" variant="outline" onClick={() => onEdit(child)}>编辑</Button><Button size="sm" variant="outline" disabled={pending} onClick={() => onToggle(child)}>{child.enabled ? "停用" : "启用"}</Button><Button size="icon-sm" variant="ghost" aria-label="删除子订阅" onClick={() => onRemove(child.id)}><Trash2Icon /></Button></div></TableCell>
          </TableRow>)}
          {drafts.map((row) => <TableRow key={row.id}>
            <TableCell><Select value={row.tenantID} onValueChange={(value) => onDraftChange(row.id, "tenantID", value ?? "")}><SelectTrigger className="min-w-44"><SelectValue placeholder="选择租户" /></SelectTrigger><SelectContent><SelectGroup>{selectableTenants.map((tenant) => <SelectItem key={tenant.id} value={tenant.id}>{tenant.name} · {tenant.owner_email}</SelectItem>)}</SelectGroup></SelectContent></Select></TableCell>
            <TableCell><Input value={row.name} onChange={(event) => onDraftChange(row.id, "name", event.target.value)} placeholder="例如：研发团队" /></TableCell>
            {view.item.capacity_mode !== "unmetered" ? <TableCell><Input className="min-w-28" type="number" min="0.0001" step="0.0001" value={row.percent} onChange={(event) => onDraftChange(row.id, "percent", event.target.value)} aria-label="父容量份额百分比" /></TableCell> : null}
            <TableCell><Input className="min-w-24" type="number" value={row.priority} onChange={(event) => onDraftChange(row.id, "priority", event.target.value)} aria-label="路由优先级" /></TableCell>
            <TableCell><Badge variant="outline">待创建</Badge></TableCell>
            <TableCell className="text-right"><Button size="icon-sm" variant="ghost" aria-label="移除待分配行" onClick={() => onDraftRemove(row.id)}><Trash2Icon /></Button></TableCell>
          </TableRow>)}
        </TableBody>
      </Table>
      {!children.length && !drafts.length ? <Alert><UsersIcon /><AlertTitle>这个父订阅还没有分配给任何人</AlertTitle><AlertDescription>点击下方“添加分配行”，可以连续选择多个租户并一次保存。</AlertDescription></Alert> : null}
      {overAllocated ? <Alert variant="destructive"><AlertTriangleIcon /><AlertTitle>批量分配超出上限</AlertTitle><AlertDescription>当前填写后将达到 {percent(projectedPPM)}，父订阅上限为 {percent(view.item.allocation_limit_ppm)}。</AlertDescription></Alert> : null}
    </CardContent>
    <CardFooter className="flex flex-wrap justify-between gap-2"><Button variant="outline" onClick={onAdd} disabled={pending || !selectableTenants.length}><PlusIcon data-icon="inline-start" />添加分配行</Button>{drafts.length ? <Button onClick={onSave} disabled={pending || overAllocated}>{pending ? <Spinner /> : <SaveIcon data-icon="inline-start" />}保存 {drafts.length} 个子订阅</Button> : null}</CardFooter>
  </Card>
}

function QuotaProbeBadge({ item }: { item: ParentSubscriptionView["item"] }) {
  if (item.quota_probe_status === "supported") return <Badge variant="outline" title={item.quota_observed_at ? `最近观测：${dateTime(item.quota_observed_at)}` : undefined}>自动额度</Badge>
  if (item.quota_probe_status === "unsupported") return <Badge variant="outline">不支持自动额度</Badge>
  if (item.quota_probe_status === "error") return <Badge variant="destructive" title={item.quota_probe_error || "额度探测失败"}>额度探测失败</Badge>
  return <Badge variant="outline">额度待探测</Badge>
}

function ParentReadiness({ view }: { view: ParentSubscriptionView }) {
  if (view.item.capacity_mode === "unmetered") return <Badge variant="outline">无需额度</Badge>
  if (view.windows.length) return <Badge variant="secondary">{view.windows.length} 个美元窗口</Badge>
  if (view.item.quota_probe_status === "error") return <Badge variant="destructive">需要处理</Badge>
  if (view.item.capacity_mode === "observed" && view.item.quota_supported) return <Badge variant="outline">学习中</Badge>
  return <Badge variant="outline">尚未配置</Badge>
}

function parentSelectionHint(view: ParentSubscriptionView) {
  if (view.item.capacity_mode === "unmetered") return "这是余额计费通道，不切分固定额度。"
  if (!view.windows.length) return "父订阅还没有可执行的美元额度；可以先创建份额，额度学习完成后自动生效。"
  return `${view.windows.map((window) => `${window.kind} ${money(window.limit_nano_usd)}`).join(" · ")}；当前还可分 ${percent(Math.max(0, view.item.allocation_limit_ppm - view.allocated_ppm))}。`
}

function TableSkeleton({ columns }: { columns: number }) {
  return <div className="flex flex-col gap-3" aria-label="正在加载订阅"><Skeleton className="h-9 w-full" />{Array.from({ length: 3 }, (_, row) => <div key={row} className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>{Array.from({ length: columns }, (_, column) => <Skeleton key={column} className="h-8 w-full" />)}</div>)}</div>
}

type EditableWindow = { key: string; kind: string; limit: string; reset: string }

function observedEditableWindows(value: ParentSubscriptionView): EditableWindow[] {
  const stored = new Map(value.windows.map((window) => [window.kind, window]))
  const upstream = value.item.quota_snapshot?.windows ?? []
  const result: EditableWindow[] = []
  const seen = new Set<string>()
  for (const window of upstream) {
    const kind = window.kind.trim()
    if (!kind || seen.has(kind) || !window.enforceable || !window.resets_at) continue
    seen.add(kind)
    const saved = stored.get(kind)
    result.push({
      key: crypto.randomUUID(),
      kind,
      limit: saved?.limit_nano_usd ? String(saved.limit_nano_usd / 1_000_000_000) : "",
      reset: localDateTime(window.resets_at),
    })
  }
  return result
}

export function TenantSubscriptionsView() {
  const [items, setItems] = useState<ChildSubscription[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    api<{ items: ChildSubscription[] }>("/api/subscriptions").then((value) => setItems(value.items ?? [])).catch((cause) => toast.error(cause instanceof Error ? cause.message : "无法读取订阅")).finally(() => setLoading(false))
  }, [])
  return <div className="flex flex-col gap-4"><div><h1 className="text-2xl font-semibold tracking-tight">我的订阅</h1><p className="text-sm text-muted-foreground">额度型子订阅继承父账户窗口；API Key 通道按你的账户总余额结算。</p></div>{loading ? <div className="flex justify-center py-12"><Spinner /></div> : items.length ? <div className="grid gap-4 xl:grid-cols-2">{items.map((item) => <TenantSubscriptionCard key={item.id} item={item} />)}</div> : <Empty><EmptyHeader><EmptyMedia variant="icon"><PackageOpenIcon /></EmptyMedia><EmptyTitle>尚未分配子订阅</EmptyTitle><EmptyDescription>当前账户继续使用余额计费；管理员分配后将启用严格父账户路由。</EmptyDescription></EmptyHeader></Empty>}</div>
}

function TenantSubscriptionCard({ item }: { item: ChildSubscription }) {
  const models = item.effective_model_allowlist ?? item.model_allowlist ?? []
  const entitlementWindows = item.entitlement_windows ?? []
  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b bg-muted/15">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{item.name}</CardTitle>
            {item.expires_at ? <CardDescription className="mt-1">有效期至 {dateTime(item.expires_at)}</CardDescription> : null}
          </div>
          <Badge variant={item.enabled ? "secondary" : "outline"}>{item.enabled ? "可用" : "停用"}</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 pt-5">
        {entitlementWindows.length ? (
          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-medium">剩余额度</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {entitlementWindows.map((window, index) => <EntitlementWindow key={`${window.kind}:${index}`} window={window} />)}
            </div>
          </section>
        ) : (
          <Progress value={100} className="rounded-xl border border-dashed bg-muted/10 p-4 [&_[data-slot=progress-indicator]]:bg-muted-foreground/35 [&_[data-slot=progress-track]]:h-2">
            <ProgressLabel>额度同步中</ProgressLabel>
            <Badge variant="outline">学习中</Badge>
            <p className="w-full text-sm text-muted-foreground">正在获取额度窗口和美元金额，同步完成后会自动更新。</p>
          </Progress>
        )}

        <section className="flex flex-col gap-3 border-t pt-4">
          <div className="flex items-center justify-between gap-3">
            <div><h3 className="text-sm font-medium">可用模型</h3><p className="text-xs text-muted-foreground">此订阅当前可以访问的模型。</p></div>
            <Badge variant="secondary">{models.length} 个</Badge>
          </div>
          {models.length ? (
            <div className="flex flex-wrap gap-2 rounded-xl border bg-muted/10 p-3">
              {models.map((model) => <Badge key={model} variant="outline" className="font-mono font-normal">{model}</Badge>)}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">CPA 尚未同步完整模型清单，或当前模型策略包含无法直接枚举的通配范围；请管理员刷新模型账户。</div>
          )}
        </section>
      </CardContent>
    </Card>
  )
}

function EntitlementWindow({ window }: { window: SubscriptionEntitlementWindow }) {
  const remaining = window.limit_nano_usd > 0
    ? Math.min(100, Math.max(0, window.remaining_nano_usd / window.limit_nano_usd * 100))
    : 0
  const roundedRemaining = Math.round(remaining)
  return (
    <Progress value={remaining} className="gap-2.5 rounded-xl border bg-muted/10 p-4 [&_[data-slot=progress-track]]:h-2">
      <ProgressLabel className="text-base">{quotaWindowLabel(window.kind)}</ProgressLabel>
      <Badge variant={roundedRemaining <= 10 ? "destructive" : roundedRemaining <= 25 ? "secondary" : "outline"}>{roundedRemaining === 0 ? "已用光" : `剩余 ${roundedRemaining}%`}</Badge>
      <p className="w-full text-lg font-semibold tabular-nums">{money(window.remaining_nano_usd)} <span className="text-sm font-normal text-muted-foreground">/ {money(window.limit_nano_usd)}</span></p>
      <p className="w-full text-xs text-muted-foreground">{resetDescription(window.resets_at)}</p>
    </Progress>
  )
}

function quotaWindowLabel(kind: string) {
  const normalized = kind.toLowerCase().replaceAll("_", "")
  if (normalized === "5h" || normalized === "fivehour") return "5 小时"
  if (normalized === "7d" || normalized === "weekly" || normalized === "week") return "7 天"
  if (normalized === "monthly" || normalized === "month") return "月度"
  return kind
}

function resetDescription(value: string) {
  const target = new Date(value).getTime()
  const remaining = target - Date.now()
  if (!Number.isFinite(target) || remaining <= 0) return `${dateTime(value)} 重置`
  const minutes = Math.ceil(remaining / 60_000)
  if (minutes < 60) return `${minutes} 分钟后重置`
  const hours = Math.ceil(minutes / 60)
  if (hours < 48) return `${hours} 小时后重置`
  return `${Math.ceil(hours / 24)} 天后重置`
}

function percent(ppm: number) { return `${(ppm / 10_000).toFixed(ppm % 10_000 ? 2 : 0)}%` }
function localDateTime(value?: string) { if (!value) return ""; const date = new Date(value); const offset = date.getTimezoneOffset() * 60_000; return new Date(date.getTime() - offset).toISOString().slice(0, 19) }
function parentModelOptions(parent?: ParentSubscriptionView) { return parent?.item.model_allowlist?.length ? parent.item.model_allowlist : parent?.item.cpa_model_allowlist ?? [] }

function defaultChildName(parent?: ParentSubscription) {
  if (!parent) return ""
  const provider = parent.provider.trim().toLowerCase()
  const product = provider.includes("openai") || provider.includes("codex") || provider.includes("chatgpt")
    ? "ChatGPT"
    : provider.includes("anthropic") || provider.includes("claude")
      ? "Claude"
      : provider.includes("google") || provider.includes("gemini")
        ? "Gemini"
        : ""
  const plan = parent.plan_type.trim()
  if (!product || !plan || ["unknown", "default", "api", "api-key"].includes(plan.toLowerCase())) {
    return parent.name.trim() || product || "子订阅"
  }
  const knownPlans: Record<string, string> = {
    free: "Free", plus: "Plus", pro: "Pro", max: "Max", team: "Team", business: "Business", enterprise: "Enterprise",
  }
  const planLabel = knownPlans[plan.toLowerCase()] ?? plan
  return planLabel.toLowerCase() === product.toLowerCase() ? product : `${product} ${planLabel}`
}

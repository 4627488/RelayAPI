import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react"
import {
  AlertTriangleIcon,
  EllipsisIcon,
  GaugeIcon,
  PackageOpenIcon,
  PlusIcon,
  SearchIcon,
  Settings2Icon,
  Trash2Icon,
  UserPlusIcon,
  UsersIcon,
  WalletCardsIcon,
} from "lucide-react"
import { toast } from "sonner"

import { ModelSelector } from "@/components/model-selector"
import { QuotaSnapshot } from "@/components/quota-snapshot"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Card } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Progress, ProgressLabel } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
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

const capacityModes: Array<{
  value: CapacityMode
  label: string
  description: string
}> = [
  {
    value: "unmetered",
    label: "余额结算",
    description: "固定使用这个模型账户，请求费用从租户余额扣除。",
  },
  {
    value: "observed",
    label: "共享额度",
    description: "按账户额度窗口，将可用容量按比例分配给租户。",
  },
]

const nominalAllocationPPM = 1_000_000

type EditableWindow = {
  key: string
  kind: string
  limit: string
  reset: string
  automaticLimit?: number
}

export function AdminSubscriptionsView() {
  const [parents, setParents] = useState<ParentSubscriptionView[]>([])
  const [children, setChildren] = useState<ChildSubscription[]>([])
  const [tenants, setTenants] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [query, setQuery] = useState("")
  const [selectedParentID, setSelectedParentID] = useState("")
  const [assignOpen, setAssignOpen] = useState(false)
  const [assignParentID, setAssignParentID] = useState("")
  const [assignTenantID, setAssignTenantID] = useState("")
  const [assignTenantIDs, setAssignTenantIDs] = useState<string[]>([])
  const [assignName, setAssignName] = useState("")
  const [assignPercent, setAssignPercent] = useState("10")
  const [assignPriority, setAssignPriority] = useState("100")
  const [assignModels, setAssignModels] = useState<string[]>([])
  const [parentEditor, setParentEditor] =
    useState<ParentSubscriptionView | null>(null)
  const [childEditor, setChildEditor] = useState<ChildSubscription | null>(null)
  const [deletingChild, setDeletingChild] = useState<ChildSubscription | null>(
    null
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [parentValue, childValue, tenantValue] = await Promise.all([
        api<{ items: ParentSubscriptionView[] }>(
          "/api/admin/subscriptions/parents"
        ),
        api<{ items: ChildSubscription[] }>(
          "/api/admin/subscriptions/children"
        ),
        api<{ items: User[] }>("/api/admin/tenants"),
      ])
      const nextParents = parentValue.items ?? []
      const nextChildren = childValue.items ?? []
      const parentIDsWithChildren = new Set(
        nextChildren.map((child) => child.parent_subscription_id)
      )
      const nextVisibleParents = nextParents.filter(
        (view) =>
          view.item.status !== "missing" ||
          parentIDsWithChildren.has(view.item.id)
      )
      setParents(nextParents)
      setChildren(nextChildren)
      setTenants(tenantValue.items ?? [])
      setSelectedParentID((current) =>
        nextVisibleParents.some((view) => view.item.id === current)
          ? current
          : (nextVisibleParents[0]?.item.id ?? "")
      )
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "无法读取订阅分配")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const childCountByParent = useMemo(() => {
    const counts = new Map<string, number>()
    for (const child of children) {
      counts.set(
        child.parent_subscription_id,
        (counts.get(child.parent_subscription_id) ?? 0) + 1
      )
    }
    return counts
  }, [children])

  const visibleParents = useMemo(
    () =>
      parents.filter(
        (view) =>
          view.item.status !== "missing" ||
          (childCountByParent.get(view.item.id) ?? 0) > 0
      ),
    [parents, childCountByParent]
  )
  const currentParents = useMemo(
    () => visibleParents.filter((view) => view.item.status !== "missing"),
    [visibleParents]
  )
  const historicalParents = useMemo(
    () => visibleParents.filter((view) => view.item.status === "missing"),
    [visibleParents]
  )
  const filteredCurrentParents = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return currentParents
    return currentParents.filter((view) =>
      [view.item.name, view.item.provider, view.item.plan_type].some((value) =>
        value?.toLowerCase().includes(needle)
      )
    )
  }, [currentParents, query])
  const filteredHistoricalParents = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return historicalParents
    return historicalParents.filter((view) =>
      [view.item.name, view.item.provider, view.item.plan_type].some((value) =>
        value?.toLowerCase().includes(needle)
      )
    )
  }, [historicalParents, query])

  const selected =
    visibleParents.find((view) => view.item.id === selectedParentID) ??
    visibleParents[0]
  const selectedChildren = selected
    ? children.filter(
        (child) => child.parent_subscription_id === selected.item.id
      )
    : []

  function openAssignment(view: ParentSubscriptionView) {
    setAssignParentID(view.item.id)
    setAssignTenantID("")
    setAssignTenantIDs([])
    setAssignName(defaultChildName(view.item))
    setAssignPercent("10")
    setAssignPriority("100")
    setAssignModels([])
    setAssignOpen(true)
  }

  function changeAssignParent(parentID: string) {
    const view = currentParents.find((item) => item.item.id === parentID)
    setAssignParentID(parentID)
    setAssignName(defaultChildName(view?.item))
    setAssignPercent("10")
    setAssignModels([])
    setAssignTenantID("")
    setAssignTenantIDs([])
  }

  async function createAssignment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const view = currentParents.find((item) => item.item.id === assignParentID)
    const balanceMode = view?.item.capacity_mode === "unmetered"
    if (
      !view ||
      (balanceMode ? assignTenantIDs.length === 0 : !assignTenantID)
    ) {
      toast.error(balanceMode ? "请至少选择一位用户" : "请选择模型账户和租户")
      return
    }
    if (!isAllocatable(view)) {
      toast.error(accountBlockReason(view))
      return
    }
    const allocationPPM =
      view.item.capacity_mode === "unmetered"
        ? 1_000_000
        : Math.round(Number(assignPercent) * 10_000)
    if (
      view.item.capacity_mode !== "unmetered" &&
      (!Number.isFinite(allocationPPM) || allocationPPM <= 0)
    ) {
      toast.error("请输入有效的账户额度占比")
      return
    }
    setPending(true)
    try {
      await postJSON(
        "/api/admin/subscriptions/children",
        balanceMode
          ? {
              tenant_ids: assignTenantIDs,
              parent_subscription_id: view.item.id,
            }
          : {
              tenant_id: assignTenantID,
              parent_subscription_id: view.item.id,
              name: assignName.trim(),
              allocation_ppm: allocationPPM,
              priority: Number(assignPriority || 100),
              enabled: true,
              model_allowlist: assignModels,
              starts_at: new Date().toISOString(),
              expires_at: "",
            }
      )
      setAssignOpen(false)
      toast.success(
        balanceMode ? `已授权 ${assignTenantIDs.length} 位用户` : "已分配给租户"
      )
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
      toast.success(child.enabled ? "授权已停用" : "授权已启用")
      await load()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "更新失败")
    } finally {
      setPending(false)
    }
  }

  async function removeChild() {
    if (!deletingChild) return
    setPending(true)
    try {
      await deleteRequest(
        `/api/admin/subscriptions/children/${deletingChild.id}`
      )
      setDeletingChild(null)
      toast.success("租户授权已删除")
      await load()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "删除失败")
    } finally {
      setPending(false)
    }
  }

  const assignParent = currentParents.find(
    (view) => view.item.id === assignParentID
  )
  const assignPPM = Math.round(Number(assignPercent || 0) * 10_000)
  const projectedAllocationPPM = assignParent
    ? assignParent.allocated_ppm + assignPPM
    : assignPPM
  const alreadyAssignedTenantIDs = new Set(
    children
      .filter((child) => child.parent_subscription_id === assignParentID)
      .map((child) => child.tenant_id)
  )
  const balanceGrantTenants = tenants.filter(
    (tenant) => tenant.enabled && !alreadyAssignedTenantIDs.has(tenant.id)
  )

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">订阅分配</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            选择模型账户，将它的模型和额度能力直接授权给租户。
          </p>
        </div>
        <Button
          disabled={
            !selected ||
            !isAllocatable(selected) ||
            !tenants.some((tenant) => tenant.enabled)
          }
          onClick={() => selected && openAssignment(selected)}
        >
          <UserPlusIcon data-icon="inline-start" />
          {selected?.item.capacity_mode === "unmetered"
            ? "添加用户"
            : "分配给租户"}
        </Button>
      </div>

      {loading ? (
        <AllocationSkeleton />
      ) : !visibleParents.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PackageOpenIcon />
            </EmptyMedia>
            <EmptyTitle>还没有可分配的模型账户</EmptyTitle>
            <EmptyDescription>
              连接模型账户后，它会直接出现在这里，不需要额外同步。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card className="gap-0 py-0 lg:grid lg:grid-cols-[18rem_minmax(0,1fr)]">
          <aside className="border-b bg-muted/20 lg:border-r lg:border-b-0">
            <div className="flex flex-col gap-3 p-4 lg:sticky lg:top-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="font-heading font-medium">模型账户</h2>
                  <p className="text-xs text-muted-foreground">
                    {currentParents.length} 个账户可用于分配
                  </p>
                </div>
                <Badge variant="outline">{visibleParents.length}</Badge>
              </div>
              <InputGroup>
                <InputGroupAddon>
                  <SearchIcon />
                </InputGroupAddon>
                <InputGroupInput
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索账户"
                  aria-label="搜索模型账户"
                />
              </InputGroup>
              <div className="flex max-h-56 flex-col gap-1 overflow-y-auto pr-1 lg:max-h-[calc(100vh-14rem)]">
                {filteredCurrentParents.map((view) => (
                  <ParentListButton
                    key={view.item.id}
                    view={view}
                    active={view.item.id === selected?.item.id}
                    childCount={childCountByParent.get(view.item.id) ?? 0}
                    onSelect={() => setSelectedParentID(view.item.id)}
                  />
                ))}
                {filteredHistoricalParents.length ? (
                  <>
                    <Separator className="my-2" />
                    <p className="px-2 text-xs font-medium text-muted-foreground">
                      历史账户
                    </p>
                    {filteredHistoricalParents.map((view) => (
                      <ParentListButton
                        key={view.item.id}
                        view={view}
                        active={view.item.id === selected?.item.id}
                        childCount={childCountByParent.get(view.item.id) ?? 0}
                        onSelect={() => setSelectedParentID(view.item.id)}
                      />
                    ))}
                  </>
                ) : null}
                {!filteredCurrentParents.length &&
                !filteredHistoricalParents.length ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    没有匹配的账户
                  </p>
                ) : null}
              </div>
            </div>
          </aside>

          {selected ? (
            <AccountAllocationPanel
              view={selected}
              children={selectedChildren}
              tenants={tenants}
              pending={pending}
              onAssign={() => openAssignment(selected)}
              onConfigure={() => setParentEditor(selected)}
              onEdit={setChildEditor}
              onToggle={(child) => void toggleChild(child)}
              onDelete={setDeletingChild}
            />
          ) : null}
        </Card>
      )}

      <Dialog
        open={assignOpen}
        onOpenChange={(open) => {
          if (!pending) setAssignOpen(open)
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {assignParent?.item.capacity_mode === "unmetered"
                ? "授权用户"
                : "分配共享额度"}
            </DialogTitle>
            <DialogDescription>
              {assignParent?.item.capacity_mode === "unmetered"
                ? "所选用户将获得该账户的全部模型权限，调用费用从各自余额扣除。"
                : "为一个租户创建带独立份额的额度授权。"}
            </DialogDescription>
          </DialogHeader>
          <form id="assign-subscription-form" onSubmit={createAssignment}>
            <FieldGroup>
              <Field>
                <FieldLabel>模型账户</FieldLabel>
                <Select
                  value={assignParentID}
                  onValueChange={(value) => changeAssignParent(value ?? "")}
                  required
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择模型账户" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {currentParents.map((view) => (
                        <SelectItem
                          key={view.item.id}
                          value={view.item.id}
                          disabled={!isAllocatable(view)}
                        >
                          {view.item.name} · {billingLabel(view)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {assignParent ? (
                  <FieldDescription>
                    {isAllocatable(assignParent)
                      ? accountAllocationHint(assignParent)
                      : accountBlockReason(assignParent)}
                  </FieldDescription>
                ) : null}
              </Field>

              {assignParent?.item.capacity_mode === "unmetered" ? (
                <Field>
                  <FieldLabel>用户</FieldLabel>
                  {balanceGrantTenants.length ? (
                    <div className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-lg border p-2">
                      {balanceGrantTenants.map((tenant) => {
                        const checked = assignTenantIDs.includes(tenant.id)
                        return (
                          <label
                            key={tenant.id}
                            className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/60"
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(value) =>
                                setAssignTenantIDs((current) =>
                                  value
                                    ? [...current, tenant.id]
                                    : current.filter((id) => id !== tenant.id)
                                )
                              }
                            />
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium">
                                {tenant.name}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {tenant.owner_email}
                              </span>
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                      所有可用用户都已获得该账户权限。
                    </div>
                  )}
                  <FieldDescription>
                    已选择 {assignTenantIDs.length}{" "}
                    位；以后仍可继续添加其他用户。
                  </FieldDescription>
                </Field>
              ) : (
                <Field>
                  <FieldLabel>租户</FieldLabel>
                  <Select
                    value={assignTenantID}
                    onValueChange={(value) => setAssignTenantID(value ?? "")}
                    required
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="选择租户" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {tenants
                          .filter((tenant) => tenant.enabled)
                          .map((tenant) => (
                            <SelectItem key={tenant.id} value={tenant.id}>
                              {tenant.name} · {tenant.owner_email}
                            </SelectItem>
                          ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              )}

              {assignParent?.item.capacity_mode !== "unmetered" ? (
                <Field>
                  <FieldLabel htmlFor="assign-name">授权名称</FieldLabel>
                  <Input
                    id="assign-name"
                    value={assignName}
                    onChange={(event) => setAssignName(event.target.value)}
                    placeholder="例如：研发团队"
                    required
                  />
                </Field>
              ) : null}

              {assignParent?.item.capacity_mode === "observed" ? (
                <Field>
                  <FieldLabel htmlFor="assign-percent">账户额度占比</FieldLabel>
                  <Input
                    id="assign-percent"
                    type="number"
                    min="0.0001"
                    step="0.0001"
                    value={assignPercent}
                    onChange={(event) => setAssignPercent(event.target.value)}
                    required
                  />
                  <FieldDescription>
                    分配后总计 {percent(projectedAllocationPPM)}；允许超过
                    100%。
                  </FieldDescription>
                  {projectedAllocationPPM > nominalAllocationPPM ? (
                    <OversubscriptionWarning
                      allocatedPPM={projectedAllocationPPM}
                    />
                  ) : null}
                </Field>
              ) : null}

              {assignParent?.item.capacity_mode !== "unmetered" ? (
                <Field>
                  <FieldLabel htmlFor="assign-priority">路由优先级</FieldLabel>
                  <Input
                    id="assign-priority"
                    type="number"
                    value={assignPriority}
                    onChange={(event) => setAssignPriority(event.target.value)}
                    required
                  />
                  <FieldDescription>
                    同一租户有多个可用账户时，数值越大越优先。
                  </FieldDescription>
                </Field>
              ) : null}

              {assignParent?.item.capacity_mode !== "unmetered" ? (
                <Field>
                  <FieldLabel htmlFor="assign-models">可用模型</FieldLabel>
                  <ModelSelector
                    id="assign-models"
                    options={parentModelOptions(assignParent)}
                    value={assignModels}
                    onChange={setAssignModels}
                    allLabel="继承账户全部模型"
                  />
                </Field>
              ) : null}
            </FieldGroup>
          </form>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setAssignOpen(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              form="assign-subscription-form"
              disabled={
                pending ||
                (assignParent?.item.capacity_mode === "unmetered" &&
                  assignTenantIDs.length === 0)
              }
            >
              {pending ? <Spinner /> : <PlusIcon data-icon="inline-start" />}
              {assignParent?.item.capacity_mode === "unmetered"
                ? "确认授权"
                : "确认分配"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ParentSettingsDialog
        value={parentEditor}
        pending={pending}
        onPending={setPending}
        onClose={() => setParentEditor(null)}
        onSaved={load}
      />
      <ChildSettingsDialog
        value={childEditor}
        parents={visibleParents}
        pending={pending}
        onPending={setPending}
        onClose={() => setChildEditor(null)}
        onSaved={load}
      />

      <AlertDialog
        open={Boolean(deletingChild)}
        onOpenChange={(open) => {
          if (!open && !pending) setDeletingChild(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这条租户授权？</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingChild
                ? `“${deletingChild.name}”将立即停止路由到这个模型账户。`
                : "该授权将被删除。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={() => void removeChild()}
            >
              {pending ? <Spinner /> : <Trash2Icon data-icon="inline-start" />}
              删除授权
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function ParentListButton({
  view,
  active,
  childCount,
  onSelect,
}: {
  view: ParentSubscriptionView
  active: boolean
  childCount: number
  onSelect: () => void
}) {
  return (
    <Button
      variant={active ? "secondary" : "ghost"}
      className="h-auto w-full justify-start px-2 py-2 text-left"
      onClick={onSelect}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{view.item.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {view.item.provider || "未知提供商"}
          {displayPlan(view.item.plan_type)
            ? ` · ${displayPlan(view.item.plan_type)}`
            : ""}
        </p>
      </div>
      <Badge variant="outline">{childCount}</Badge>
    </Button>
  )
}

function AccountAllocationPanel({
  view,
  children,
  tenants,
  pending,
  onAssign,
  onConfigure,
  onEdit,
  onToggle,
  onDelete,
}: {
  view: ParentSubscriptionView
  children: ChildSubscription[]
  tenants: User[]
  pending: boolean
  onAssign: () => void
  onConfigure: () => void
  onEdit: (child: ChildSubscription) => void
  onToggle: (child: ChildSubscription) => void
  onDelete: (child: ChildSubscription) => void
}) {
  const tenantByID = new Map(tenants.map((tenant) => [tenant.id, tenant]))
  const allocationPercent = Math.min(
    100,
    (view.allocated_ppm / nominalAllocationPPM) * 100
  )
  const oversubscribed = view.allocated_ppm > nominalAllocationPPM

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex flex-col gap-4 border-b px-4 py-4 sm:px-6 sm:py-5 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-heading text-lg leading-tight font-semibold sm:text-xl">
              {view.item.name}
            </h2>
            <AccountStatusBadge view={view} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {view.item.provider || "未知提供商"}
            {displayPlan(view.item.plan_type)
              ? ` · ${displayPlan(view.item.plan_type)}`
              : ""}
            {` · ${billingLabel(view)}`}
          </p>
        </div>
        {view.item.status !== "missing" ? (
          <div className="shrink-0">
            <Button size="sm" variant="outline" onClick={onConfigure}>
              <Settings2Icon data-icon="inline-start" />
              账户规则
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-6 px-4 py-5 sm:px-6">
        <div className="grid grid-cols-3 overflow-hidden rounded-xl border bg-muted/20">
          <AccountFact
            icon={<UsersIcon />}
            label={
              view.item.capacity_mode === "unmetered" ? "授权用户" : "租户授权"
            }
            value={`${children.length} ${view.item.capacity_mode === "unmetered" ? "人" : "条"}`}
          />
          <AccountFact
            icon={<PackageOpenIcon />}
            label="可用模型"
            value={`${parentModelOptions(view).length} 个`}
          />
          <AccountFact
            icon={
              view.item.capacity_mode === "unmetered" ? (
                <WalletCardsIcon />
              ) : (
                <GaugeIcon />
              )
            }
            label="结算方式"
            value={billingLabel(view)}
          />
        </div>

        {view.item.capacity_mode === "observed" ? (
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium">账户额度</h3>
                <p className="text-xs text-muted-foreground">
                  上游额度和租户分配使用同一份账户数据。
                </p>
              </div>
              <Badge variant="outline">
                已分配 {percent(view.allocated_ppm)}
              </Badge>
            </div>
            <Progress value={allocationPercent}>
              <ProgressLabel>已分配比例</ProgressLabel>
              <span className="ml-auto text-sm text-muted-foreground tabular-nums">
                {Math.round(allocationPercent)}%
              </span>
            </Progress>
            {oversubscribed ? (
              <OversubscriptionWarning allocatedPPM={view.allocated_ppm} />
            ) : null}
            <QuotaSnapshot
              snapshot={view.item.quota_snapshot}
              status={view.item.quota_probe_status}
              error={view.item.quota_probe_error}
              observedAt={view.item.quota_observed_at}
              configuredWindows={view.windows}
              compact
            />
          </section>
        ) : null}

        {!isAllocatable(view) ? (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>当前账户不能继续分配</AlertTitle>
            <AlertDescription>{accountBlockReason(view)}</AlertDescription>
          </Alert>
        ) : null}

        <Separator />

        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="font-medium">租户授权</h3>
              <p className="text-xs text-muted-foreground">
                {view.item.capacity_mode === "unmetered"
                  ? "授权用户继承账户全部模型，调用费用从各自余额扣除。"
                  : "每条授权决定租户可以使用的模型、份额与路由优先级。"}
              </p>
            </div>
            <Button
              size="sm"
              className="w-full sm:w-auto"
              disabled={!isAllocatable(view)}
              onClick={onAssign}
            >
              <PlusIcon data-icon="inline-start" />
              {view.item.capacity_mode === "unmetered"
                ? "添加用户"
                : "新增授权"}
            </Button>
          </div>

          {children.length ? (
            <>
              <div className="flex flex-col gap-2 md:hidden">
                {children.map((child) => (
                  <MobileChildGrant
                    key={child.id}
                    child={child}
                    tenant={tenantByID.get(child.tenant_id)}
                    view={view}
                    pending={pending}
                    onEdit={() => onEdit(child)}
                    onToggle={() => onToggle(child)}
                    onDelete={() => onDelete(child)}
                  />
                ))}
              </div>
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>租户</TableHead>
                      <TableHead>
                        {view.item.capacity_mode === "unmetered"
                          ? "可用模型"
                          : "授权范围"}
                      </TableHead>
                      <TableHead>
                        {view.item.capacity_mode === "unmetered"
                          ? "结算"
                          : "剩余额度"}
                      </TableHead>
                      {view.item.capacity_mode === "observed" ? (
                        <TableHead>优先级</TableHead>
                      ) : null}
                      <TableHead>状态</TableHead>
                      <TableHead className="w-12" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {children.map((child) => {
                      const tenant = tenantByID.get(child.tenant_id)
                      return (
                        <TableRow key={child.id}>
                          <TableCell>
                            <p className="font-medium">
                              {tenant?.name || child.tenant_id}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {tenant?.owner_email}
                            </p>
                          </TableCell>
                          <TableCell>
                            {view.item.capacity_mode === "unmetered" ? (
                              <p>
                                {parentModelOptions(view).length
                                  ? `账户全部 ${parentModelOptions(view).length} 个模型`
                                  : "账户全部模型"}
                              </p>
                            ) : (
                              <>
                                <p>{child.name}</p>
                                <p className="text-xs text-muted-foreground">
                                  {child.model_allowlist?.length
                                    ? `限定 ${child.model_allowlist.length} 个模型`
                                    : "继承账户全部模型"}
                                </p>
                              </>
                            )}
                          </TableCell>
                          <TableCell>
                            <ChildQuotaProgress
                              child={child}
                              capacityMode={view.item.capacity_mode}
                            />
                          </TableCell>
                          {view.item.capacity_mode === "observed" ? (
                            <TableCell className="tabular-nums">
                              {child.priority}
                            </TableCell>
                          ) : null}
                          <TableCell>
                            <ChildStatusBadge child={child} />
                          </TableCell>
                          <TableCell>
                            <ChildGrantMenu
                              child={child}
                              capacityMode={view.item.capacity_mode}
                              pending={pending}
                              onEdit={() => onEdit(child)}
                              onToggle={() => onToggle(child)}
                              onDelete={() => onDelete(child)}
                            />
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          ) : (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <UsersIcon />
                </EmptyMedia>
                <EmptyTitle>尚未分配给任何租户</EmptyTitle>
                <EmptyDescription>
                  {view.item.capacity_mode === "unmetered"
                    ? "添加用户后，他们会获得这个账户的全部模型权限。"
                    : "新增授权后，租户请求会严格路由到这个模型账户。"}
                </EmptyDescription>
              </EmptyHeader>
              <Button disabled={!isAllocatable(view)} onClick={onAssign}>
                <UserPlusIcon data-icon="inline-start" />
                {view.item.capacity_mode === "unmetered"
                  ? "添加用户"
                  : "分配给租户"}
              </Button>
            </Empty>
          )}
        </section>
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 border-t bg-muted/30 px-4 py-3 sm:px-6">
        <p className="text-xs text-muted-foreground">
          账户与授权数据保存后立即生效。
        </p>
        <Badge variant="outline">无需同步</Badge>
      </div>
    </div>
  )
}

function MobileChildGrant({
  child,
  tenant,
  view,
  pending,
  onEdit,
  onToggle,
  onDelete,
}: {
  child: ChildSubscription
  tenant?: User
  view: ParentSubscriptionView
  pending: boolean
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
}) {
  const balanceMode = view.item.capacity_mode === "unmetered"
  const modelCount = parentModelOptions(view).length
  return (
    <div className="rounded-xl border p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">
            {tenant?.name || child.tenant_id}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {tenant?.owner_email || "未找到租户资料"}
          </p>
        </div>
        <ChildStatusBadge child={child} />
        <ChildGrantMenu
          child={child}
          capacityMode={view.item.capacity_mode}
          pending={pending}
          onEdit={onEdit}
          onToggle={onToggle}
          onDelete={onDelete}
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 rounded-lg bg-muted/50 p-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            {balanceMode ? "可用模型" : "授权范围"}
          </p>
          <p className="mt-0.5 truncate text-sm font-medium">
            {balanceMode
              ? modelCount
                ? `全部 ${modelCount} 个模型`
                : "账户全部模型"
              : child.model_allowlist?.length
                ? `限定 ${child.model_allowlist.length} 个模型`
                : "继承全部模型"}
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            {balanceMode ? "结算方式" : "路由优先级"}
          </p>
          <p className="mt-0.5 truncate text-sm font-medium">
            {balanceMode ? "租户余额" : child.priority}
          </p>
        </div>
      </div>

      {!balanceMode ? (
        <div className="mt-3">
          <p className="mb-2 text-xs text-muted-foreground">剩余额度</p>
          <ChildQuotaProgress
            child={child}
            capacityMode={view.item.capacity_mode}
          />
        </div>
      ) : null}
    </div>
  )
}

function OversubscriptionWarning({ allocatedPPM }: { allocatedPPM: number }) {
  return (
    <Alert className="border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300">
      <AlertTriangleIcon />
      <AlertTitle>共享额度已超卖</AlertTitle>
      <AlertDescription className="text-amber-700/90 dark:text-amber-300/80">
        当前总分配为 {percent(allocatedPPM)}
        。系统不会阻止继续分配，但多个租户同时高负载时可能提前耗尽上游额度。
      </AlertDescription>
    </Alert>
  )
}

function ChildGrantMenu({
  child,
  capacityMode,
  pending,
  onEdit,
  onToggle,
  onDelete,
}: {
  child: ChildSubscription
  capacityMode: CapacityMode
  pending: boolean
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`管理 ${child.name}`}
          />
        }
      >
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          {capacityMode === "observed" ? (
            <DropdownMenuItem onClick={onEdit}>编辑授权</DropdownMenuItem>
          ) : null}
          <DropdownMenuItem disabled={pending} onClick={onToggle}>
            {child.enabled ? "停用授权" : "启用授权"}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            删除授权
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ChildQuotaProgress({
  child,
  capacityMode,
}: {
  child: ChildSubscription
  capacityMode: CapacityMode
}) {
  if (capacityMode === "unmetered") {
    return (
      <div className="min-w-0">
        <p className="text-sm">租户余额结算</p>
        <p className="text-xs text-muted-foreground">不占共享额度</p>
      </div>
    )
  }
  const windows = child.entitlement_windows ?? []
  if (!windows.length) {
    return (
      <div className="min-w-0">
        <p className="text-sm">{percent(child.allocation_ppm)} 份额</p>
        <p className="text-xs text-muted-foreground">等待额度同步</p>
      </div>
    )
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {windows.map((window) => (
        <ChildQuotaWindowProgress
          key={`${child.id}:${window.kind}`}
          window={window}
        />
      ))}
    </div>
  )
}

function ChildQuotaWindowProgress({
  window,
}: {
  window: SubscriptionEntitlementWindow
}) {
  const remainingPercent =
    window.limit_nano_usd > 0
      ? Math.min(
          100,
          Math.max(0, (window.remaining_nano_usd / window.limit_nano_usd) * 100)
        )
      : 0
  return (
    <Progress
      value={remainingPercent}
      className="gap-1 [&_[data-slot=progress-track]]:h-1.5"
    >
      <ProgressLabel className="text-xs font-normal">
        {quotaWindowLabel(window.kind)} · {money(window.remaining_nano_usd)}
      </ProgressLabel>
      <span className="ml-auto text-xs text-muted-foreground tabular-nums">
        {Math.round(remainingPercent)}%
      </span>
    </Progress>
  )
}

function AccountFact({
  icon,
  label,
  value,
}: {
  icon: ReactNode
  label: string
  value: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-r px-3 py-3 last:border-r-0 sm:flex-row sm:items-center sm:gap-3 sm:px-4 sm:py-4">
      <div className="hidden shrink-0 text-muted-foreground sm:block [&_svg]:size-5">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <p className="truncate text-sm font-medium sm:text-base">{value}</p>
      </div>
    </div>
  )
}

function ParentSettingsDialog({
  value,
  pending,
  onPending,
  onClose,
  onSaved,
}: {
  value: ParentSubscriptionView | null
  pending: boolean
  onPending: (value: boolean) => void
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [mode, setMode] = useState<CapacityMode>("unmetered")
  const [enabled, setEnabled] = useState(true)
  const [models, setModels] = useState<string[]>([])
  const [windows, setWindows] = useState<EditableWindow[]>([])

  useEffect(() => {
    if (!value) return
    setMode(value.item.capacity_mode)
    setEnabled(value.item.enabled)
    setModels(value.item.model_allowlist ?? [])
    setWindows(observedEditableWindows(value))
  }, [value])

  if (!value) return null
  const current = value

  function changeMode(next: unknown) {
    if (next === "unmetered" || next === "observed") setMode(next)
  }

  function updateWindow(key: string, limit: string) {
    setWindows((items) =>
      items.map((item) => (item.key === key ? { ...item, limit } : item))
    )
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    if (mode === "observed" && !windows.length) {
      toast.error("这个账户没有可配置的额度窗口，请选择余额结算")
      return
    }
    onPending(true)
    try {
      const windowItems = windows
        .filter((window) => window.limit.trim())
        .map((window) => {
          const limit = Math.round(Number(window.limit) * 1_000_000_000)
          if (!Number.isFinite(limit) || limit <= 0) {
            throw new Error(`请填写 ${window.kind} 的 USD 容量`)
          }
          return { kind: window.kind, limit_nano_usd: limit }
        })
      await api(`/api/admin/subscriptions/parents/${current.item.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: String(form.get("name") || ""),
          capacity_mode: mode,
          enabled,
          model_allowlist: models,
        }),
      })
      if (mode === "observed") {
        await api(
          `/api/admin/subscriptions/parents/${current.item.id}/windows`,
          { method: "PUT", body: JSON.stringify({ items: windowItems }) }
        )
      }
      toast.success("账户分配规则已保存")
      onClose()
      await onSaved()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "保存失败")
    } finally {
      onPending(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>账户分配规则</DialogTitle>
          <DialogDescription>
            {current.item.provider || "未知提供商"}
            {displayPlan(current.item.plan_type)
              ? ` · ${displayPlan(current.item.plan_type)}`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <form id="parent-settings-form" onSubmit={save}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="parent-name">显示名称</FieldLabel>
              <Input
                id="parent-name"
                name="name"
                defaultValue={current.item.name}
                required
              />
            </Field>

            <Field>
              <FieldLabel>结算方式</FieldLabel>
              <ToggleGroup
                value={[mode]}
                onValueChange={(values) => changeMode(values[0])}
                variant="outline"
                className="w-full"
              >
                {capacityModes.map((item) => (
                  <ToggleGroupItem
                    key={item.value}
                    value={item.value}
                    className="flex-1"
                  >
                    {item.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <FieldDescription>
                {capacityModes.find((item) => item.value === mode)?.description}
              </FieldDescription>
            </Field>

            {mode === "observed" ? (
              <>
                <Field>
                  <FieldLabel>账户额度</FieldLabel>
                  <QuotaSnapshot
                    snapshot={current.item.quota_snapshot}
                    status={current.item.quota_probe_status}
                    error={current.item.quota_probe_error}
                    observedAt={current.item.quota_observed_at}
                    configuredWindows={current.windows}
                  />
                  {!windows.length ? (
                    <Alert variant="destructive">
                      <AlertTriangleIcon />
                      <AlertTitle>没有可分配的额度窗口</AlertTitle>
                      <AlertDescription>
                        这个账户当前只能使用余额结算。
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <FieldGroup>
                      {windows.map((window) => (
                        <Field key={window.key} orientation="horizontal">
                          <div className="min-w-0 flex-1">
                            <FieldLabel htmlFor={`${window.key}-limit`}>
                              {quotaWindowLabel(window.kind)}
                            </FieldLabel>
                            <FieldDescription>
                              {dateTime(new Date(window.reset).toISOString())}{" "}
                              重置
                              {" · 留空则继续自动推测"}
                            </FieldDescription>
                          </div>
                          <InputGroup className="w-40">
                            <InputGroupInput
                              id={`${window.key}-limit`}
                              type="number"
                              min="0.000001"
                              step="0.000001"
                              value={window.limit}
                              onChange={(event) =>
                                updateWindow(window.key, event.target.value)
                              }
                              placeholder={
                                window.automaticLimit
                                  ? quotaUSDInputValue(window.automaticLimit)
                                  : "自动推测"
                              }
                            />
                            <InputGroupAddon align="inline-end">
                              USD
                            </InputGroupAddon>
                          </InputGroup>
                        </Field>
                      ))}
                    </FieldGroup>
                  )}
                </Field>
              </>
            ) : null}

            <Field>
              <FieldLabel htmlFor="parent-models">账户模型范围</FieldLabel>
              <ModelSelector
                id="parent-models"
                options={current.item.cpa_model_allowlist ?? []}
                value={models}
                onChange={setModels}
              />
              <FieldDescription>
                不选择表示允许账户当前提供的全部模型。
              </FieldDescription>
            </Field>

            <Field orientation="horizontal">
              <div className="flex-1">
                <FieldLabel htmlFor="parent-enabled">允许租户使用</FieldLabel>
                <FieldDescription>
                  关闭后，已有授权会保留，但请求不会路由到这个账户。
                </FieldDescription>
              </div>
              <Switch
                id="parent-enabled"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
            </Field>
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" form="parent-settings-form" disabled={pending}>
            {pending ? <Spinner /> : null}
            保存规则
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ChildSettingsDialog({
  value,
  parents,
  pending,
  onPending,
  onClose,
  onSaved,
}: {
  value: ChildSubscription | null
  parents: ParentSubscriptionView[]
  pending: boolean
  onPending: (value: boolean) => void
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [parentID, setParentID] = useState("")
  const [models, setModels] = useState<string[]>([])
  const [enabled, setEnabled] = useState(true)
  const [allocationPercent, setAllocationPercent] = useState("")

  useEffect(() => {
    if (!value) return
    setParentID(value.parent_subscription_id)
    setModels(value.model_allowlist ?? [])
    setEnabled(value.enabled)
    setAllocationPercent(String(value.allocation_ppm / 10_000))
  }, [value])

  if (!value) return null
  const current = value
  const selectedParent = parents.find((view) => view.item.id === parentID)
  const editedAllocationPPM = Math.round(
    Number(allocationPercent || 0) * 10_000
  )
  const currentAllocationInSelectedParent =
    current.parent_subscription_id === selectedParent?.item.id &&
    current.enabled
      ? current.allocation_ppm
      : 0
  const projectedAllocationPPM = selectedParent
    ? selectedParent.allocated_ppm -
      currentAllocationInSelectedParent +
      (enabled && selectedParent.item.capacity_mode === "observed"
        ? editedAllocationPPM
        : 0)
    : 0

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedParent) {
      toast.error("请选择模型账户")
      return
    }
    const form = new FormData(event.currentTarget)
    onPending(true)
    try {
      await api(`/api/admin/subscriptions/children/${current.id}`, {
        method: "PUT",
        body: JSON.stringify({
          tenant_id: current.tenant_id,
          parent_subscription_id: selectedParent.item.id,
          name: String(form.get("name") || ""),
          allocation_ppm:
            selectedParent.item.capacity_mode === "unmetered"
              ? 1_000_000
              : editedAllocationPPM,
          priority: Number(form.get("priority") || 100),
          enabled,
          model_allowlist: models,
          starts_at: new Date(String(form.get("starts_at"))).toISOString(),
          expires_at: form.get("expires_at")
            ? new Date(String(form.get("expires_at"))).toISOString()
            : "",
        }),
      })
      toast.success("租户授权已保存")
      onClose()
      await onSaved()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "保存失败")
    } finally {
      onPending(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑租户授权</DialogTitle>
          <DialogDescription>
            修改模型范围、账户份额和路由优先级。
          </DialogDescription>
        </DialogHeader>
        <form id="child-settings-form" onSubmit={save}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="child-name">授权名称</FieldLabel>
              <Input
                id="child-name"
                name="name"
                defaultValue={current.name}
                required
              />
            </Field>

            <Field>
              <FieldLabel>模型账户</FieldLabel>
              <Select
                value={parentID}
                onValueChange={(value) => {
                  setParentID(value ?? "")
                  setModels([])
                }}
                required
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {parents.map((view) => (
                      <SelectItem
                        key={view.item.id}
                        value={view.item.id}
                        disabled={!isAllocatable(view)}
                      >
                        {view.item.name} · {billingLabel(view)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            {selectedParent?.item.capacity_mode === "observed" ? (
              <Field>
                <FieldLabel htmlFor="child-percent">账户额度占比</FieldLabel>
                <Input
                  id="child-percent"
                  name="percent"
                  type="number"
                  min="0.0001"
                  step="0.0001"
                  value={allocationPercent}
                  onChange={(event) => setAllocationPercent(event.target.value)}
                  required
                />
                <FieldDescription>
                  保存后账户总计 {percent(projectedAllocationPPM)}；允许超过
                  100%。
                </FieldDescription>
                {projectedAllocationPPM > nominalAllocationPPM ? (
                  <OversubscriptionWarning
                    allocatedPPM={projectedAllocationPPM}
                  />
                ) : null}
              </Field>
            ) : null}

            <Field>
              <FieldLabel htmlFor="child-priority">路由优先级</FieldLabel>
              <Input
                id="child-priority"
                name="priority"
                type="number"
                defaultValue={current.priority}
                required
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="child-starts-at">生效时间</FieldLabel>
              <Input
                id="child-starts-at"
                name="starts_at"
                type="datetime-local"
                step="1"
                defaultValue={localDateTime(current.starts_at)}
                required
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="child-expires-at">到期时间</FieldLabel>
              <Input
                id="child-expires-at"
                name="expires_at"
                type="datetime-local"
                step="1"
                defaultValue={localDateTime(current.expires_at ?? undefined)}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="child-models">可用模型</FieldLabel>
              <ModelSelector
                id="child-models"
                options={parentModelOptions(selectedParent)}
                value={models}
                onChange={setModels}
                allLabel="继承账户全部模型"
              />
            </Field>

            <Field orientation="horizontal">
              <div className="flex-1">
                <FieldLabel htmlFor="child-enabled">启用授权</FieldLabel>
                <FieldDescription>
                  停用不会删除配置，可以随时重新启用。
                </FieldDescription>
              </div>
              <Switch
                id="child-enabled"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
            </Field>
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" form="child-settings-form" disabled={pending}>
            {pending ? <Spinner /> : null}
            保存授权
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AccountStatusBadge({ view }: { view: ParentSubscriptionView }) {
  if (view.item.status === "missing")
    return <Badge variant="outline">账户已删除</Badge>
  if (!view.item.enabled) return <Badge variant="secondary">已停用</Badge>
  if (view.item.cpa_unavailable)
    return <Badge variant="destructive">账户不可用</Badge>
  if (view.item.capacity_mode === "observed" && !view.windows.length)
    return <Badge variant="outline">额度学习中</Badge>
  return <Badge variant="secondary">可分配</Badge>
}

function ChildStatusBadge({ child }: { child: ChildSubscription }) {
  if (!child.enabled) return <Badge variant="outline">已停用</Badge>
  if (child.available === false)
    return (
      <Badge variant="destructive" title={child.availability_message}>
        不可用
      </Badge>
    )
  return <Badge variant="secondary">生效中</Badge>
}

function isAllocatable(view: ParentSubscriptionView) {
  if (!view.item.enabled || view.item.cpa_unavailable) return false
  return (
    view.item.capacity_mode === "unmetered" ||
    view.windows.length > 0 ||
    hasObservableQuota(view)
  )
}

function accountBlockReason(view: ParentSubscriptionView) {
  if (view.item.status === "missing")
    return "模型账户已删除；历史授权仅可迁移到其他账户或删除。"
  if (!view.item.enabled) return "账户分配规则已停用。"
  if (view.item.cpa_unavailable) return "模型账户当前不可用，请先检查账户状态。"
  if (view.item.capacity_mode === "observed" && !view.windows.length)
    return view.item.quota_probe_status === "unsupported"
      ? "上游不支持额度观测，请改为余额结算。"
      : "尚未发现可校准的上游额度窗口。"
  return "当前账户不可分配。"
}

function billingLabel(view: ParentSubscriptionView) {
  return view.item.capacity_mode === "unmetered" ? "余额结算" : "共享额度"
}

function accountAllocationHint(view: ParentSubscriptionView) {
  if (view.item.capacity_mode === "unmetered")
    return "请求固定到这个账户，并从租户余额结算。"
  if (!view.windows.length)
    return "额度学习中；请求先从租户余额结算，校准完成后自动切换为共享额度。"
  const allocation = percent(view.allocated_ppm)
  return view.allocated_ppm > nominalAllocationPPM
    ? `当前已分配 ${allocation}，处于超卖状态；仍可继续分配。`
    : `当前已分配 ${allocation}；允许超卖，包含 ${view.windows.length} 个额度窗口。`
}

function displayPlan(value?: string) {
  const plan = value?.trim() ?? ""
  return !plan || plan === "native" ? "" : plan
}

function parentModelOptions(parent?: ParentSubscriptionView) {
  return parent?.item.model_allowlist?.length
    ? parent.item.model_allowlist
    : (parent?.item.cpa_model_allowlist ?? [])
}

function observedEditableWindows(value: ParentSubscriptionView) {
  const stored = new Map(value.windows.map((window) => [window.kind, window]))
  const result: EditableWindow[] = []
  const seen = new Set<string>()
  for (const window of value.item.quota_snapshot?.windows ?? []) {
    const kind = window.kind.trim()
    if (!kind || seen.has(kind) || !window.enforceable || !window.resets_at)
      continue
    seen.add(kind)
    const configured = stored.get(kind)
    result.push({
      key: crypto.randomUUID(),
      kind,
      limit:
        configured?.limit_nano_usd && configured.source === "manual_conversion"
          ? String(configured.limit_nano_usd / 1_000_000_000)
          : "",
      reset: localDateTime(window.resets_at),
      automaticLimit:
        configured && configured.source !== "manual_conversion"
          ? configured.limit_nano_usd
          : undefined,
    })
  }
  return result
}

function hasObservableQuota(view: ParentSubscriptionView) {
  if (view.item.quota_probe_status === "unsupported") return false
  return (view.item.quota_snapshot?.windows ?? []).some(
    (window) => window.enforceable && Boolean(window.resets_at)
  )
}

function quotaUSDInputValue(nanoUSD: number) {
  return (nanoUSD / 1_000_000_000).toFixed(6).replace(/\.?0+$/, "")
}

function defaultChildName(parent?: ParentSubscription) {
  if (!parent) return ""
  const provider = parent.provider.trim().toLowerCase()
  const product =
    provider.includes("openai") ||
    provider.includes("codex") ||
    provider.includes("chatgpt")
      ? "ChatGPT"
      : provider.includes("anthropic") || provider.includes("claude")
        ? "Claude"
        : provider.includes("google") || provider.includes("gemini")
          ? "Gemini"
          : parent.name.trim()
  const plan = displayPlan(parent.plan_type)
  return plan ? `${product} ${plan}` : product || "租户授权"
}

function quotaWindowLabel(kind: string) {
  const normalized = kind.toLowerCase().replaceAll("_", "")
  if (normalized === "5h" || normalized === "fivehour") return "5 小时"
  if (normalized === "7d" || normalized === "weekly" || normalized === "week")
    return "7 天"
  if (normalized === "monthly" || normalized === "month") return "月度"
  return kind
}

function percent(ppm: number) {
  return `${(ppm / 10_000).toFixed(ppm % 10_000 ? 2 : 0)}%`
}

function localDateTime(value?: string) {
  if (!value) return ""
  const date = new Date(value)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 19)
}

function AllocationSkeleton() {
  return (
    <Card className="gap-0 py-0 lg:grid lg:grid-cols-[18rem_minmax(0,1fr)]">
      <div className="flex flex-col gap-3 border-b bg-muted/20 p-4 lg:border-r lg:border-b-0">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-8 w-full" />
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
      <div className="flex flex-col">
        <div className="flex flex-col gap-2 border-b px-4 py-5 sm:px-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
        <div className="flex flex-col gap-5 px-4 py-5 sm:px-6">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      </div>
    </Card>
  )
}

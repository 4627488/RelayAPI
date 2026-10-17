import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react"
import {
  AlertCircleIcon,
  EllipsisIcon,
  PackageOpenIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  Trash2Icon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react"
import { toast } from "@/components/ui/toast"

import { ModelSelector } from "@/components/model-selector"
import { QuotaSnapshot } from "@/components/quota-snapshot"
import { PageHeader, SearchField } from "@/components/workspace-ui"
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
  type CapacityMode,
  type ChildSubscription,
  type ParentSubscription,
  type ParentSubscriptionView,
  type SubscriptionEntitlementWindow,
  type User,
} from "@/lib/api"
import { dateTime, money } from "@/lib/format"

const AssignUsersDialog = lazy(() =>
  import("@/components/admin/assign-users-dialog").then((module) => ({
    default: module.AssignUsersDialog,
  }))
)

const capacityModes: Array<{
  value: CapacityMode
  label: string
  description: string
}> = [
  {
    value: "unmetered",
    label: "余额结算",
    description: "固定使用这个模型账户，请求费用从用户余额扣除。",
  },
  {
    value: "observed",
    label: "共享额度",
    description: "按账户额度窗口，将可用容量按比例分配给用户。",
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

export function AdminSubscriptionsView({
  accountID,
  historicalOnly = false,
  onChanged,
}: {
  accountID?: string
  historicalOnly?: boolean
  onChanged?: () => void
} = {}) {
  const [parents, setParents] = useState<ParentSubscriptionView[]>([])
  const [children, setChildren] = useState<ChildSubscription[]>([])
  const [tenants, setTenants] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [query, setQuery] = useState("")
  const [selectedParentID, setSelectedParentID] = useState("")
  const [assignOpen, setAssignOpen] = useState(false)
  const [assignParentID, setAssignParentID] = useState("")
  const [parentEditor, setParentEditor] =
    useState<ParentSubscriptionView | null>(null)
  const [deletingAccount, setDeletingAccount] =
    useState<ParentSubscription | null>(null)
  const [childEditor, setChildEditor] = useState<ChildSubscription | null>(null)
  const [deletingChild, setDeletingChild] = useState<ChildSubscription | null>(
    null
  )

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
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
      setLoadError(cause instanceof Error ? cause.message : "无法读取用户授权")
      toast.add({
        title: cause instanceof Error ? cause.message : "无法读取订阅分配",
        type: "error",
      })
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
          (!historicalOnly || view.item.status === "missing") &&
          (view.item.status !== "missing" ||
            (childCountByParent.get(view.item.id) ?? 0) > 0)
      ),
    [parents, childCountByParent, historicalOnly]
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

  const selected = accountID
    ? visibleParents.find(
        (view) => view.item.upstream_credential_id === accountID
      )
    : (visibleParents.find((view) => view.item.id === selectedParentID) ??
      visibleParents[0])
  const selectedChildren = selected
    ? children.filter(
        (child) => child.parent_subscription_id === selected.item.id
      )
    : []

  function openAssignment(view: ParentSubscriptionView) {
    setAssignParentID(view.item.id)
    setAssignOpen(true)
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
      toast.add({
        title: child.enabled ? "授权已停用" : "授权已启用",
        type: "success",
      })
      await load()
      onChanged?.()
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "更新失败",
        type: "error",
      })
    } finally {
      setPending(false)
    }
  }

  async function removeAccount() {
    if (!deletingAccount || pending) return
    const accountID = deletingAccount.upstream_credential_id
    if (!accountID) return
    setPending(true)
    try {
      await deleteRequest(
        `/api/admin/providers/accounts/${encodeURIComponent(accountID)}`
      )
      setDeletingAccount(null)
      toast.add({ title: "账户已删除", type: "success" })
      await load()
      onChanged?.()
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "删除失败",
        type: "error",
      })
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
      toast.add({ title: "用户授权已删除", type: "success" })
      await load()
      onChanged?.()
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "删除失败",
        type: "error",
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {!accountID && !historicalOnly ? <PageHeader title="用户授权" /> : null}

      {loadError ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>用户授权读取失败</AlertTitle>
          <AlertDescription>
            {loadError}
            <Button variant="outline" size="sm" onClick={() => void load()}>
              重试
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {loading && !parents.length ? (
        <AllocationSkeleton />
      ) : loadError && !parents.length ? null : !visibleParents.length ||
        (accountID && !selected) ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PackageOpenIcon />
            </EmptyMedia>
            <EmptyTitle>
              {accountID
                ? "账户授权信息尚未就绪"
                : historicalOnly
                  ? "没有历史授权"
                  : "还没有可分配的模型账户"}
            </EmptyTitle>
            <EmptyDescription>
              {accountID
                ? "刷新账户信息后重试。"
                : historicalOnly
                  ? "已删除账户的授权会保留在这里，可迁移或删除。"
                  : "请先连接模型账户。"}
            </EmptyDescription>
          </EmptyHeader>
          {accountID ? (
            <Button variant="outline" onClick={() => void load()}>
              重试
            </Button>
          ) : null}
        </Empty>
      ) : (
        <div
          className={
            accountID
              ? "min-w-0"
              : "grid min-w-0 items-start gap-4 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-5"
          }
        >
          {!accountID ? (
            <aside aria-label="模型账户" className="min-w-0 lg:sticky lg:top-4">
              <div className="flex min-w-0 flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="font-heading font-medium">
                      {historicalOnly ? "历史账户" : "模型账户"}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      {historicalOnly
                        ? "迁移或清理已删除账户的授权"
                        : `${currentParents.length} 个账户可用于分配`}
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
                <div className="flex max-h-48 min-w-0 flex-col gap-1 overflow-y-auto lg:max-h-[calc(100dvh-13rem)]">
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
                      {!historicalOnly ? (
                        <>
                          <Separator className="my-2" />
                          <p className="px-2 text-xs font-medium text-muted-foreground">
                            历史账户
                          </p>
                        </>
                      ) : null}
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
          ) : null}

          {selected ? (
            <AccountAllocationPanel
              key={selected.item.id}
              view={selected}
              children={selectedChildren}
              tenants={tenants}
              pending={pending}
              embedded={Boolean(accountID)}
              onAssign={() => openAssignment(selected)}
              onConfigure={() => setParentEditor(selected)}
              onEdit={setChildEditor}
              onToggle={(child) => void toggleChild(child)}
              onDelete={setDeletingChild}
              onDeleteAccount={() => setDeletingAccount(selected.item)}
            />
          ) : null}
        </div>
      )}

      {assignOpen ? (
        <Suspense fallback={null}>
          <AssignUsersDialog
            fixedParentID={assignParentID}
            onOpenChange={setAssignOpen}
            onSaved={async () => {
              await load()
              onChanged?.()
            }}
          />
        </Suspense>
      ) : null}
      <AlertDialog
        open={Boolean(deletingAccount)}
        onOpenChange={(open) => {
          if (!open && !pending) setDeletingAccount(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除“{deletingAccount?.name}”？</AlertDialogTitle>
            <AlertDialogDescription>
              该模型账户会从加密数据库和模型路由中立即移除，此操作无法撤销。关联用户授权将无法使用该账户，历史授权保留，可迁移到其他账户或单独删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => void removeAccount()}
            >
              {pending ? <Spinner /> : <Trash2Icon data-icon="inline-start" />}
              确认删除账户
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ParentSettingsDialog
        value={parentEditor}
        pending={pending}
        onPending={setPending}
        onClose={() => setParentEditor(null)}
        onSaved={async () => {
          await load()
          onChanged?.()
        }}
      />
      <ChildSettingsDialog
        value={childEditor}
        parents={parents}
        pending={pending}
        onPending={setPending}
        onClose={() => setChildEditor(null)}
        onSaved={async () => {
          await load()
          onChanged?.()
        }}
      />

      <AlertDialog
        open={Boolean(deletingChild)}
        onOpenChange={(open) => {
          if (!open && !pending) setDeletingChild(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这条用户授权？</AlertDialogTitle>
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
      aria-pressed={active}
      size="sm"
      className="h-auto min-h-12 w-full shrink-0 justify-start px-2 py-2 text-left whitespace-normal"
      onClick={onSelect}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{view.item.name}</p>
        <p className="truncate text-xs">
          {view.item.provider || "未知提供商"}
          {displayPlan(view.item.plan_type)
            ? ` · ${displayPlan(view.item.plan_type)}`
            : ""}
        </p>
      </div>
      <span className="shrink-0 text-xs">{childCount} 条授权</span>
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
  onDeleteAccount,
  onEdit,
  onToggle,
  onDelete,
  embedded = false,
}: {
  view: ParentSubscriptionView
  children: ChildSubscription[]
  tenants: User[]
  pending: boolean
  onAssign: () => void
  onConfigure: () => void
  onDeleteAccount: () => void
  onEdit: (child: ChildSubscription) => void
  onToggle: (child: ChildSubscription) => void
  onDelete: (child: ChildSubscription) => void
  embedded?: boolean
}) {
  const [grantQuery, setGrantQuery] = useState("")
  const tenantByID = new Map(tenants.map((tenant) => [tenant.id, tenant]))
  const filteredChildren = children.filter((child) => {
    const tenant = tenantByID.get(child.tenant_id)
    return [
      child.name,
      tenant?.name,
      tenant?.owner_email,
      child.tenant_id,
    ].some((value) =>
      value?.toLowerCase().includes(grantQuery.trim().toLowerCase())
    )
  })
  const allocationPercent = Math.min(
    100,
    (view.allocated_ppm / nominalAllocationPPM) * 100
  )
  const oversubscribed = view.allocated_ppm > nominalAllocationPPM

  return (
    <div className="@container flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        {!embedded ? (
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="max-w-full font-heading text-base leading-tight font-semibold break-all">
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
        ) : (
          <div className="min-w-0 flex-1">
            <h2 className="font-heading font-medium">{billingLabel(view)}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {accountAllocationHint(view)}
            </p>
          </div>
        )}
        {view.item.status !== "missing" ? (
          <div className="shrink-0">
            <Button size="sm" variant="outline" onClick={onConfigure}>
              <SettingsIcon data-icon="inline-start" />
              {embedded ? "结算与额度规则" : "账户规则"}
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">授权</dt>
            <dd>
              {children.length} 条 ·{" "}
              {children.filter((child) => child.enabled).length} 启用
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">模型</dt>
            <dd>{parentModelOptions(view).length} 个</dd>
          </div>
          {view.item.capacity_mode === "observed" && (
            <div className="flex gap-2">
              <dt className="text-muted-foreground">已分配</dt>
              <dd>{percent(view.allocated_ppm)}</dd>
            </div>
          )}
        </dl>

        {view.item.capacity_mode === "observed" ? (
          <section
            aria-label="账户额度"
            className="grid min-w-0 gap-3 border-y py-3 @2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
          >
            <div className="flex min-w-0 flex-col gap-2">
              <Progress value={allocationPercent}>
                <ProgressLabel>额度分配</ProgressLabel>
                <span className="ml-auto text-xs tabular-nums">
                  {percent(view.allocated_ppm)}
                </span>
              </Progress>
              <p className="text-xs text-muted-foreground">
                {view.allocated_ppm > nominalAllocationPPM
                  ? "已超额分配"
                  : `可分配 ${percent(nominalAllocationPPM - view.allocated_ppm)}`}
              </p>
              {oversubscribed && (
                <OversubscriptionWarning allocatedPPM={view.allocated_ppm} />
              )}
            </div>
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
            <AlertCircleIcon />
            <AlertTitle>当前账户不能继续分配</AlertTitle>
            <AlertDescription>
              <p>{accountBlockReason(view)}</p>
              {!embedded &&
              view.item.status !== "missing" &&
              view.item.upstream_credential_id ? (
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={pending}
                  onClick={onDeleteAccount}
                >
                  <Trash2Icon data-icon="inline-start" />
                  删除账户
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="font-medium">
                用户授权{" "}
                <span className="text-xs text-muted-foreground">
                  {filteredChildren.length} / {children.length}
                </span>
              </h3>
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

          <SearchField
            aria-label="搜索用户授权"
            value={grantQuery}
            onChange={(event) => setGrantQuery(event.target.value)}
            onClear={() => setGrantQuery("")}
            placeholder="搜索用户、邮箱或授权名称"
            className="w-full sm:max-w-sm"
          />
          {filteredChildren.length ? (
            <>
              <div className="flex min-w-0 flex-col divide-y @3xl:hidden">
                {filteredChildren.map((child) => (
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
              <div className="hidden min-w-0 @3xl:block">
                <Table className="table-fixed">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[24%]">用户</TableHead>
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
                    {filteredChildren.map((child) => {
                      const tenant = tenantByID.get(child.tenant_id)
                      return (
                        <TableRow key={child.id}>
                          <TableCell>
                            <p className="truncate font-medium">
                              {tenant?.name || child.tenant_id}
                            </p>
                            <p
                              className="truncate text-xs text-muted-foreground"
                              title={tenant?.owner_email}
                            >
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
                                <p className="truncate" title={child.name}>
                                  {child.name}
                                </p>
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
                              allowMigration={view.item.status === "missing"}
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
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <UsersIcon />
                </EmptyMedia>
                <EmptyTitle>
                  {grantQuery ? "没有匹配的授权" : "尚未分配给任何用户"}
                </EmptyTitle>
                <EmptyDescription>
                  {grantQuery
                    ? "调整搜索词，或清除搜索查看全部授权。"
                    : view.item.capacity_mode === "unmetered"
                      ? "添加用户后，他们会获得这个账户的全部模型权限。"
                      : "新增授权后，用户请求会严格路由到这个模型账户。"}
                </EmptyDescription>
              </EmptyHeader>
              <Button
                disabled={!grantQuery && !isAllocatable(view)}
                onClick={grantQuery ? () => setGrantQuery("") : onAssign}
              >
                <UserPlusIcon data-icon="inline-start" />
                {grantQuery
                  ? "清除搜索"
                  : view.item.capacity_mode === "unmetered"
                    ? "添加用户"
                    : "分配给用户"}
              </Button>
            </Empty>
          )}
        </section>
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
    <div className="min-w-0 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">
            {tenant?.name || child.tenant_id}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {tenant?.owner_email || "未找到用户资料"}
          </p>
        </div>
        <ChildStatusBadge child={child} />
        <ChildGrantMenu
          allowMigration={view.item.status === "missing"}
          child={child}
          capacityMode={view.item.capacity_mode}
          pending={pending}
          onEdit={onEdit}
          onToggle={onToggle}
          onDelete={onDelete}
        />
      </div>

      <div className="mt-2 grid grid-cols-2 gap-3">
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
            {balanceMode ? "用户余额" : child.priority}
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
    <Alert>
      <AlertCircleIcon />
      <AlertTitle>共享额度已超卖</AlertTitle>
      <AlertDescription>
        当前总分配为 {percent(allocatedPPM)}
        。系统不会阻止继续分配，但多个用户同时高负载时可能提前耗尽上游额度。
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
  allowMigration = false,
}: {
  child: ChildSubscription
  capacityMode: CapacityMode
  pending: boolean
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
  allowMigration?: boolean
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
          {capacityMode === "observed" || allowMigration ? (
            <DropdownMenuItem onClick={onEdit}>
              {allowMigration ? "迁移授权" : "编辑授权"}
            </DropdownMenuItem>
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
        <p className="text-sm">用户余额结算</p>
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
    if (mode === "observed" && !windows.length) {
      toast.add({
        title: "这个账户没有可配置的额度窗口，请选择余额结算",
        type: "error",
      })
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
          name: current.item.name,
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
      toast.add({ title: "账户分配规则已保存", type: "success" })
      onClose()
      await onSaved()
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "保存失败",
        type: "error",
      })
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
                      <AlertCircleIcon />
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
              <FieldLabel htmlFor="parent-models">授权模型范围</FieldLabel>
              <ModelSelector
                id="parent-models"
                options={current.item.upstream_model_allowlist ?? []}
                value={models}
                onChange={setModels}
              />
              <FieldDescription>
                不选择表示允许账户当前提供的全部模型。
              </FieldDescription>
            </Field>

            <Field orientation="horizontal">
              <div className="flex-1">
                <FieldLabel htmlFor="parent-enabled">允许用户使用</FieldLabel>
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
      toast.add({ title: "请选择模型账户", type: "error" })
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
      toast.add({ title: "用户授权已保存", type: "success" })
      onClose()
      await onSaved()
    } catch (cause) {
      toast.add({
        title: cause instanceof Error ? cause.message : "保存失败",
        type: "error",
      })
    } finally {
      onPending(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑用户授权</DialogTitle>
          <DialogDescription>
            订阅名称会展示给用户，请勿填写上游邮箱或凭据标识。
          </DialogDescription>
        </DialogHeader>
        <form id="child-settings-form" onSubmit={save}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="child-name">订阅名称</FieldLabel>
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
                items={parents.map((view) => ({
                  value: view.item.id,
                  label: `${view.item.name} · ${billingLabel(view)}`,
                }))}
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
  if (view.item.upstream_unavailable)
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
  if (!view.item.enabled || view.item.upstream_unavailable) return false
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
  if (view.item.upstream_unavailable)
    return "模型账户当前不可用，请先检查账户状态。"
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
    return "请求固定到这个账户，并从用户余额结算。"
  if (!view.windows.length)
    return "额度学习中；请求先从用户余额结算，校准完成后自动切换为共享额度。"
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
    : (parent?.item.upstream_model_allowlist ?? [])
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
    <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-5">
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-8 w-full" />
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
      <div className="flex flex-col">
        <div className="flex flex-col gap-2 px-4 py-5 sm:px-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
        <div className="flex flex-col gap-5 px-4 py-5 sm:px-6">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      </div>
    </div>
  )
}

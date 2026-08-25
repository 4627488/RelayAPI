import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertDialog } from "@astryxdesign/core/AlertDialog"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import {
  DateTimeInput,
  type ISODateTimeString,
} from "@astryxdesign/core/DateTimeInput"
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog"
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu"
import { EmptyState } from "@astryxdesign/core/EmptyState"
import { FormLayout } from "@astryxdesign/core/FormLayout"
import {
  HStack,
  Layout,
  LayoutContent,
  LayoutFooter,
  LayoutHeader,
  LayoutPanel,
  VStack,
} from "@astryxdesign/core/Layout"
import { List, ListItem } from "@astryxdesign/core/List"
import { MultiSelector } from "@astryxdesign/core/MultiSelector"
import { NumberInput } from "@astryxdesign/core/NumberInput"
import { ProgressBar } from "@astryxdesign/core/ProgressBar"
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl"
import { Selector } from "@astryxdesign/core/Selector"
import { Switch } from "@astryxdesign/core/Switch"
import { Table, pixel, proportional } from "@astryxdesign/core/Table"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useToast } from "@astryxdesign/core/Toast"
import { Token } from "@astryxdesign/core/Token"
import {
  MoreHorizontalIcon,
  PackageOpenIcon,
  PlusIcon,
  Settings2Icon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react"

import { LoadErrorView } from "@/components/load-error-view"
import { LoadingView } from "@/components/loading-view"
import { ModelSelector } from "@/components/model-selector"
import {
  CountBadge,
  PageHeader,
  SearchField,
  StatusLabel,
} from "@/components/page-kit"
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
  limit: number | null
  reset: string
  automaticLimit?: number
}

interface ParentRow extends Record<string, unknown> {
  id: string
  name: string
  provider: string
  billing: string
  statusKey: string
  childCount: number
  allocated: string
  historical: boolean
  selected: boolean
  view: ParentSubscriptionView
}

export function AdminSubscriptionsView() {
  const toast = useToast()
  const [parents, setParents] = useState<ParentSubscriptionView[]>([])
  const [children, setChildren] = useState<ChildSubscription[]>([])
  const [tenants, setTenants] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [pending, setPending] = useState(false)
  const [query, setQuery] = useState("")
  const [selectedParentID, setSelectedParentID] = useState("")
  const [assignOpen, setAssignOpen] = useState(false)
  const [assignParentID, setAssignParentID] = useState("")
  const [assignTenantID, setAssignTenantID] = useState("")
  const [assignTenantIDs, setAssignTenantIDs] = useState<string[]>([])
  const [assignName, setAssignName] = useState("")
  const [assignPercent, setAssignPercent] = useState<number | null>(10)
  const [assignPriority, setAssignPriority] = useState<number | null>(100)
  const [assignModels, setAssignModels] = useState<string[]>([])
  const [parentEditor, setParentEditor] =
    useState<ParentSubscriptionView | null>(null)
  const [childEditor, setChildEditor] = useState<ChildSubscription | null>(null)
  const [deletingChild, setDeletingChild] = useState<ChildSubscription | null>(
    null
  )

  const load = useCallback(
    async (showLoading = false) => {
      if (showLoading) setLoading(true)
      setLoadError("")
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
        const message =
          cause instanceof Error ? cause.message : "无法读取订阅分配"
        setLoadError(message)
        toast({ type: "error", body: message })
      } finally {
        if (showLoading) setLoading(false)
      }
    },
    [toast]
  )

  useEffect(() => {
    void load(true)
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
  const filteredParents = useMemo(
    () => [...filteredCurrentParents, ...filteredHistoricalParents],
    [filteredCurrentParents, filteredHistoricalParents]
  )

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
    setAssignPercent(10)
    setAssignPriority(100)
    setAssignModels([])
    setAssignOpen(true)
  }

  function changeAssignParent(parentID: string) {
    const view = currentParents.find((item) => item.item.id === parentID)
    setAssignParentID(parentID)
    setAssignName(defaultChildName(view?.item))
    setAssignPercent(10)
    setAssignModels([])
    setAssignTenantID("")
    setAssignTenantIDs([])
  }

  async function createAssignment() {
    const view = currentParents.find((item) => item.item.id === assignParentID)
    const balanceMode = view?.item.capacity_mode === "unmetered"
    if (
      !view ||
      (balanceMode ? assignTenantIDs.length === 0 : !assignTenantID)
    ) {
      toast({
        type: "error",
        body: balanceMode ? "请至少选择一位用户" : "请选择模型账户和租户",
      })
      return
    }
    if (!isAllocatable(view)) {
      toast({ type: "error", body: accountBlockReason(view) })
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
      toast({ type: "error", body: "请输入有效的账户额度占比" })
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
      toast({
        body: balanceMode
          ? `已授权 ${assignTenantIDs.length} 位用户`
          : "已分配给租户",
      })
      await load()
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "分配失败",
      })
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
      toast({ body: child.enabled ? "授权已停用" : "授权已启用" })
      await load()
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "更新失败",
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
      toast({ body: "租户授权已删除" })
      await load()
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "删除失败",
      })
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
  const parentRows: ParentRow[] = filteredParents.map((view) => ({
    id: view.item.id,
    name: view.item.name,
    provider: [
      view.item.provider || "未知提供商",
      displayPlan(view.item.plan_type),
    ]
      .filter(Boolean)
      .join(" · "),
    billing: billingLabel(view),
    statusKey: accountStatusKey(view),
    childCount: childCountByParent.get(view.item.id) ?? 0,
    allocated:
      view.item.capacity_mode === "observed"
        ? percent(view.allocated_ppm)
        : "—",
    historical: view.item.status === "missing",
    selected: view.item.id === selected?.item.id,
    view,
  }))

  if (loading) return <LoadingView />
  if (loadError && parents.length === 0) {
    return (
      <LoadErrorView message={loadError} onRetry={() => void load(true)} />
    )
  }

  return (
    <>
    <Layout
      height="fill"
      defaultHasDividers
      header={
        <LayoutHeader>
          <VStack gap={3}>
            <PageHeader
              title="订阅分配"
              accessory={<CountBadge value={visibleParents.length} />}
              actions={
                <Button
                  label={
                    selected?.item.capacity_mode === "unmetered"
                      ? "添加用户"
                      : "分配给租户"
                  }
                  variant="primary"
                  icon={<UserPlusIcon />}
                  isDisabled={
                    !selected ||
                    !isAllocatable(selected) ||
                    !tenants.some((tenant) => tenant.enabled)
                  }
                  onClick={() => selected && openAssignment(selected)}
                />
              }
            />
            <SearchField
              label="搜索模型账户"
              value={query}
              onChange={setQuery}
              placeholder="搜索账户"
            />
          </VStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0} label="模型账户">
          {!visibleParents.length ? (
            <EmptyState
              title="还没有可分配的模型账户"
              description="请先连接模型账户。"
              icon={<PackageOpenIcon />}
            />
          ) : parentRows.length ? (
            <Table
              data={parentRows}
              idKey="id"
              density="compact"
              hasHover
              textOverflow="truncate"
              columns={[
                {
                  key: "name",
                  header: "账户",
                  width: proportional(2),
                  renderCell: (row) => (
                    <HStack gap={2} vAlign="center">
                      <Button
                        label={row.name}
                        variant={row.selected ? "secondary" : "ghost"}
                        onClick={() => setSelectedParentID(row.id)}
                      />
                      {row.historical ? (
                        <Token label="历史账户" color="gray" />
                      ) : null}
                    </HStack>
                  ),
                },
                {
                  key: "provider",
                  header: "提供商",
                  width: proportional(1),
                  renderCell: (row) => (
                    <Text color="secondary">{row.provider}</Text>
                  ),
                },
                {
                  key: "billing",
                  header: "结算",
                  width: pixel(110),
                  renderCell: (row) => (
                    <Token
                      label={row.billing}
                      color={row.historical ? "gray" : "default"}
                    />
                  ),
                },
                {
                  key: "statusKey",
                  header: "状态",
                  width: pixel(130),
                  renderCell: (row) => <AccountStatusLabel view={row.view} />,
                },
                {
                  key: "childCount",
                  header: "授权",
                  width: pixel(80),
                  renderCell: (row) => <CountBadge value={row.childCount} />,
                },
                {
                  key: "allocated",
                  header: "已分配",
                  width: pixel(90),
                  renderCell: (row) => (
                    <Text color="secondary">{row.allocated}</Text>
                  ),
                },
              ]}
            />
          ) : (
            <EmptyState
              title="没有匹配的账户"
              description="换一个关键词，或清空搜索后再看全部账户。"
              icon={<PackageOpenIcon />}
            />
          )}
        </LayoutContent>
      }
      end={
        <LayoutPanel
          width={380}
          hasDivider
          isScrollable
          padding={4}
          label="账户详情"
        >
          {selected ? (
            <AccountInspector
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
          ) : (
            <EmptyState
              title="选择一个模型账户"
              description="从表格中选择账户，查看额度窗口和租户授权。"
              icon={<PackageOpenIcon />}
            />
          )}
        </LayoutPanel>
      }
    />
    <Dialog
      isOpen={assignOpen}
      onOpenChange={(open) => {
        if (!pending) setAssignOpen(open)
      }}
      width={560}
      purpose="form"
    >
      <Layout
        height="auto"
        header={
          <DialogHeader
            title={
              assignParent?.item.capacity_mode === "unmetered"
                ? "授权用户"
                : "分配共享额度"
            }
            subtitle={
              assignParent?.item.capacity_mode === "unmetered"
                ? "所选用户将获得该账户的全部模型权限，调用费用从各自余额扣除。"
                : "为一个租户创建带独立份额的额度授权。"
            }
            onOpenChange={(open) => {
              if (!pending) setAssignOpen(open)
            }}
          />
        }
        content={
          <LayoutContent>
            <FormLayout>
              <Selector
                label="模型账户"
                options={currentParents.map((view) => ({
                  value: view.item.id,
                  label: `${view.item.name} · ${billingLabel(view)}`,
                  disabled: !isAllocatable(view),
                }))}
                value={assignParentID}
                onChange={changeAssignParent}
                placeholder="选择模型账户"
                isRequired
                width="100%"
                description={
                  assignParent
                    ? isAllocatable(assignParent)
                      ? accountAllocationHint(assignParent)
                      : accountBlockReason(assignParent)
                    : undefined
                }
              />
              {assignParent?.item.capacity_mode === "unmetered" ? (
                balanceGrantTenants.length ? (
                  <MultiSelector
                    label="用户"
                    options={balanceGrantTenants.map((tenant) => ({
                      value: tenant.id,
                      label: tenant.name,
                      description: tenant.owner_email,
                    }))}
                    value={assignTenantIDs}
                    onChange={setAssignTenantIDs}
                    hasSearch={balanceGrantTenants.length > 8}
                    searchPlaceholder="筛选用户"
                    hasSelectAll
                    selectAllLabel="全选可用用户"
                    triggerDisplay="count"
                    formatValue={(items) =>
                      items.length ? `已选择 ${items.length} 位` : "选择用户"
                    }
                    description={`已选择 ${assignTenantIDs.length} 位；以后仍可继续添加其他用户。`}
                    isRequired
                    width="100%"
                  />
                ) : (
                  <Text color="secondary">
                    所有可用用户都已获得该账户权限。
                  </Text>
                )
              ) : (
                <Selector
                  label="租户"
                  options={tenants
                    .filter((tenant) => tenant.enabled)
                    .map((tenant) => ({
                      value: tenant.id,
                      label: `${tenant.name} · ${tenant.owner_email}`,
                    }))}
                  value={assignTenantID}
                  onChange={setAssignTenantID}
                  placeholder="选择租户"
                  isRequired
                  width="100%"
                />
              )}
              {assignParent?.item.capacity_mode !== "unmetered" ? (
                <TextInput
                  label="授权名称"
                  value={assignName}
                  onChange={setAssignName}
                  placeholder="例如：研发团队"
                  isRequired
                  width="100%"
                />
              ) : null}
              {assignParent?.item.capacity_mode === "observed" ? (
                <VStack gap={3}>
                  <NumberInput
                    label="账户额度占比"
                    value={assignPercent ?? undefined}
                    onChange={(value) => setAssignPercent(value)}
                    min={0.0001}
                    step={0.0001}
                    units="%"
                    isRequired
                    isWheelEnabled={false}
                    width="100%"
                    description={`分配后总计 ${percent(projectedAllocationPPM)}；允许超过 100%。`}
                  />
                  {projectedAllocationPPM > nominalAllocationPPM ? (
                    <OversubscriptionWarning
                      allocatedPPM={projectedAllocationPPM}
                    />
                  ) : null}
                </VStack>
              ) : null}
              {assignParent?.item.capacity_mode !== "unmetered" ? (
                <NumberInput
                  label="路由优先级"
                  value={assignPriority ?? undefined}
                  onChange={(value) => setAssignPriority(value)}
                  isIntegerOnly
                  isRequired
                  isWheelEnabled={false}
                  width="100%"
                  description="同一租户有多个可用账户时，数值越大越优先。"
                />
              ) : null}
              {assignParent?.item.capacity_mode !== "unmetered" ? (
                <ModelSelector
                  options={parentModelOptions(assignParent)}
                  value={assignModels}
                  onChange={setAssignModels}
                  allLabel="继承账户全部模型"
                />
              ) : null}
            </FormLayout>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack hAlign="end" gap={2}>
              <Button
                label="取消"
                isDisabled={pending}
                onClick={() => setAssignOpen(false)}
              />
              <Button
                label={
                  assignParent?.item.capacity_mode === "unmetered"
                    ? "确认授权"
                    : "确认分配"
                }
                variant="primary"
                icon={<PlusIcon />}
                isLoading={pending}
                isDisabled={
                  assignParent?.item.capacity_mode === "unmetered" &&
                  assignTenantIDs.length === 0
                }
                onClick={() => void createAssignment()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
    <ParentSettingsDialog
      value={parentEditor}
      pending={pending}
      onPending={setPending}
      onClose={() => setParentEditor(null)}
      onSaved={() => load()}
    />
    <ChildSettingsDialog
      value={childEditor}
      parents={visibleParents}
      pending={pending}
      onPending={setPending}
      onClose={() => setChildEditor(null)}
      onSaved={() => load()}
    />
    <AlertDialog
      isOpen={Boolean(deletingChild)}
      onOpenChange={(open) => {
        if (!open && !pending) setDeletingChild(null)
      }}
      title="删除这条租户授权？"
      description={
        deletingChild
          ? `“${deletingChild.name}”将立即停止路由到这个模型账户。`
          : "该授权将被删除。"
      }
      cancelLabel="取消"
      actionLabel="删除授权"
      isActionLoading={pending}
      onAction={() => void removeChild()}
    />
    </>
  )
}

function AccountInspector({
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
  const modelCount = parentModelOptions(view).length

  return (
    <VStack gap={6}>
      <VStack gap={2}>
        <HStack gap={2} wrap="wrap" vAlign="center">
          <Heading level={2}>{view.item.name}</Heading>
          <AccountStatusLabel view={view} />
        </HStack>
        <Text color="secondary">
          {[
            view.item.provider || "未知提供商",
            displayPlan(view.item.plan_type),
            billingLabel(view),
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
        {view.item.status !== "missing" ? (
          <Button
            label="账户规则"
            variant="secondary"
            size="sm"
            icon={<Settings2Icon />}
            onClick={onConfigure}
          />
        ) : null}
      </VStack>

      <VStack gap={3}>
        <Fact
          label={
            view.item.capacity_mode === "unmetered" ? "授权用户" : "租户授权"
          }
          value={`${children.length} ${view.item.capacity_mode === "unmetered" ? "人" : "条"}`}
        />
        <Fact label="可用模型" value={`${modelCount} 个`} />
        <Fact label="结算方式" value={billingLabel(view)} />
      </VStack>

      {view.item.capacity_mode === "observed" ? (
        <VStack gap={3}>
          <HStack hAlign="between" gap={3} vAlign="center">
            <VStack gap={1}>
              <Text weight="semibold">账户额度</Text>
              <Text color="secondary" type="supporting">
                上游额度和租户分配使用同一份账户数据。
              </Text>
            </VStack>
            <Token label={`已分配 ${percent(view.allocated_ppm)}`} color="gray" />
          </HStack>
          <ProgressBar
            label="已分配比例"
            value={allocationPercent}
            hasValueLabel
            formatValueLabel={() => `${Math.round(allocationPercent)}%`}
          />
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
        </VStack>
      ) : null}

      {!isAllocatable(view) ? (
        <Banner
          status="error"
          title="当前账户不能继续分配"
          description={accountBlockReason(view)}
          collapsible={false}
        />
      ) : null}

      <VStack gap={3}>
        <HStack hAlign="between" gap={3} vAlign="start" wrap="wrap">
          <VStack gap={1}>
            <Text weight="semibold">租户授权</Text>
            <Text color="secondary" type="supporting">
              {view.item.capacity_mode === "unmetered"
                ? "授权用户继承账户全部模型，调用费用从各自余额扣除。"
                : "每条授权决定租户可以使用的模型、份额与路由优先级。"}
            </Text>
          </VStack>
          <Button
            label={
              view.item.capacity_mode === "unmetered" ? "添加用户" : "新增授权"
            }
            size="sm"
            icon={<PlusIcon />}
            isDisabled={!isAllocatable(view)}
            onClick={onAssign}
          />
        </HStack>

        {children.length ? (
          <List density="compact" hasDividers>
            {children.map((child) => {
              const tenant = tenantByID.get(child.tenant_id)
              return (
                <ListItem
                  key={child.id}
                  label={tenant?.name || child.tenant_id}
                  description={
                    <ChildGrantDetails child={child} view={view} tenant={tenant} />
                  }
                  endContent={
                    <HStack gap={2} vAlign="center">
                      <ChildStatusLabel child={child} />
                      <ChildGrantMenu
                        child={child}
                        capacityMode={view.item.capacity_mode}
                        pending={pending}
                        onEdit={() => onEdit(child)}
                        onToggle={() => onToggle(child)}
                        onDelete={() => onDelete(child)}
                      />
                    </HStack>
                  }
                />
              )
            })}
          </List>
        ) : (
          <EmptyState
            title="尚未分配给任何租户"
            description={
              view.item.capacity_mode === "unmetered"
                ? "添加用户后，他们会获得这个账户的全部模型权限。"
                : "新增授权后，租户请求会严格路由到这个模型账户。"
            }
            icon={<UsersIcon />}
            actions={
              <Button
                label={
                  view.item.capacity_mode === "unmetered"
                    ? "添加用户"
                    : "分配给租户"
                }
                variant="primary"
                icon={<UserPlusIcon />}
                isDisabled={!isAllocatable(view)}
                onClick={onAssign}
              />
            }
          />
        )}
      </VStack>

      <HStack hAlign="between" gap={3} vAlign="center">
        <Text color="secondary" type="supporting">
          账户与授权数据保存后立即生效。
        </Text>
        <Token label="无需同步" color="gray" />
      </HStack>
    </VStack>
  )
}

function ChildGrantDetails({
  child,
  view,
  tenant,
}: {
  child: ChildSubscription
  view: ParentSubscriptionView
  tenant?: User
}) {
  const balanceMode = view.item.capacity_mode === "unmetered"
  const modelCount = parentModelOptions(view).length
  const scope = balanceMode
    ? modelCount
      ? `账户全部 ${modelCount} 个模型`
      : "账户全部模型"
    : child.model_allowlist?.length
      ? `${child.name} · 限定 ${child.model_allowlist.length} 个模型`
      : `${child.name} · 继承账户全部模型`
  return (
    <VStack gap={2}>
      <Text color="secondary" type="supporting">
        {tenant?.owner_email || "未找到租户资料"}
      </Text>
      <Text color="secondary" type="supporting">
        {scope}
        {balanceMode
          ? " · 租户余额结算"
          : ` · 优先级 ${child.priority}`}
      </Text>
      {child.available === false && child.availability_message ? (
        <Text color="secondary" type="supporting">
          {child.availability_message}
        </Text>
      ) : null}
      <ChildQuotaProgress
        child={child}
        capacityMode={view.item.capacity_mode}
      />
    </VStack>
  )
}

function OversubscriptionWarning({ allocatedPPM }: { allocatedPPM: number }) {
  return (
    <Banner
      status="warning"
      title="共享额度已超卖"
      description={`当前总分配为 ${percent(allocatedPPM)}。系统不会阻止继续分配，但多个租户同时高负载时可能提前耗尽上游额度。`}
      collapsible={false}
    />
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
    <DropdownMenu
      hasChevron={false}
      alignment="end"
      button={{
        label: `管理 ${child.name}`,
        variant: "ghost",
        isIconOnly: true,
        icon: <MoreHorizontalIcon />,
      }}
      items={[
        ...(capacityMode === "observed"
          ? [{ label: "编辑授权", onClick: onEdit }]
          : []),
        {
          label: child.enabled ? "停用授权" : "启用授权",
          isDisabled: pending,
          onClick: onToggle,
        },
        { type: "divider" as const },
        {
          label: "删除授权",
          variant: "destructive" as const,
          onClick: onDelete,
        },
      ]}
    />
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
      <Text color="secondary" type="supporting">
        租户余额结算 · 不占共享额度
      </Text>
    )
  }
  const windows = child.entitlement_windows ?? []
  if (!windows.length) {
    return (
      <Text color="secondary" type="supporting">
        {percent(child.allocation_ppm)} 份额 · 等待额度同步
      </Text>
    )
  }
  return (
    <VStack gap={2}>
      {windows.map((window) => (
        <ChildQuotaWindowProgress
          key={`${child.id}:${window.kind}`}
          window={window}
        />
      ))}
    </VStack>
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
  const roundedRemaining = Math.round(remainingPercent)
  const variant =
    roundedRemaining <= 10
      ? "error"
      : roundedRemaining <= 25
        ? "warning"
        : "accent"
  return (
    <ProgressBar
      label={`${quotaWindowLabel(window.kind)} · ${money(window.remaining_nano_usd)}`}
      value={remainingPercent}
      variant={variant}
      hasValueLabel
      formatValueLabel={() => `${roundedRemaining}%`}
    />
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <HStack hAlign="between" gap={3}>
      <Text color="secondary">{label}</Text>
      <Text weight="semibold">{value}</Text>
    </HStack>
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
  const toast = useToast()
  const [name, setName] = useState("")
  const [mode, setMode] = useState<CapacityMode>("unmetered")
  const [enabled, setEnabled] = useState(true)
  const [models, setModels] = useState<string[]>([])
  const [windows, setWindows] = useState<EditableWindow[]>([])

  useEffect(() => {
    if (!value) return
    setName(value.item.name)
    setMode(value.item.capacity_mode)
    setEnabled(value.item.enabled)
    setModels(value.item.model_allowlist ?? [])
    setWindows(observedEditableWindows(value))
  }, [value])

  if (!value) return null
  const current = value

  function changeMode(next: string) {
    if (next === "unmetered" || next === "observed") setMode(next)
  }

  function updateWindow(key: string, limit: number | null) {
    setWindows((items) =>
      items.map((item) => (item.key === key ? { ...item, limit } : item))
    )
  }

  async function save() {
    if (mode === "observed" && !windows.length) {
      toast({
        type: "error",
        body: "这个账户没有可配置的额度窗口，请选择余额结算",
      })
      return
    }
    onPending(true)
    try {
      const windowItems = windows
        .filter((window) => window.limit != null)
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
          name,
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
      toast({ body: "账户分配规则已保存" })
      onClose()
      await onSaved()
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "保存失败",
      })
    } finally {
      onPending(false)
    }
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
      width={640}
      purpose="form"
    >
      <Layout
        height="auto"
        header={
          <DialogHeader
            title="账户分配规则"
            subtitle={[
              current.item.provider || "未知提供商",
              displayPlan(current.item.plan_type),
            ]
              .filter(Boolean)
              .join(" · ")}
            onOpenChange={(open) => {
              if (!open && !pending) onClose()
            }}
          />
        }
        content={
          <LayoutContent>
            <FormLayout>
              <TextInput
                label="显示名称"
                value={name}
                onChange={setName}
                isRequired
                width="100%"
              />
              <VStack gap={2}>
                <SegmentedControl
                  label="结算方式"
                  value={mode}
                  onChange={changeMode}
                  layout="fill"
                >
                  {capacityModes.map((item) => (
                    <SegmentedControlItem
                      key={item.value}
                      value={item.value}
                      label={item.label}
                    />
                  ))}
                </SegmentedControl>
                <Text color="secondary" type="supporting">
                  {capacityModes.find((item) => item.value === mode)?.description}
                </Text>
              </VStack>
              {mode === "observed" ? (
                <VStack gap={3}>
                  <Text weight="semibold">账户额度</Text>
                  <QuotaSnapshot
                    snapshot={current.item.quota_snapshot}
                    status={current.item.quota_probe_status}
                    error={current.item.quota_probe_error}
                    observedAt={current.item.quota_observed_at}
                    configuredWindows={current.windows}
                  />
                  {!windows.length ? (
                    <Banner
                      status="error"
                      title="没有可分配的额度窗口"
                      description="这个账户当前只能使用余额结算。"
                      collapsible={false}
                    />
                  ) : (
                    <FormLayout>
                      {windows.map((window) => (
                        <NumberInput
                          key={window.key}
                          label={quotaWindowLabel(window.kind)}
                          description={`${dateTime(new Date(window.reset).toISOString())} 重置 · 留空则继续自动推测`}
                          value={window.limit ?? undefined}
                          onChange={(value) =>
                            updateWindow(window.key, value ?? null)
                          }
                          min={0.000001}
                          step={0.000001}
                          units="USD"
                          placeholder={
                            window.automaticLimit
                              ? quotaUSDInputValue(window.automaticLimit)
                              : "自动推测"
                          }
                          hasClear
                          isWheelEnabled={false}
                          width="100%"
                        />
                      ))}
                    </FormLayout>
                  )}
                </VStack>
              ) : null}
              <ModelSelector
                options={current.item.upstream_model_allowlist ?? []}
                value={models}
                onChange={setModels}
              />
              <Switch
                label="允许租户使用"
                description="关闭后，已有授权会保留，但请求不会路由到这个账户。"
                value={enabled}
                onChange={setEnabled}
                labelSpacing="spread"
                width="100%"
              />
            </FormLayout>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack hAlign="end" gap={2}>
              <Button label="取消" isDisabled={pending} onClick={onClose} />
              <Button
                label="保存规则"
                variant="primary"
                isLoading={pending}
                onClick={() => void save()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
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
  const toast = useToast()
  const [parentID, setParentID] = useState("")
  const [name, setName] = useState("")
  const [models, setModels] = useState<string[]>([])
  const [enabled, setEnabled] = useState(true)
  const [allocationPercent, setAllocationPercent] = useState<number | null>(
    null
  )
  const [priority, setPriority] = useState<number | null>(100)
  const [startsAt, setStartsAt] = useState("")
  const [expiresAt, setExpiresAt] = useState("")

  useEffect(() => {
    if (!value) return
    setParentID(value.parent_subscription_id)
    setName(value.name)
    setModels(value.model_allowlist ?? [])
    setEnabled(value.enabled)
    setAllocationPercent(value.allocation_ppm / 10_000)
    setPriority(value.priority)
    setStartsAt(localDateTime(value.starts_at))
    setExpiresAt(localDateTime(value.expires_at ?? undefined))
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

  async function save() {
    if (!selectedParent) {
      toast({ type: "error", body: "请选择模型账户" })
      return
    }
    onPending(true)
    try {
      await api(`/api/admin/subscriptions/children/${current.id}`, {
        method: "PUT",
        body: JSON.stringify({
          tenant_id: current.tenant_id,
          parent_subscription_id: selectedParent.item.id,
          name,
          allocation_ppm:
            selectedParent.item.capacity_mode === "unmetered"
              ? 1_000_000
              : editedAllocationPPM,
          priority: Number(priority || 100),
          enabled,
          model_allowlist: models,
          starts_at: new Date(startsAt).toISOString(),
          expires_at: expiresAt ? new Date(expiresAt).toISOString() : "",
        }),
      })
      toast({ body: "租户授权已保存" })
      onClose()
      await onSaved()
    } catch (cause) {
      toast({
        type: "error",
        body: cause instanceof Error ? cause.message : "保存失败",
      })
    } finally {
      onPending(false)
    }
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
      width={560}
      purpose="form"
    >
      <Layout
        height="auto"
        header={
          <DialogHeader
            title="编辑租户授权"
            subtitle="修改模型范围、账户份额和路由优先级。"
            onOpenChange={(open) => {
              if (!open && !pending) onClose()
            }}
          />
        }
        content={
          <LayoutContent>
            <FormLayout>
              <TextInput
                label="授权名称"
                value={name}
                onChange={setName}
                isRequired
                width="100%"
              />
              <Selector
                label="模型账户"
                options={parents.map((view) => ({
                  value: view.item.id,
                  label: `${view.item.name} · ${billingLabel(view)}`,
                  disabled: !isAllocatable(view),
                }))}
                value={parentID}
                onChange={(next) => {
                  setParentID(next)
                  setModels([])
                }}
                isRequired
                width="100%"
              />
              {selectedParent?.item.capacity_mode === "observed" ? (
                <VStack gap={3}>
                  <NumberInput
                    label="账户额度占比"
                    value={allocationPercent ?? undefined}
                    onChange={(value) => setAllocationPercent(value)}
                    min={0.0001}
                    step={0.0001}
                    units="%"
                    isRequired
                    isWheelEnabled={false}
                    width="100%"
                    description={`保存后账户总计 ${percent(projectedAllocationPPM)}；允许超过 100%。`}
                  />
                  {projectedAllocationPPM > nominalAllocationPPM ? (
                    <OversubscriptionWarning
                      allocatedPPM={projectedAllocationPPM}
                    />
                  ) : null}
                </VStack>
              ) : null}
              <NumberInput
                label="路由优先级"
                value={priority ?? undefined}
                onChange={(value) => setPriority(value)}
                isIntegerOnly
                isRequired
                isWheelEnabled={false}
                width="100%"
              />
              <DateTimeInput
                label="生效时间"
                value={(startsAt || undefined) as ISODateTimeString | undefined}
                onChange={(value) => setStartsAt(value ?? "")}
                hasSeconds
                hourFormat="24h"
                isRequired
                width="100%"
              />
              <DateTimeInput
                label="到期时间"
                value={(expiresAt || undefined) as ISODateTimeString | undefined}
                onChange={(value) => setExpiresAt(value ?? "")}
                hasSeconds
                hourFormat="24h"
                hasClear
                isOptional
                width="100%"
              />
              <ModelSelector
                options={parentModelOptions(selectedParent)}
                value={models}
                onChange={setModels}
                allLabel="继承账户全部模型"
              />
              <Switch
                label="启用授权"
                description="停用不会删除配置，可以随时重新启用。"
                value={enabled}
                onChange={setEnabled}
                labelSpacing="spread"
                width="100%"
              />
            </FormLayout>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack hAlign="end" gap={2}>
              <Button label="取消" isDisabled={pending} onClick={onClose} />
              <Button
                label="保存授权"
                variant="primary"
                isLoading={pending}
                onClick={() => void save()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}

function accountStatusKey(view: ParentSubscriptionView) {
  if (view.item.status === "missing") return "missing"
  if (!view.item.enabled) return "disabled"
  if (view.item.upstream_unavailable) return "unavailable"
  if (view.item.capacity_mode === "observed" && !view.windows.length)
    return "learning"
  return "ready"
}

function AccountStatusLabel({ view }: { view: ParentSubscriptionView }) {
  const key = accountStatusKey(view)
  if (key === "missing")
    return <StatusLabel tone="neutral" label="账户已删除" />
  if (key === "disabled") return <StatusLabel tone="neutral" label="已停用" />
  if (key === "unavailable")
    return <StatusLabel tone="error" label="账户不可用" />
  if (key === "learning")
    return <StatusLabel tone="warning" label="额度学习中" />
  return <StatusLabel tone="success" label="可分配" />
}

function ChildStatusLabel({ child }: { child: ChildSubscription }) {
  if (!child.enabled) return <StatusLabel tone="neutral" label="已停用" />
  if (child.available === false)
    return <StatusLabel tone="error" label="不可用" />
  return <StatusLabel tone="success" label="生效中" />
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
          ? configured.limit_nano_usd / 1_000_000_000
          : null,
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

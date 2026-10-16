import { useCallback, useState, type FormEvent } from "react"
import { AlertCircleIcon, ChevronDownIcon, UsersIcon } from "lucide-react"
import {
  api,
  postJSON,
  type ChildSubscription,
  type ParentSubscriptionView,
  type User,
} from "@/lib/api"
import { useAsyncResource } from "@/hooks/use-async-resource"
import { money } from "@/lib/format"
import { defaultSubscriptionName } from "@/lib/subscription-names"
import { ModelSelector } from "@/components/model-selector"
import { SearchField } from "@/components/workspace-ui"
import { LoadErrorView } from "@/components/load-error-view"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { toast } from "@/components/ui/toast"

type Props = {
  initialUserIDs?: string[]
  fixedParentID?: string
  onOpenChange: (open: boolean) => void
  onSaved?: () => void | Promise<void>
}

function assignable(view: ParentSubscriptionView) {
  return (
    view.item.status !== "missing" &&
    view.item.enabled &&
    !view.item.upstream_unavailable &&
    (view.item.capacity_mode === "unmetered" ||
      view.windows.length > 0 ||
      (view.item.quota_snapshot?.windows ?? []).some(
        (window) => window.enforceable && Boolean(window.resets_at)
      ))
  )
}
const percent = (ppm: number) =>
  `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 }).format(ppm / 10000)}%`

export function AssignUsersDialog({
  initialUserIDs = [],
  fixedParentID,
  onOpenChange,
  onSaved,
}: Props) {
  const load = useCallback(async () => {
    const [parents, grants, users] = await Promise.all([
      api<{ items: ParentSubscriptionView[] }>(
        "/api/admin/subscriptions/parents"
      ),
      api<{ items: ChildSubscription[] }>("/api/admin/subscriptions/children"),
      api<{ items: User[] }>("/api/admin/tenants"),
    ])
    return {
      parents: parents.items ?? [],
      grants: grants.items ?? [],
      users: users.items ?? [],
    }
  }, [])
  const { data, loading, error, reload } = useAsyncResource(load, {
    initialData: {
      parents: [] as ParentSubscriptionView[],
      grants: [] as ChildSubscription[],
      users: [] as User[],
    },
    errorMessage: "无法读取分配信息",
  })
  const [selectedIDs, setSelectedIDs] = useState(initialUserIDs)
  const [parentID, setParentID] = useState(fixedParentID ?? "")
  const [mode, setMode] = useState("unmetered")
  const [query, setQuery] = useState("")
  const [customName, setCustomName] = useState<string | null>(null)
  const [shareMode, setShareMode] = useState("each")
  const [share, setShare] = useState("10")
  const [validity, setValidity] = useState("none")
  const [expiresAt, setExpiresAt] = useState("")
  const [models, setModels] = useState<string[]>([])
  const [priority, setPriority] = useState("100")
  const [pending, setPending] = useState(false)
  const [mutationError, setMutationError] = useState("")
  const [now] = useState(Date.now)
  const parent = data.parents.find((view) => view.item.id === parentID)
  const effectiveMode =
    fixedParentID && parent ? parent.item.capacity_mode : mode
  const balance = effectiveMode === "unmetered"
  const existing = data.grants.filter(
    (grant) =>
      grant.parent_subscription_id === parentID &&
      grant.enabled &&
      (!grant.expires_at || Date.parse(grant.expires_at) > now)
  )
  const alreadyAssigned = new Set(existing.map((grant) => grant.tenant_id))
  const selected = data.users.filter(
    (user) => selectedIDs.includes(user.id) && user.enabled
  )
  const targets = selected.filter((user) => !alreadyAssigned.has(user.id))
  const skipped = selected.length - targets.length
  const filteredUsers = data.users.filter((user) =>
    `${user.name} ${user.owner_email}`
      .toLowerCase()
      .includes(query.trim().toLowerCase())
  )
  const selectableUsers = filteredUsers.filter((user) => user.enabled)
  const remainingPPM = Math.max(0, 1000000 - (parent?.allocated_ppm ?? 0))
  const allocationPPM =
    shareMode === "equal"
      ? Math.floor(remainingPPM / Math.max(1, targets.length))
      : Math.round(Number(share) * 10000)
  const projectedPPM =
    (parent?.allocated_ppm ?? 0) + allocationPPM * targets.length
  const validShare =
    Number.isSafeInteger(allocationPPM) &&
    allocationPPM > 0 &&
    Number.isSafeInteger(projectedPPM)
  const sourceModels = parent?.item.model_allowlist?.length
    ? parent.item.model_allowlist
    : (parent?.item.upstream_model_allowlist ?? [])
  const name =
    customName ??
    (parent ? defaultSubscriptionName(parent.item, allocationPPM) : "共享订阅")
  const canSubmit =
    !loading &&
    !error &&
    !pending &&
    parent &&
    assignable(parent) &&
    targets.length > 0 &&
    (balance || (validShare && name.trim().length > 0))
  function changeParent(id: string) {
    setParentID(id)
    setModels([])
    setCustomName(null)
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSubmit || !parent) return
    const starts = new Date()
    const expires =
      validity === "custom"
        ? new Date(expiresAt)
        : validity === "none"
          ? null
          : new Date(starts.getTime() + Number(validity) * 86400000)
    if (
      !balance &&
      expires &&
      (!Number.isFinite(expires.getTime()) || expires <= starts)
    ) {
      setMutationError("到期时间必须晚于现在。")
      return
    }
    setPending(true)
    setMutationError("")
    try {
      await postJSON(
        "/api/admin/subscriptions/children",
        balance
          ? {
              parent_subscription_id: parent.item.id,
              tenant_ids: targets.map((user) => user.id),
            }
          : {
              parent_subscription_id: parent.item.id,
              tenant_ids: targets.map((user) => user.id),
              name: name.trim(),
              allocation_ppm: allocationPPM,
              priority: Number(priority || 100),
              enabled: true,
              model_allowlist: models,
              starts_at: starts.toISOString(),
              expires_at: expires?.toISOString() ?? "",
            }
      )
    } catch (cause) {
      setMutationError(
        cause instanceof Error ? cause.message : "分配失败，请重试。"
      )
      await reload()
      setPending(false)
      return
    }
    toast.add({
      title: `已为 ${targets.length} 位用户${balance ? "开通余额模型" : "分配共享订阅"}`,
      type: "success",
    })
    onOpenChange(false)
    try {
      await onSaved?.()
    } catch {
      toast.add({ title: "分配已完成，请刷新查看最新权限。", type: "info" })
    }
    setPending(false)
  }
  return (
    <Dialog open onOpenChange={(open) => !pending && onOpenChange(open)}>
      <DialogContent
        className="flex max-h-[90dvh] flex-col sm:max-w-5xl"
        showCloseButton={!pending}
      >
        <DialogHeader>
          <DialogTitle>分配给用户</DialogTitle>
          <DialogDescription>
            选好用户和模型来源，确认结算方式后一次完成分配。已有授权会自动跳过。
          </DialogDescription>
        </DialogHeader>
        {loading && !data.users.length ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : error && !data.parents.length ? (
          <LoadErrorView message={error} onRetry={() => void reload(true)} />
        ) : (
          <>
            <form
              id="assign-users-form"
              onSubmit={submit}
              className="min-h-0 flex-1 overflow-y-auto"
            >
              <fieldset
                disabled={pending}
                className="grid min-w-0 gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]"
              >
                <FieldSet className="min-w-0 gap-3">
                  <FieldLegend>
                    分配给谁{" "}
                    <span className="text-xs text-muted-foreground">
                      已选 {selected.length} 人
                    </span>
                  </FieldLegend>
                  <SearchField
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onClear={() => setQuery("")}
                    placeholder="搜索用户或邮箱"
                  />
                  <div className="flex items-center justify-between gap-2">
                    <Field orientation="horizontal">
                      <Checkbox
                        id="assign-select-all"
                        checked={
                          selectableUsers.length > 0 &&
                          selectableUsers.every((user) =>
                            selectedIDs.includes(user.id)
                          )
                        }
                        indeterminate={
                          selectableUsers.some((user) =>
                            selectedIDs.includes(user.id)
                          ) &&
                          !selectableUsers.every((user) =>
                            selectedIDs.includes(user.id)
                          )
                        }
                        onCheckedChange={(checked) =>
                          setSelectedIDs((current) =>
                            checked
                              ? [
                                  ...new Set([
                                    ...current,
                                    ...selectableUsers.map((user) => user.id),
                                  ]),
                                ]
                              : current.filter(
                                  (id) =>
                                    !selectableUsers.some(
                                      (user) => user.id === id
                                    )
                                )
                          )
                        }
                      />
                      <FieldLabel htmlFor="assign-select-all">
                        选择搜索结果
                      </FieldLabel>
                    </Field>
                    <Button
                      size="sm"
                      variant="ghost"
                      type="button"
                      onClick={() => setSelectedIDs([])}
                    >
                      清空
                    </Button>
                  </div>
                  <div className="max-h-64 overflow-y-auto md:max-h-[25rem]">
                    {filteredUsers.map((user) => {
                      const grants = data.grants.filter(
                        (grant) =>
                          grant.tenant_id === user.id &&
                          grant.enabled &&
                          (!grant.expires_at ||
                            Date.parse(grant.expires_at) > now)
                      )
                      return (
                        <Field
                          key={user.id}
                          orientation="horizontal"
                          className="gap-3 border-b py-3"
                          data-disabled={!user.enabled}
                        >
                          <Checkbox
                            id={`assign-user-${user.id}`}
                            aria-label={`选择 ${user.name}`}
                            checked={selectedIDs.includes(user.id)}
                            disabled={!user.enabled}
                            onCheckedChange={(checked) =>
                              setSelectedIDs((current) =>
                                checked
                                  ? [...new Set([...current, user.id])]
                                  : current.filter((id) => id !== user.id)
                              )
                            }
                          />
                          <div className="min-w-0 flex-1">
                            <FieldLabel htmlFor={`assign-user-${user.id}`}>
                              {user.name}
                            </FieldLabel>
                            <p className="truncate text-xs text-muted-foreground">
                              {user.owner_email}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {grants.length
                                ? `${grants.length} 项已有授权`
                                : "尚无独立授权"}
                            </p>
                          </div>
                          {!user.enabled ? (
                            <Badge variant="outline">已停用</Badge>
                          ) : parentID && alreadyAssigned.has(user.id) ? (
                            <Badge variant="secondary">已授权 · 跳过</Badge>
                          ) : selectedIDs.includes(user.id) ? (
                            <Badge variant="outline">待分配</Badge>
                          ) : null}
                        </Field>
                      )
                    })}
                    {!filteredUsers.length ? (
                      <p className="py-8 text-center text-sm text-muted-foreground">
                        没有匹配的用户
                      </p>
                    ) : null}
                  </div>
                </FieldSet>
                <div className="flex min-w-0 flex-col gap-5">
                  <section
                    aria-label="分配预览"
                    className="flex flex-col gap-2"
                  >
                    <h3 className="font-medium">分配预览</h3>
                    <p className="text-sm">
                      新增 {parent ? targets.length : 0} 位用户
                      {skipped ? ` · ${skipped} 位已有授权，跳过` : ""}
                    </p>
                    {parent && !balance && validShare ? (
                      <>
                        <p className="text-sm tabular-nums">
                          每人 {percent(allocationPPM)} · 本次共{" "}
                          {percent(allocationPPM * targets.length)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          来源已分配 {percent(parent.allocated_ppm)} → 分配后{" "}
                          {percent(projectedPPM)} ·{" "}
                          {validity === "none"
                            ? "长期有效"
                            : validity === "custom"
                              ? "指定日期到期"
                              : `${validity} 天后到期`}
                        </p>
                        {parent.windows.map((window) => (
                          <p
                            className="text-xs text-muted-foreground"
                            key={window.kind}
                          >
                            {window.kind} 每人额度{" "}
                            {money(
                              Math.floor(
                                (window.limit_nano_usd * allocationPPM) /
                                  1000000
                              )
                            )}
                          </p>
                        ))}
                      </>
                    ) : parent && balance ? (
                      <p className="text-sm text-muted-foreground">
                        可调用来源全部模型；不预扣余额，不创建共享额度订阅。
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        先选择用户和模型来源。
                      </p>
                    )}
                    {parent && !assignable(parent) ? (
                      <p className="text-sm text-destructive">
                        来源暂不可分配，请检查账户状态和额度规则。
                      </p>
                    ) : null}
                    {parent &&
                    !balance &&
                    validShare &&
                    projectedPPM > 1000000 ? (
                      <Alert>
                        <AlertCircleIcon />
                        <AlertTitle>分配后超过 100%</AlertTitle>
                        <AlertDescription>
                          多人同时使用时可能提前耗尽来源额度，请确认本次总份额。
                        </AlertDescription>
                      </Alert>
                    ) : null}
                    {!data.parents.length ? (
                      <Empty>
                        <EmptyHeader>
                          <EmptyTitle>尚无模型来源</EmptyTitle>
                          <EmptyDescription>
                            先连接模型账户后再分配。
                          </EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    ) : null}
                  </section>
                  <Separator />
                  <FieldGroup className="gap-4">
                    <Field>
                      <FieldLabel>如何结算</FieldLabel>
                      <ToggleGroup
                        disabled={Boolean(fixedParentID)}
                        variant="outline"
                        value={[effectiveMode]}
                        onValueChange={(value) => {
                          if (value[0]) {
                            setMode(value[0])
                            setParentID("")
                            setModels([])
                            setCustomName(null)
                          }
                        }}
                        aria-label="结算方式"
                      >
                        <ToggleGroupItem value="unmetered">
                          余额付费模型
                        </ToggleGroupItem>
                        <ToggleGroupItem value="observed">
                          共享额度订阅
                        </ToggleGroupItem>
                      </ToggleGroup>
                      <FieldDescription>
                        {balance
                          ? "获得模型调用权限，费用从每位用户自己的余额扣除。"
                          : "每位用户获得独立份额，使用同一订阅名称和有效期。"}
                      </FieldDescription>
                    </Field>
                    <Field>
                      <FieldLabel>模型来源</FieldLabel>
                      <Select
                        disabled={Boolean(fixedParentID)}
                        value={parentID || null}
                        onValueChange={(id) => id && changeParent(id)}
                        items={data.parents
                          .filter(
                            (view) => view.item.capacity_mode === effectiveMode
                          )
                          .map((view) => ({
                            value: view.item.id,
                            label: view.item.name,
                          }))}
                      >
                        <SelectTrigger className="w-full" aria-label="模型来源">
                          <SelectValue placeholder="选择模型账户" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {data.parents
                              .filter(
                                (view) =>
                                  view.item.capacity_mode === effectiveMode &&
                                  view.item.status !== "missing"
                              )
                              .map((view) => (
                                <SelectItem
                                  key={view.item.id}
                                  value={view.item.id}
                                  disabled={!assignable(view)}
                                >
                                  {view.item.name}
                                  {!assignable(view) ? " · 暂不可分配" : ""}
                                </SelectItem>
                              ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <FieldDescription className="break-all">
                        {sourceModels.length
                          ? sourceModels.join(" · ")
                          : parent
                            ? "继承来源允许的全部模型"
                            : "选择后展示可用模型与分配预览。"}
                      </FieldDescription>
                    </Field>
                    {!balance && parent ? (
                      <>
                        <Field>
                          <FieldLabel htmlFor="assign-subscription-name">
                            用户看到的订阅名
                          </FieldLabel>
                          <Input
                            id="assign-subscription-name"
                            value={name}
                            onChange={(event) =>
                              setCustomName(event.target.value)
                            }
                            required
                          />
                          <FieldDescription>
                            默认按套餐和每人份额命名，可自行修改。
                          </FieldDescription>
                        </Field>
                        <Field>
                          <FieldLabel>份额分配</FieldLabel>
                          <ToggleGroup
                            variant="outline"
                            value={[shareMode]}
                            onValueChange={(value) =>
                              value[0] && setShareMode(value[0])
                            }
                            aria-label="份额分配"
                          >
                            <ToggleGroupItem value="each">
                              每人固定比例
                            </ToggleGroupItem>
                            <ToggleGroupItem value="equal">
                              均分剩余份额
                            </ToggleGroupItem>
                          </ToggleGroup>
                        </Field>
                        {shareMode === "each" ? (
                          <Field>
                            <FieldLabel htmlFor="assign-user-percent">
                              每人份额（%）
                            </FieldLabel>
                            <Input
                              id="assign-user-percent"
                              type="number"
                              min="0.0001"
                              step="0.0001"
                              value={share}
                              onChange={(event) => setShare(event.target.value)}
                              required
                            />
                          </Field>
                        ) : null}
                        <Field>
                          <FieldLabel>订阅有效期</FieldLabel>
                          <Select
                            value={validity}
                            onValueChange={(value) =>
                              value && setValidity(value)
                            }
                            items={[
                              { value: "none", label: "长期有效" },
                              { value: "7", label: "7 天" },
                              { value: "30", label: "30 天" },
                              { value: "90", label: "90 天" },
                              { value: "custom", label: "指定日期" },
                            ]}
                          >
                            <SelectTrigger
                              aria-label="订阅有效期"
                              className="w-full"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {[
                                  ["none", "长期有效"],
                                  ["7", "7 天"],
                                  ["30", "30 天"],
                                  ["90", "90 天"],
                                  ["custom", "指定日期"],
                                ].map(([value, label]) => (
                                  <SelectItem key={value} value={value}>
                                    {label}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </Field>
                        {validity === "custom" ? (
                          <Field>
                            <FieldLabel htmlFor="assign-user-expiry">
                              到期时间
                            </FieldLabel>
                            <Input
                              id="assign-user-expiry"
                              type="datetime-local"
                              value={expiresAt}
                              onChange={(event) =>
                                setExpiresAt(event.target.value)
                              }
                              required
                            />
                          </Field>
                        ) : null}
                      </>
                    ) : null}
                  </FieldGroup>
                  {!balance && parent ? (
                    <Collapsible>
                      <CollapsibleTrigger
                        render={
                          <Button type="button" size="sm" variant="ghost" />
                        }
                      >
                        限定模型与优先级
                        <ChevronDownIcon data-icon="inline-end" />
                      </CollapsibleTrigger>
                      <CollapsibleContent className="pt-3">
                        <FieldGroup className="gap-4">
                          <Field>
                            <FieldLabel>授权模型范围</FieldLabel>
                            <ModelSelector
                              id="assign-user-models"
                              options={sourceModels}
                              value={models}
                              onChange={setModels}
                            />
                          </Field>
                          <Field>
                            <FieldLabel htmlFor="assign-user-priority">
                              路由优先级
                            </FieldLabel>
                            <Input
                              id="assign-user-priority"
                              type="number"
                              value={priority}
                              onChange={(event) =>
                                setPriority(event.target.value)
                              }
                            />
                          </Field>
                        </FieldGroup>
                      </CollapsibleContent>
                    </Collapsible>
                  ) : null}
                </div>
              </fieldset>
              {mutationError ? (
                <Alert variant="destructive" className="mt-4">
                  <AlertCircleIcon />
                  <AlertTitle>未完成分配</AlertTitle>
                  <AlertDescription>{mutationError}</AlertDescription>
                </Alert>
              ) : null}
              {error ? (
                <LoadErrorView
                  message={error}
                  onRetry={() => void reload(true)}
                />
              ) : null}
            </form>
            <DialogFooter className="grid grid-cols-[auto_1fr] items-center sm:flex">
              <p className="col-span-2 mr-auto text-sm text-muted-foreground">
                {selected.length} 人已选
                {parent && !balance && validShare
                  ? ` · 每人 ${percent(allocationPPM)}`
                  : ""}
              </p>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => onOpenChange(false)}
              >
                取消
              </Button>
              <Button
                type="submit"
                form="assign-users-form"
                disabled={!canSubmit}
              >
                {pending ? <Spinner /> : <UsersIcon data-icon="inline-start" />}
                确认分配给 {targets.length} 人
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

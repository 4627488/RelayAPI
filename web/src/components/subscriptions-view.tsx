import { useCallback } from "react"
import {
  AlertCircleIcon,
  ChevronDownIcon,
  Clock3Icon,
  GaugeIcon,
  PackageOpenIcon,
} from "lucide-react"
import { toast } from "@/components/ui/toast"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Progress, ProgressLabel } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { Separator } from "@/components/ui/separator"
import { PageHeader } from "@/components/workspace-ui"
import { LoadErrorView } from "@/components/load-error-view"
import { useAsyncResource } from "@/hooks/use-async-resource"
import {
  api,
  type ChildSubscription,
  type SubscriptionEntitlementWindow,
  type SubscriptionQuotaReset,
} from "@/lib/api"
import { dateTime, money } from "@/lib/format"

export function TenantSubscriptionsView() {
  const loadSubscriptions = useCallback(async () => {
    const value = await api<{ items: ChildSubscription[] }>(
      "/api/subscriptions"
    )
    return { items: value.items ?? [] }
  }, [])
  const {
    data: snapshot,
    loading,
    error,
    reload,
  } = useAsyncResource(loadSubscriptions, {
    initialData: { items: [] as ChildSubscription[] },
    errorMessage: "无法读取订阅",
    onBackgroundError: (message) =>
      toast.add({ title: message, type: "error" }),
  })
  const { items } = snapshot

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <PageHeader
        title="我的订阅"
        description="查看每个授权的可用额度、重置时间与模型范围。"
        accessory={
          !loading && !error && items.length > 0 ? (
            <Badge variant="secondary">{items.length} 个授权</Badge>
          ) : undefined
        }
      />
      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : error && items.length === 0 ? (
        <LoadErrorView message={error} onRetry={() => void reload(true)} />
      ) : items.length ? (
        <div className="flex flex-col gap-4">
          {items.map((item) => (
            <TenantSubscriptionCard key={item.id} item={item} />
          ))}
        </div>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PackageOpenIcon />
            </EmptyMedia>
            <EmptyTitle>尚未获得订阅授权</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  )
}

function TenantSubscriptionCard({ item }: { item: ChildSubscription }) {
  const models = item.effective_model_allowlist ?? item.model_allowlist ?? []
  const entitlementWindows = item.entitlement_windows ?? []
  const available = item.available ?? item.enabled

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-lg">{item.name}</CardTitle>
            <CardDescription className="mt-1">
              来自 {item.parent_name || "模型账户"}
              {item.parent_plan_type && item.parent_plan_type !== "native"
                ? ` · ${item.parent_plan_type}`
                : ""}
            </CardDescription>
          </div>
          <Badge
            variant={available ? "secondary" : "destructive"}
            title={item.availability_message}
          >
            {available ? "可用" : "不可用"}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {item.expires_at
            ? `有效期至 ${dateTime(item.expires_at)}`
            : "长期有效"}
          {!available && item.availability_message
            ? ` · ${item.availability_message}`
            : ""}
        </p>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        {entitlementWindows.length ? (
          <section className="flex flex-col gap-4" aria-label="额度窗口">
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-medium">额度</h3>
              <p className="text-xs text-muted-foreground">
                当前授权独立计量；重置时间跟随上游账户。
              </p>
            </div>
            <div className="grid gap-5 md:grid-cols-2">
              {entitlementWindows.map((window, index) => (
                <EntitlementWindow
                  key={`${window.kind}:${index}`}
                  window={window}
                />
              ))}
            </div>
          </section>
        ) : item.capacity_mode === "unmetered" ? (
          <Alert>
            <GaugeIcon />
            <AlertTitle>按账户余额结算</AlertTitle>
            <AlertDescription>
              调用费用从账户余额扣除，没有独立额度窗口。
            </AlertDescription>
          </Alert>
        ) : item.parent_quota_probe_status === "unsupported" ? (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>额度不可用</AlertTitle>
            <AlertDescription>
              {item.availability_message ||
                "这个模型账户没有可分配的额度窗口，请联系管理员调整结算方式。"}
            </AlertDescription>
          </Alert>
        ) : (
          <Alert>
            <GaugeIcon />
            <AlertTitle>当前按账户余额结算</AlertTitle>
            <AlertDescription>上游额度尚未形成可分配窗口。</AlertDescription>
          </Alert>
        )}

        {(entitlementWindows.length > 0 ||
          (item.reset_history?.length ?? 0) > 0) && (
          <ResetHistory items={item.reset_history ?? []} />
        )}
        <Separator />
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">可用模型</h3>
            {models.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {models.length} 个
              </span>
            )}
          </div>
          {models.length ? (
            <div className="flex flex-wrap gap-1.5">
              {models.map((model) => (
                <Badge
                  key={model}
                  variant="outline"
                  className="font-mono font-normal"
                >
                  {model}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              继承账户的可用模型；上游可能未提供完整模型清单。
            </p>
          )}
        </section>
      </CardContent>
    </Card>
  )
}

function EntitlementWindow({
  window,
}: {
  window: SubscriptionEntitlementWindow
}) {
  const remaining =
    window.limit_nano_usd > 0
      ? Math.min(
          100,
          Math.max(0, (window.remaining_nano_usd / window.limit_nano_usd) * 100)
        )
      : 0
  const roundedRemaining = Math.round(remaining)

  return (
    <Progress
      value={remaining}
      className="gap-2 [&_[data-slot=progress-track]]:h-2"
    >
      <div className="flex w-full items-center justify-between gap-2">
        <ProgressLabel>{quotaWindowLabel(window.kind)}</ProgressLabel>
        <span className="text-sm text-muted-foreground tabular-nums">
          {roundedRemaining}% 剩余
        </span>
      </div>
      <p className="w-full text-2xl font-semibold tracking-tight tabular-nums">
        {money(window.remaining_nano_usd)}{" "}
        <span className="text-sm font-normal text-muted-foreground">
          / {money(window.limit_nano_usd)}
        </span>
      </p>
      <p
        className="w-full text-xs text-muted-foreground"
        title={dateTime(window.resets_at)}
      >
        下次重置：{dateTime(window.resets_at)} ·{" "}
        {resetDescription(window.resets_at)}
      </p>
    </Progress>
  )
}

function ResetHistory({ items }: { items: SubscriptionQuotaReset[] }) {
  return (
    <section className="flex flex-col gap-3" aria-label="重置记录">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">最近重置记录</h3>
        <p className="text-xs text-muted-foreground">
          上游确认重置后记录；共享同一上游的授权使用相同时间。
        </p>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无已确认的重置记录</p>
      ) : (
        <>
          <ResetRows items={items.slice(0, 3)} />
          {items.length > 3 && (
            <Collapsible>
              <CollapsibleTrigger className="flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                <ChevronDownIcon className="size-4" />
                查看其余 {items.length - 3} 条
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3">
                <ResetRows items={items.slice(3)} />
              </CollapsibleContent>
            </Collapsible>
          )}
        </>
      )}
    </section>
  )
}

function ResetRows({ items }: { items: SubscriptionQuotaReset[] }) {
  return (
    <ol className="flex flex-col gap-2">
      {items.map((item) => (
        <li
          key={`${item.kind}:${item.reset_at}`}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
        >
          <Clock3Icon
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="font-medium">{dateTime(item.reset_at)}</span>
          <span className="text-muted-foreground">
            {quotaWindowLabel(item.kind)}额度已重置
          </span>
        </li>
      ))}
    </ol>
  )
}

function quotaWindowLabel(kind: string) {
  const normalized = kind.toLowerCase().replaceAll("_", "")
  if (normalized === "5h" || normalized === "fivehour") return "5 小时"
  if (normalized === "7d" || normalized === "weekly" || normalized === "week")
    return "7 天"
  if (normalized === "monthly" || normalized === "month") return "月度"
  return kind
}

function resetDescription(value: string) {
  const remaining = new Date(value).getTime() - Date.now()
  if (!Number.isFinite(remaining) || remaining <= 0) return "等待上游更新"
  const minutes = Math.ceil(remaining / 60_000)
  if (minutes < 60) return `约 ${minutes} 分钟后`
  const hours = Math.ceil(minutes / 60)
  if (hours < 48) return `约 ${hours} 小时后`
  return `约 ${Math.ceil(hours / 24)} 天后`
}

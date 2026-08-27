import { useCallback } from "react"
import { AlertTriangleIcon, GaugeIcon, PackageOpenIcon } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
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
} from "@/lib/api"
import { dateTime, money } from "@/lib/format"

export function TenantSubscriptionsView() {
  const loadSubscriptions = useCallback(async () => {
    const value = await api<{ items: ChildSubscription[] }>(
      "/api/subscriptions"
    )
    return value.items ?? []
  }, [])
  const {
    data: items,
    loading,
    error,
    reload,
  } = useAsyncResource(loadSubscriptions, {
    initialData: [],
    errorMessage: "无法读取订阅",
    onBackgroundError: (message) => toast.error(message),
  })

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="我的订阅" description="当前账户可用的模型容量。" />
      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : error && items.length === 0 ? (
        <LoadErrorView message={error} onRetry={() => void reload(true)} />
      ) : items.length ? (
        <div className="grid gap-4 xl:grid-cols-2">
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
      <CardHeader className="border-b bg-muted/15">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{item.name}</CardTitle>
            <CardDescription className="mt-1">
              {item.parent_name || "模型账户"}
              {item.parent_plan_type && item.parent_plan_type !== "native"
                ? ` · ${item.parent_plan_type}`
                : ""}
              {item.expires_at
                ? ` · 有效期至 ${dateTime(item.expires_at)}`
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
      </CardHeader>

      <CardContent className="flex flex-col gap-5 pt-5">
        {entitlementWindows.length ? (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">共享额度</h3>
            <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
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
          </Alert>
        ) : item.parent_quota_probe_status === "unsupported" ? (
          <Alert variant="destructive">
            <AlertTriangleIcon />
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
          </Alert>
        )}

        <Separator />
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">可用模型</h3>
            <Badge variant="secondary">{models.length} 个</Badge>
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
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              此授权继承账户全部可用模型，或账户尚未提供可枚举的模型清单。
            </div>
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
      className="gap-2 border-t pt-3 first:border-t-0 [&_[data-slot=progress-track]]:h-2"
    >
      <ProgressLabel className="text-base">
        {quotaWindowLabel(window.kind)}
      </ProgressLabel>
      <Badge
        variant={
          roundedRemaining <= 10
            ? "destructive"
            : roundedRemaining <= 25
              ? "secondary"
              : "outline"
        }
      >
        {roundedRemaining === 0 ? "已用完" : `剩余 ${roundedRemaining}%`}
      </Badge>
      <p className="w-full text-lg font-semibold tabular-nums">
        {money(window.remaining_nano_usd)}{" "}
        <span className="text-sm font-normal text-muted-foreground">
          / {money(window.limit_nano_usd)}
        </span>
      </p>
      <p className="w-full text-xs text-muted-foreground">
        {resetDescription(window.resets_at)}
      </p>
    </Progress>
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
  const target = new Date(value).getTime()
  const remaining = target - Date.now()
  if (!Number.isFinite(target) || remaining <= 0)
    return `${dateTime(value)} 重置`
  const minutes = Math.ceil(remaining / 60_000)
  if (minutes < 60) return `${minutes} 分钟后重置`
  const hours = Math.ceil(minutes / 60)
  if (hours < 48) return `${hours} 小时后重置`
  return `${Math.ceil(hours / 24)} 天后重置`
}

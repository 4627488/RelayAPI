import { useCallback, useEffect, useState } from "react"
import { cn } from "cn"
import {
  ChevronDownIcon,
  CopyIcon,
  PackageOpenIcon,
  RefreshCwIcon,
} from "lucide-react"
import { toast } from "@/components/ui/toast"
import { Badge } from "@/components/ui/badge"
import { Card, CardHeader, CardContent, CardFooter } from "@/components/ui/card"
import { copyText } from "@/lib/clipboard"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Progress, ProgressLabel } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { PageHeader } from "@/components/workspace-ui"
import { LoadErrorView } from "@/components/load-error-view"
import { useAsyncResource } from "@/hooks/use-async-resource"
import {
  api,
  type TenantSubscription,
  type SubscriptionEntitlementWindow,
} from "@/lib/api"
import { money } from "@/lib/format"
import { routeHref } from "@/lib/routes"

export function TenantSubscriptionsView() {
  const loadSubscriptions = useCallback(async () => {
    const value = await api<{ items: TenantSubscription[] }>(
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
    initialData: { items: [] as TenantSubscription[] },
    errorMessage: "无法读取订阅",
    onBackgroundError: (message) =>
      toast.add({ title: message, type: "error" }),
  })
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const scrollToSubscription = () => {
      try {
        const target = decodeURIComponent(window.location.hash.slice(1))
        if (target.startsWith("subscription-"))
          document.getElementById(target)?.scrollIntoView({ block: "center" })
      } catch {
        /* Ignore malformed fragment identifiers. */
      }
    }
    scrollToSubscription()
    window.addEventListener("hashchange", scrollToSubscription)
    return () => window.removeEventListener("hashchange", scrollToSubscription)
  }, [snapshot.items])
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const items = snapshot.items.filter(
    (item) => item.capacity_mode === "observed" || item.billing_mode === "quota"
  )
  const ordered = [...items].sort(
    (a, b) => subscriptionState(a, now).order - subscriptionState(b, now).order
  )
  return (
    <div className="flex max-w-6xl min-w-0 flex-col gap-6">
      <PageHeader
        title="我的订阅"
        actions={
          <>
            <Button
              variant="ghost"
              nativeButton={false}
              role="link"
              render={
                <a href={routeHref({ workspace: "user", page: "models" })} />
              }
            >
              模型列表
            </Button>
            <Button
              variant="outline"
              disabled={loading}
              onClick={() => {
                setNow(Date.now())
                void reload(true)
              }}
            >
              {loading ? (
                <Spinner />
              ) : (
                <RefreshCwIcon data-icon="inline-start" />
              )}
              刷新
            </Button>
          </>
        }
      />
      {loading && !items.length ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : error && !items.length ? (
        <LoadErrorView message={error} onRetry={() => void reload(true)} />
      ) : items.length ? (
        <>
          {error ? (
            <LoadErrorView message={error} onRetry={() => void reload(true)} />
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
            <p>
              {items.length} 项订阅 ·{" "}
              {
                items.filter((item) => subscriptionState(item, now).order === 0)
                  .length
              }{" "}
              项可用
            </p>
            <p>额度重置不延长订阅有效期</p>
          </div>
          <div className="flex min-w-0 flex-col gap-6">
            {ordered.map((item) => (
              <SubscriptionRow key={item.id} item={item} now={now} />
            ))}
          </div>
        </>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PackageOpenIcon />
            </EmptyMedia>
            <EmptyTitle>暂无共享额度订阅</EmptyTitle>
            <EmptyDescription>
              管理员分配订阅后，额度和有效期会显示在这里。你也可以在模型列表中查看当前可用的模型与结算方式。
            </EmptyDescription>
          </EmptyHeader>
          <Button
            variant="outline"
            nativeButton={false}
            role="link"
            render={
              <a href={routeHref({ workspace: "user", page: "models" })} />
            }
          >
            查看可用模型
          </Button>
        </Empty>
      )}
    </div>
  )
}

function SubscriptionRow({
  item,
  now,
}: {
  item: TenantSubscription
  now: number
}) {
  const state = subscriptionState(item, now)
  const windows = item.entitlement_windows ?? []
  const models = item.effective_model_allowlist ?? item.model_allowlist ?? []
  const expires = timestamp(item.expires_at)
  const starts = timestamp(item.starts_at)
  // Older servers may still send upstream identities. Never use them as a title or subtitle.
  const name =
    item.name?.trim() && !item.name.includes("@") ? item.name : "模型订阅"
  return (
    <article
      id={`subscription-${item.id}`}
      aria-label={name}
      className="min-w-0 scroll-mt-6"
    >
      <Card>
        <CardHeader className="gap-4 border-b sm:flex sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="min-w-0 text-lg font-semibold break-words">
                {name}
              </h2>
              <Badge
                variant={state.tone === "critical" ? "destructive" : "outline"}
              >
                {state.label}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {starts !== null ? (
                <>
                  <time dateTime={item.starts_at}>{fullDate(starts)}</time>{" "}
                  起生效
                </>
              ) : (
                "生效时间待同步"
              )}
              {starts !== null && starts > now
                ? ` · ${duration(starts - now)}后生效`
                : null}
            </p>
          </div>
          <div className="flex shrink-0 flex-col gap-1 text-sm sm:text-right">
            <p className="font-medium">
              {expires !== null
                ? expires > now
                  ? `剩余 ${duration(expires - now)}`
                  : "订阅已结束"
                : item.expires_at
                  ? "有效期暂不可用"
                  : "长期有效"}
            </p>
            {expires !== null ? (
              <p className="text-xs text-muted-foreground">
                <time dateTime={item.expires_at!}>{fullDate(expires)}</time>{" "}
                到期
              </p>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-6">
          {windows.length ? (
            <div
              className={cn(
                "grid min-w-0 gap-6",
                windows.length > 1 && "sm:grid-cols-2 sm:gap-8"
              )}
            >
              {windows.map((window, index) => (
                <EntitlementWindow
                  key={`${window.kind}:${index}`}
                  window={window}
                  now={now}
                  inactive={
                    [1, 3, 4].includes(state.order) || item.available === false
                  }
                  expires={expires}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <h3 className="font-medium">额度待同步</h3>
              <p className="text-sm text-muted-foreground">
                暂时无法读取订阅额度，请稍后刷新或联系管理员。
              </p>
            </div>
          )}
          {state.label === "暂不可用" ? (
            <p className="text-sm text-muted-foreground">
              此订阅暂时无法使用，请稍后重试或联系管理员。
            </p>
          ) : null}
          <section
            className="flex min-w-0 flex-col gap-3 border-t pt-4"
            aria-label="订阅模型"
          >
            <h3 className="text-sm font-medium">
              适用模型{" "}
              <span className="ml-1 font-normal text-muted-foreground">
                {models.length || ""}
              </span>
            </h3>
            {models.length ? (
              <ul className="grid min-w-0 gap-x-6 gap-y-1 sm:grid-cols-2">
                {models.map((model) => (
                  <li
                    key={model}
                    className="flex min-w-0 items-center justify-between gap-2 rounded-md bg-muted/40 py-1 pr-1 pl-3"
                  >
                    <code className="min-w-0 text-xs break-all">{model}</code>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`复制模型 ${model}`}
                      onClick={async () => {
                        try {
                          await copyText(model)
                          toast.add({
                            title: "已复制模型名称",
                            type: "success",
                          })
                        } catch {
                          toast.add({
                            title: "复制失败，请重试",
                            type: "error",
                          })
                        }
                      }}
                    >
                      <CopyIcon />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                具体可用模型以模型列表为准。
              </p>
            )}
          </section>
        </CardContent>
        <CardFooter className="block bg-transparent">
          {item.reset_history?.length ? (
            <Collapsible>
              <CollapsibleTrigger
                render={
                  <Button size="sm" variant="ghost" className="group -ml-2" />
                }
              >
                重置记录 · {item.reset_history.length}
                <ChevronDownIcon
                  data-icon="inline-end"
                  className="transition-transform group-aria-expanded:rotate-180"
                />
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3">
                <ol className="flex flex-col divide-y text-xs">
                  {item.reset_history.map((reset, index) => (
                    <li
                      key={`${reset.kind}:${reset.reset_at}:${index}`}
                      className="flex flex-wrap justify-between gap-2 py-2"
                    >
                      <span>{quotaWindowLabel(reset.kind)}额度重置</span>
                      <time
                        className="text-muted-foreground tabular-nums"
                        dateTime={reset.reset_at}
                      >
                        {fullDate(timestamp(reset.reset_at))}
                      </time>
                    </li>
                  ))}
                </ol>
              </CollapsibleContent>
            </Collapsible>
          ) : (
            <p className="text-xs text-muted-foreground">暂无重置记录</p>
          )}
        </CardFooter>
      </Card>
    </article>
  )
}

function EntitlementWindow({
  window,
  now,
  inactive,
  expires,
}: {
  window: SubscriptionEntitlementWindow
  now: number
  inactive: boolean
  expires: number | null
}) {
  const known =
    Number.isFinite(window.limit_nano_usd) &&
    window.limit_nano_usd > 0 &&
    Number.isFinite(window.remaining_nano_usd)
  const remaining = known ? Math.max(0, window.remaining_nano_usd) : 0
  const percent = known
    ? Math.min(100, (remaining / window.limit_nano_usd) * 100)
    : 0
  const reset = timestamp(window.resets_at)
  const tone =
    inactive || !known || (reset !== null && reset <= now)
      ? "muted"
      : percent <= 10
        ? "critical"
        : percent <= 30
          ? "warning"
          : "healthy"
  const resetAfterExpiry =
    expires !== null && reset !== null && reset >= expires
  return (
    <section
      aria-label={`${quotaWindowLabel(window.kind)}额度`}
      className="flex min-w-0 flex-col gap-2"
    >
      <Progress
        value={known ? percent : null}
        className="subscription-meter gap-2"
        data-tone={tone}
      >
        <div className="flex w-full items-center justify-between gap-2">
          <ProgressLabel>{quotaWindowLabel(window.kind)}剩余</ProgressLabel>
          <span
            className="subscription-signal text-xs font-medium tabular-nums"
            data-tone={tone}
          >
            {!known
              ? "待同步"
              : remaining === 0
                ? "已用尽"
                : percent < 1
                  ? "不足 1%"
                  : `${Math.floor(percent)}%`}
          </span>
        </div>
        <p className="w-full text-2xl font-semibold tracking-tight tabular-nums">
          {known ? money(remaining) : "—"}
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            / {known ? money(window.limit_nano_usd) : "额度待同步"}
          </span>
        </p>
      </Progress>
      {known ? (
        <p className="text-xs text-muted-foreground">
          已用 {money(window.settled_nano_usd)}
          {window.reserved_nano_usd > 0
            ? ` · 请求处理中 ${money(window.reserved_nano_usd)}`
            : ""}
        </p>
      ) : null}
      <div className="mt-1 flex flex-col gap-1 text-xs text-muted-foreground">
        {inactive ? (
          <p>当前订阅不可使用，以上为最后记录的额度。</p>
        ) : resetAfterExpiry ? (
          <p>订阅将在下次额度重置前到期</p>
        ) : reset === null ? (
          <p>重置时间待同步</p>
        ) : reset <= now ? (
          <p>重置时间已到，等待额度更新</p>
        ) : (
          <>
            <p>
              <span className="text-foreground">
                {duration(reset - now)}后重置
              </span>
            </p>
            <time dateTime={window.resets_at}>{fullDate(reset)}</time>
          </>
        )}
      </div>
    </section>
  )
}

function subscriptionState(item: TenantSubscription, now: number) {
  const expires = timestamp(item.expires_at)
  const starts = timestamp(item.starts_at)
  if (expires !== null && expires <= now)
    return { label: "已到期", tone: "muted", order: 4 }
  if (!item.enabled) return { label: "已停用", tone: "muted", order: 3 }
  if (starts !== null && starts > now)
    return { label: "待生效", tone: "warning", order: 1 }
  if (item.available === false)
    return { label: "暂不可用", tone: "warning", order: 2 }
  if (
    item.entitlement_windows?.some(
      (window) => window.limit_nano_usd > 0 && window.remaining_nano_usd <= 0
    )
  )
    return { label: "额度已用尽", tone: "critical", order: 2 }
  if (
    item.entitlement_windows?.some((window) => {
      const reset = timestamp(window.resets_at)
      return reset !== null && reset <= now
    })
  )
    return { label: "额度更新中", tone: "muted", order: 2 }
  const soon = expires !== null && expires - now <= 7 * 86400_000
  return {
    label: soon ? "即将到期" : "可用",
    tone: soon ? "warning" : "healthy",
    order: 0,
  }
}
function timestamp(value?: string | null) {
  if (!value) return null
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : null
}
function fullDate(value: number | null) {
  return value === null
    ? "时间待同步"
    : new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(value)
}
function duration(ms: number) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24)
    return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ""}`
  return `${Math.floor(hours / 24)} 天${hours % 24 ? ` ${hours % 24} 小时` : ""}`
}
function quotaWindowLabel(kind: string) {
  const normalized = kind.toLowerCase().replaceAll("_", "")
  if (["5h", "fivehour"].includes(normalized)) return "5 小时"
  if (["7d", "weekly", "week"].includes(normalized)) return "每周"
  if (["daily", "day", "1d"].includes(normalized)) return "每日"
  if (["monthly", "month"].includes(normalized)) return "每月"
  return kind
}

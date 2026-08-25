import { useEffect, useState } from "react"
import { Banner } from "@astryxdesign/core/Banner"
import { EmptyState } from "@astryxdesign/core/EmptyState"
import { Grid } from "@astryxdesign/core/Grid"
import { HStack, VStack } from "@astryxdesign/core/Layout"
import { List, ListItem } from "@astryxdesign/core/List"
import { ProgressBar } from "@astryxdesign/core/ProgressBar"
import { Text } from "@astryxdesign/core/Text"
import { Token } from "@astryxdesign/core/Token"
import { useToast } from "@astryxdesign/core/Toast"
import { PackageOpenIcon } from "lucide-react"

import { CountBadge, PageHeader, SectionCard, StatusLabel } from "@/components/page-kit"
import { LoadingView } from "@/components/loading-view"
import {
  api,
  type ChildSubscription,
  type SubscriptionEntitlementWindow,
} from "@/lib/api"
import { dateTime, money } from "@/lib/format"

export function TenantSubscriptionsView() {
  const toast = useToast()
  const [items, setItems] = useState<ChildSubscription[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api<{ items: ChildSubscription[] }>("/api/subscriptions")
      .then((value) => setItems(value.items ?? []))
      .catch((cause) =>
        toast({
          type: "error",
          body: cause instanceof Error ? cause.message : "无法读取订阅",
        })
      )
      .finally(() => setLoading(false))
  }, [toast])

  if (loading) return <LoadingView />

  return (
    <VStack gap={4}>
      <PageHeader title="我的订阅" />
      {items.length ? (
        <VStack gap={4}>
          {items.map((item) => (
            <TenantSubscriptionCard key={item.id} item={item} />
          ))}
        </VStack>
      ) : (
        <EmptyState
          title="尚未获得订阅授权"
          description="管理员分配模型账户后，你可以在这里查看结算方式和可用范围。"
          icon={<PackageOpenIcon />}
        />
      )}
    </VStack>
  )
}

function TenantSubscriptionCard({ item }: { item: ChildSubscription }) {
  const models = item.effective_model_allowlist ?? item.model_allowlist ?? []
  const entitlementWindows = item.entitlement_windows ?? []
  const available = item.available ?? item.enabled

  return (
    <SectionCard
      title={item.name}
      description={[
        item.parent_name || "模型账户",
        item.parent_plan_type && item.parent_plan_type !== "native"
          ? item.parent_plan_type
          : null,
        item.expires_at ? `有效期至 ${dateTime(item.expires_at)}` : null,
      ]
        .filter(Boolean)
        .join(" · ")}
      actions={
        <StatusLabel
          tone={available ? "success" : "error"}
          label={available ? "可用" : "不可用"}
        />
      }
    >
      <VStack gap={4}>
        {entitlementWindows.length ? (
          <VStack gap={3}>
            <VStack gap={1}>
              <Text weight="semibold">共享额度</Text>
              <Text color="secondary" type="supporting">
                你在每个账户额度窗口中可使用的份额。
              </Text>
            </VStack>
            <Grid columns={{ minWidth: 240, max: 2 }} gap={3}>
              {entitlementWindows.map((window, index) => (
                <EntitlementWindow
                  key={`${window.kind}:${index}`}
                  window={window}
                />
              ))}
            </Grid>
          </VStack>
        ) : item.capacity_mode === "unmetered" ? (
          <Banner
            status="info"
            title="按账户余额结算"
            description="请求固定到这个模型账户，每次调用从你的 Relay 余额扣除。"
            collapsible={false}
          />
        ) : item.parent_quota_probe_status === "unsupported" ? (
          <Banner
            status="error"
            title="额度不可用"
            description={
              item.availability_message ||
              "这个模型账户没有可分配的额度窗口，请联系管理员调整结算方式。"
            }
            collapsible={false}
          />
        ) : (
          <Banner
            status="info"
            title="当前按账户余额结算"
            description="这条授权没有独立额度窗口，请求费用从你的 Relay 余额扣除。"
            collapsible={false}
          />
        )}

        <VStack gap={3}>
          <HStack hAlign="between" vAlign="center" gap={3}>
            <VStack gap={1}>
              <Text weight="semibold">可用模型</Text>
              <Text color="secondary" type="supporting">
                此授权当前允许访问的模型。
              </Text>
            </VStack>
            <CountBadge value={models.length} />
          </HStack>
          {models.length ? (
            <List density="compact" hasDividers>
              {models.map((model) => (
                <ListItem key={model} label={model} />
              ))}
            </List>
          ) : (
            <Text color="secondary">
              此授权继承账户全部可用模型，或账户尚未提供可枚举的模型清单。
            </Text>
          )}
        </VStack>
      </VStack>
    </SectionCard>
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
  const variant =
    roundedRemaining <= 10
      ? "error"
      : roundedRemaining <= 25
        ? "warning"
        : "accent"

  return (
    <VStack gap={2}>
      <HStack hAlign="between" vAlign="center" gap={3}>
        <Text weight="semibold">{quotaWindowLabel(window.kind)}</Text>
        <Token
          label={
            roundedRemaining === 0 ? "已用完" : `剩余 ${roundedRemaining}%`
          }
          color={
            roundedRemaining <= 10
              ? "red"
              : roundedRemaining <= 25
                ? "orange"
                : "gray"
          }
        />
      </HStack>
      <ProgressBar
        label={`${quotaWindowLabel(window.kind)}剩余额度`}
        value={remaining}
        variant={variant}
        hasValueLabel
        formatValueLabel={() =>
          `${money(window.remaining_nano_usd)} / ${money(window.limit_nano_usd)}`
        }
      />
      <Text color="secondary" type="supporting">
        {resetDescription(window.resets_at)}
      </Text>
    </VStack>
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

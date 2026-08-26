import { useEffect, useState, type ReactNode } from "react"
import { Banner } from "@astryxdesign/core/Banner"
import { EmptyState } from "@astryxdesign/core/EmptyState"
import { HStack, VStack } from "@astryxdesign/core/Layout"
import { List, ListItem } from "@astryxdesign/core/List"
import { ProgressBar } from "@astryxdesign/core/ProgressBar"
import { Text } from "@astryxdesign/core/Text"
import { Token } from "@astryxdesign/core/Token"
import { useToast } from "@astryxdesign/core/Toast"
import { PackageOpenIcon } from "lucide-react"

import { PageFrame, PageSection, StatusLabel } from "@/components/page-kit"
import { LoadingView } from "@/components/loading-view"
import {
  api,
  type ChildSubscription,
  type SubscriptionEntitlementWindow,
} from "@/lib/api"
import { dateTime, money } from "@/lib/format"

export function TenantSubscriptionsView({
  accessory,
}: {
  accessory?: ReactNode
}) {
  const toast = useToast()
  const [items, setItems] = useState<ChildSubscription[]>([])
  const [selectedID, setSelectedID] = useState("")
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api<{ items: ChildSubscription[] }>("/api/subscriptions")
      .then((value) => {
        const next = value.items ?? []
        setItems(next)
        setSelectedID((current) => current || next[0]?.id || "")
      })
      .catch((cause) =>
        toast({
          type: "error",
          body: cause instanceof Error ? cause.message : "无法读取订阅",
        })
      )
      .finally(() => setLoading(false))
  }, [toast])

  if (loading) return <LoadingView />

  const selected = items.find((item) => item.id === selectedID)

  return (
    <PageFrame title="订阅" accessory={accessory}>
      {items.length ? (
        <VStack gap={0}>
          <List density="compact" hasDividers>
            {items.map((item) => (
              <ListItem
                key={item.id}
                label={item.name}
                description={item.parent_name || undefined}
                isSelected={item.id === selectedID}
                onClick={() => setSelectedID(item.id)}
                endContent={
                  <StatusLabel
                    tone={(item.available ?? item.enabled) ? "success" : "error"}
                    label={(item.available ?? item.enabled) ? "可用" : "不可用"}
                  />
                }
              />
            ))}
          </List>
          {selected ? <SubscriptionDetail item={selected} /> : null}
        </VStack>
      ) : (
        <EmptyState title="没有订阅" icon={<PackageOpenIcon />} />
      )}
    </PageFrame>
  )
}

function SubscriptionDetail({ item }: { item: ChildSubscription }) {
  const models = item.effective_model_allowlist ?? item.model_allowlist ?? []
  const entitlementWindows = item.entitlement_windows ?? []

  return (
    <PageSection title={item.name} dividers={["top"]}>
      <VStack gap={4}>
        {entitlementWindows.length ? (
          <VStack gap={3}>
            {entitlementWindows.map((window, index) => (
              <EntitlementWindow
                key={`${window.kind}:${index}`}
                window={window}
              />
            ))}
          </VStack>
        ) : (
          <Banner
            status={
              item.parent_quota_probe_status === "unsupported" ? "error" : "info"
            }
            title={
              item.parent_quota_probe_status === "unsupported"
                ? item.availability_message || "额度不可用"
                : "余额结算"
            }
            collapsible={false}
          />
        )}
        {models.length ? (
          <List density="compact" hasDividers>
            {models.map((model) => (
              <ListItem key={model} label={model} />
            ))}
          </List>
        ) : (
          <Text color="secondary">全部模型</Text>
        )}
      </VStack>
    </PageSection>
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
          label={roundedRemaining === 0 ? "已用完" : `${roundedRemaining}%`}
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
        label={quotaWindowLabel(window.kind)}
        isLabelHidden
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
  if (!Number.isFinite(target) || remaining <= 0) return dateTime(value)
  const minutes = Math.ceil(remaining / 60_000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.ceil(minutes / 60)
  if (hours < 48) return `${hours} 小时`
  return `${Math.ceil(hours / 24)} 天`
}

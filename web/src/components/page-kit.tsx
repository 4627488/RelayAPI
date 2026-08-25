import type { ComponentType, ReactNode } from "react"
import { ResponsiveContainer } from "recharts"
import { useTheme } from "@astryxdesign/core/theme"
import { Badge } from "@astryxdesign/core/Badge"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { Grid } from "@astryxdesign/core/Grid"
import { Icon } from "@astryxdesign/core/Icon"
import {
  HStack,
  Layout,
  LayoutContent,
  LayoutHeader,
  StackItem,
  VStack,
} from "@astryxdesign/core/Layout"
import { StatusDot } from "@astryxdesign/core/StatusDot"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useToast } from "@astryxdesign/core/Toast"
import { CopyIcon } from "lucide-react"

import { copyText } from "@/lib/clipboard"

export function PageHeader({
  title,
  accessory,
  actions,
}: {
  title?: ReactNode
  accessory?: ReactNode
  actions?: ReactNode
}) {
  if (!title && !accessory && !actions) return null
  return (
    <HStack hAlign="between" vAlign="center" gap={3} wrap="wrap">
      {title || accessory ? (
        <HStack gap={2} vAlign="center" wrap="wrap">
          {title ? (
            typeof title === "string" ? (
              <Heading level={1}>{title}</Heading>
            ) : (
              title
            )
          ) : null}
          {accessory}
        </HStack>
      ) : null}
      {actions ? (
        <HStack gap={2} vAlign="center" wrap="wrap">
          {actions}
        </HStack>
      ) : null}
    </HStack>
  )
}

export interface MetricItem {
  label: string
  value: ReactNode
  hint?: ReactNode
  icon?: ComponentType<{ className?: string }>
}

export function MetricGrid({ items }: { items: MetricItem[] }) {
  return (
    <Grid columns={{ minWidth: 180, max: 4 }} gap={3}>
      {items.map((item) => {
        const IconComponent = item.icon
        return (
          <Card key={item.label} padding={4} elevation="low">
            <VStack gap={1}>
              <HStack hAlign="between" vAlign="start" gap={2}>
                <Text color="secondary" type="supporting">
                  {item.label}
                </Text>
                {IconComponent ? (
                  <Icon icon={IconComponent} color="secondary" size="sm" />
                ) : null}
              </HStack>
              <Heading level={3}>{item.value}</Heading>
              {item.hint ? (
                <Text color="secondary" type="supporting">
                  {item.hint}
                </Text>
              ) : null}
            </VStack>
          </Card>
        )
      })}
    </Grid>
  )
}

export function ChartFrame({ children }: { children: ReactNode }) {
  return (
    <Card height={288} padding={0} elevation="none">
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </Card>
  )
}

export function useChartColors() {
  const { token } = useTheme()
  return {
    text: token("--color-text-secondary"),
    border: token("--color-border"),
    accent: token("--color-accent"),
    muted: token("--color-text-secondary"),
    error: token("--color-error"),
    success: token("--color-success"),
    warning: token("--color-warning"),
    blue: token("--color-text-blue"),
    surface: token("--color-background-card"),
  }
}

export function SearchField({
  label = "搜索",
  value,
  onChange,
  placeholder,
}: {
  label?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  return (
    <TextInput
      label={label}
      isLabelHidden
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      hasClear
    />
  )
}

export function CopyField({
  id,
  label,
  value,
  description,
}: {
  id: string
  label: string
  value: string
  description?: string
}) {
  const toast = useToast()
  return (
    <HStack gap={2} vAlign="end">
      <StackItem size="fill">
        <TextInput
          id={id}
          label={label}
          value={value}
          isReadOnly
          description={description}
          width="100%"
        />
      </StackItem>
      <Button
        label="复制"
        variant="secondary"
        icon={<CopyIcon />}
        onClick={() => {
          copyText(value)
            .then(() => toast({ body: "已复制" }))
            .catch(() => toast({ type: "error", body: "复制失败" }))
        }}
      />
    </HStack>
  )
}

export function StatusLabel({
  tone,
  label,
}: {
  tone: "success" | "warning" | "error" | "neutral" | "accent"
  label: string
}) {
  return (
    <HStack gap={1} vAlign="center">
      <StatusDot variant={tone} label={label} />
      <Text>{label}</Text>
    </HStack>
  )
}

export function CountBadge({ value }: { value: number | string }) {
  return <Badge label={String(value)} />
}

export function SectionCard({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <Card padding={0} elevation="low">
      <Layout
        height="auto"
        defaultHasDividers
        header={
          <LayoutHeader>
            <HStack hAlign="between" vAlign="start" gap={3} wrap="wrap">
              <VStack gap={1}>
                <Heading level={3}>{title}</Heading>
                {description ? (
                  <Text color="secondary">{description}</Text>
                ) : null}
              </VStack>
              {actions}
            </HStack>
          </LayoutHeader>
        }
        content={<LayoutContent>{children}</LayoutContent>}
      />
    </Card>
  )
}

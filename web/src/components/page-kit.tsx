import type { ReactNode } from "react"
import { ResponsiveContainer } from "recharts"
import { useTheme } from "@astryxdesign/core/theme"
import { Badge } from "@astryxdesign/core/Badge"
import { Button } from "@astryxdesign/core/Button"
import { Divider } from "@astryxdesign/core/Divider"
import {
  HStack,
  Layout,
  LayoutContent,
  LayoutHeader,
  StackItem,
  VStack,
} from "@astryxdesign/core/Layout"
import { Section } from "@astryxdesign/core/Section"
import { StatusDot } from "@astryxdesign/core/StatusDot"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useToast } from "@astryxdesign/core/Toast"
import { CopyIcon } from "lucide-react"

import { copyText } from "@/lib/clipboard"

type Spacing = 0 | 4 | 5 | 6 | 8

export function PageFrame({
  title,
  accessory,
  actions,
  children,
  contentWidth,
  contentPadding = 0,
  footer,
  end,
  start,
}: {
  title?: ReactNode
  accessory?: ReactNode
  actions?: ReactNode
  children: ReactNode
  contentWidth?: number
  contentPadding?: Spacing
  footer?: ReactNode
  end?: ReactNode
  start?: ReactNode
}) {
  const hasHeader = Boolean(title || accessory || actions)
  return (
    <Layout
      height="fill"
      defaultHasDividers
      contentWidth={contentWidth}
      start={start}
      end={end}
      footer={footer}
      header={
        hasHeader ? (
          <LayoutHeader>
            <HStack hAlign="between" vAlign="center" gap={3} wrap="wrap">
              {typeof title === "string" ? (
                <Heading level={1}>{title}</Heading>
              ) : (
                title
              )}
              {accessory}
              {actions}
            </HStack>
          </LayoutHeader>
        ) : undefined
      }
    >
      <LayoutContent padding={contentPadding}>{children}</LayoutContent>
    </Layout>
  )
}

export function PageSection({
  title,
  actions,
  children,
  padding = 5,
  variant = "section",
  dividers,
}: {
  title?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  padding?: Spacing
  variant?: "section" | "transparent" | "muted"
  dividers?: Array<"top" | "bottom" | "start" | "end">
}) {
  return (
    <Section variant={variant} padding={padding} dividers={dividers}>
      <VStack gap={4}>
        {title || actions ? (
          <HStack hAlign="between" vAlign="center" gap={3} wrap="wrap">
            {title ? (
              typeof title === "string" ? (
                <Heading level={3}>{title}</Heading>
              ) : (
                title
              )
            ) : null}
            {actions}
          </HStack>
        ) : null}
        {children ?? null}
      </VStack>
    </Section>
  )
}

export interface MetricItem {
  label: string
  value: ReactNode
  hint?: ReactNode
}

export function MetricStrip({ items }: { items: MetricItem[] }) {
  return (
    <Section variant="muted" padding={4}>
      <HStack gap={0} wrap="wrap" vAlign="stretch">
        {items.map((item, index) => (
          <HStack key={item.label} gap={0} vAlign="stretch">
            {index > 0 ? <Divider orientation="vertical" /> : null}
            <VStack gap={0} padding={3}>
              <Text color="secondary" type="supporting">
                {item.label}
              </Text>
              {typeof item.value === "string" || typeof item.value === "number" ? (
                <Heading level={2}>{item.value}</Heading>
              ) : (
                item.value
              )}
              {item.hint ? (
                typeof item.hint === "string" ? (
                  <Text color="secondary" type="supporting">
                    {item.hint}
                  </Text>
                ) : (
                  item.hint
                )
              ) : null}
            </VStack>
          </HStack>
        ))}
      </HStack>
    </Section>
  )
}

export function ChartFrame({ children }: { children: ReactNode }) {
  return (
    <Section height={288} padding={0} variant="transparent">
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </Section>
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

/** @deprecated Use PageFrame. Kept for call sites mid-migration. */
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
      {actions}
    </HStack>
  )
}

/** @deprecated Use MetricStrip. */
export function MetricGrid({ items }: { items: MetricItem[] }) {
  return <MetricStrip items={items} />
}

/** @deprecated Use PageSection. */
export function SectionCard({
  title,
  actions,
  children,
}: {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <PageSection title={title} actions={actions}>
      {children}
    </PageSection>
  )
}

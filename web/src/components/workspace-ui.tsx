import type { ComponentProps, InputHTMLAttributes, ReactNode } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Search01Icon, XIcon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent, CardDescription } from "@/components/ui/card"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { cn } from "@/lib/utils"

export function PageHeader({
  title,
  description,
  accessory,
  actions,
  className,
}: {
  title?: ReactNode
  description?: ReactNode
  accessory?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  if (!title && !description && !accessory && !actions) return null
  return (
    <header
      className={cn(
        "flex min-h-8 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between",
        className
      )}
    >
      {title || description || accessory ? (
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {title ? (
              <h1 className="text-lg font-semibold tracking-tight sm:text-xl">
                {title}
              </h1>
            ) : null}
            {accessory}
          </div>
          {description ? (
            <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
      ) : null}
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:ml-auto">
          {actions}
        </div>
      ) : null}
    </header>
  )
}

export interface StatItem {
  label: ReactNode
  value: ReactNode
  detail?: ReactNode
  icon?: ComponentProps<typeof HugeiconsIcon>["icon"]
  tone?: "default" | "positive" | "warning" | "negative"
}

export function StatStrip({
  items,
  className,
}: {
  items: StatItem[]
  className?: string
}) {
  return (
    <Card size="sm" className={className}>
      <CardContent
        className="grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-4"
        role="list"
        aria-label="统计"
      >
        {items.map((item, index) => (
          <div
            key={index}
            role="listitem"
            className="flex min-w-0 flex-col gap-1"
          >
            <div className="flex items-baseline justify-between gap-2">
              <CardDescription>{item.label}</CardDescription>
              <span
                className={cn(
                  "text-lg font-semibold tabular-nums",
                  item.tone === "negative" && "text-destructive"
                )}
              >
                {item.value}
              </span>
            </div>
            {item.detail ? (
              <p
                className="truncate text-xs text-muted-foreground"
                title={
                  typeof item.detail === "string" ? item.detail : undefined
                }
              >
                {item.detail}
              </p>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

export function SearchField({
  value,
  onClear,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value"> & {
  value: string
  onClear?: () => void
}) {
  return (
    <InputGroup className={className}>
      <InputGroupAddon>
        <HugeiconsIcon strokeWidth={2} icon={Search01Icon} />
      </InputGroupAddon>
      <InputGroupInput
        value={value}
        {...props}
        aria-label={props["aria-label"] ?? props.placeholder ?? "搜索"}
      />
      {value && onClear ? (
        <InputGroupAddon align="inline-end">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClear}
            aria-label="清除搜索"
          >
            <HugeiconsIcon strokeWidth={2} icon={XIcon} />
          </Button>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  )
}

export function InfoBar({
  icon: Icon,
  children,
  className,
}: {
  icon?: ComponentProps<typeof HugeiconsIcon>["icon"]
  children: ReactNode
  className?: string
}) {
  return (
    <Alert className={className}>
      {Icon ? <HugeiconsIcon icon={Icon} strokeWidth={2} /> : null}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}

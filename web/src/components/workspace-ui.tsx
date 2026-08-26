import type { ComponentType, InputHTMLAttributes, ReactNode } from "react"
import { SearchIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { cn } from "@/lib/utils"

export function PageHeader({
  title,
  accessory,
  actions,
  className,
}: {
  title?: ReactNode
  accessory?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  if (!title && !accessory && !actions) return null
  return (
    <header
      className={cn(
        "flex min-h-9 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between",
        className
      )}
    >
      {title || accessory ? (
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {title ? (
              <h1 className="font-heading text-2xl font-semibold tracking-tight">
                {title}
              </h1>
            ) : null}
            {accessory}
          </div>
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
  icon?: ComponentType<{ className?: string }>
  tone?: "default" | "positive" | "warning" | "negative"
}

const statTones = {
  default: "text-foreground",
  positive: "text-positive",
  warning: "text-warning",
  negative: "text-destructive",
}

export function StatStrip({
  items,
  className,
}: {
  items: StatItem[]
  className?: string
}) {
  return (
    <dl
      className={cn(
        "grid grid-cols-2 border-y sm:auto-cols-fr sm:grid-flow-col sm:grid-cols-none",
        className
      )}
    >
      {items.map((item, index) => {
        const Icon = item.icon
        return (
          <div
            key={`${String(item.label)}-${index}`}
            className="min-w-0 border-r px-3 py-2 first:pl-0 last:border-r-0 last:pr-0"
          >
            <dt className="flex items-start justify-between gap-2 text-xs text-muted-foreground">
              <span className="truncate">{item.label}</span>
              {Icon ? (
                <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60" />
              ) : null}
            </dt>
            <dd
              className={cn(
                "mt-0.5 font-heading text-base font-semibold tabular-nums",
                statTones[item.tone ?? "default"]
              )}
            >
              {item.value}
            </dd>
            {item.detail ? (
              <dd className="mt-0.5 truncate text-xs text-muted-foreground">
                {item.detail}
              </dd>
            ) : null}
          </div>
        )
      })}
    </dl>
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
        <SearchIcon />
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
            size="icon-xs"
            onClick={onClear}
            aria-label="清除搜索"
          >
            <XIcon />
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
  icon?: ComponentType<{ className?: string }>
  children: ReactNode
  className?: string
}) {
  return (
    <Alert className={className}>
      {Icon ? <Icon /> : null}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}

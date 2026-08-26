import type { ComponentType, InputHTMLAttributes, ReactNode } from "react"
import { SearchIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
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
        "flex min-h-8 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
        className
      )}
    >
      {title || accessory ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          {title ? (
            <h1 className="font-heading text-xl font-semibold">
              {title}
            </h1>
          ) : null}
          {accessory}
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
  positive: "text-foreground",
  warning: "text-muted-foreground",
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
        "grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-border",
        className
      )}
    >
      {items.map((item, index) => {
        const Icon = item.icon
        return (
          <div
            key={`${String(item.label)}-${index}`}
            className="min-w-0 bg-card px-4 py-3.5"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <dt className="truncate text-xs text-muted-foreground">
                  {item.label}
                </dt>
                <dd
                  className={cn(
                    "mt-1 font-heading text-lg font-semibold tabular-nums",
                    statTones[item.tone ?? "default"]
                  )}
                >
                  {item.value}
                </dd>
              </div>
              {Icon ? (
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground/70" />
              ) : null}
            </div>
            {item.detail ? (
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {item.detail}
              </p>
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
      <InputGroupInput value={value} {...props} />
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
    <div
      className={cn(
        "flex gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm leading-relaxed text-muted-foreground",
        className
      )}
    >
      {Icon ? <Icon className="mt-0.5 size-4 shrink-0" /> : null}
      <div className="min-w-0">{children}</div>
    </div>
  )
}

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
        "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
        className
      )}
    >
      {title || description || accessory ? (
        <div className="min-w-0">
          {title || accessory ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {title ? (
                <h1 className="font-heading text-xl font-semibold tracking-tight">
                  {title}
                </h1>
              ) : null}
              {accessory}
            </div>
          ) : null}
          {description ? (
            <p className="mt-1 max-w-2xl text-xs/relaxed text-muted-foreground">
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
        "grid grid-cols-2 gap-px bg-foreground/10 ring-1 ring-foreground/10 sm:grid-cols-4",
        className
      )}
    >
      {items.map((item, index) => {
        const Icon = item.icon
        return (
          <div
            key={`${String(item.label)}-${index}`}
            className="min-w-0 bg-background px-4 py-3"
          >
            <dt className="flex items-start justify-between gap-2 text-xs text-muted-foreground">
              <span className="truncate">{item.label}</span>
              {Icon ? <Icon className="size-3.5 shrink-0" /> : null}
            </dt>
            <dd
              className={cn(
                "mt-1 font-heading text-lg font-semibold tabular-nums",
                statTones[item.tone ?? "default"]
              )}
            >
              {item.value}
            </dd>
            {item.detail ? (
              <dd className="mt-1 truncate text-xs text-muted-foreground">
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

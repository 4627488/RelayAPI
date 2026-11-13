import type { LucideIcon } from "lucide-react"
import type { InputHTMLAttributes, ReactNode } from "react"
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
        "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
        className
      )}
    >
      {title || description || accessory ? (
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {title ? (
              <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            ) : null}
            {accessory}
          </div>
          {description ? (
            <p className="max-w-2xl text-sm text-muted-foreground">
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
  icon?: LucideIcon
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
    <div
      className={cn(
        "grid grid-cols-1 overflow-hidden rounded-xl border bg-card min-[360px]:grid-cols-2",
        items.length > 2 && "xl:grid-cols-4",
        className
      )}
      role="list"
      aria-label="统计"
    >
      {items.map((item, index) => (
        <div
          key={index}
          role="listitem"
          className="flex min-w-0 flex-col gap-2 bg-card p-4 shadow-[0_0_0_1px_var(--border)]"
        >
          <div className="text-xs font-medium text-muted-foreground">
            {item.label}
          </div>
          <div>
            <span
              className={cn(
                "text-2xl font-semibold tabular-nums",
                item.tone === "negative" && "text-destructive"
              )}
            >
              {item.value}
            </span>
          </div>
          {item.detail ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {item.detail}
            </p>
          ) : null}
        </div>
      ))}
    </div>
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
            size="icon-sm"
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
  icon?: LucideIcon
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

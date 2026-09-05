import type { ComponentType, InputHTMLAttributes, ReactNode } from "react"
import { SearchIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card"
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
        "flex min-h-9 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between",
        className
      )}
    >
      {title || description || accessory ? (
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {title ? (
              <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
                {title}
              </h1>
            ) : null}
            {accessory}
          </div>
          {description ? (
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
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

export function StatStrip({
  items,
  className,
}: {
  items: StatItem[]
  className?: string
}) {
  return (
    <div
      className={cn("grid grid-cols-2 gap-4 lg:grid-cols-4", className)}
      role="list"
      aria-label="统计"
    >
      {items.map((item, index) => {
        const Icon = item.icon
        return (
          <Card
            key={`${String(item.label)}-${index}`}
            className="min-w-0"
            role="listitem"
            size="sm"
          >
            <CardHeader>
              <CardDescription>{item.label}</CardDescription>
              {Icon ? (
                <CardAction>
                  <Icon className="text-muted-foreground" />
                </CardAction>
              ) : null}
            </CardHeader>
            <CardContent>
              <div
                className={cn(
                  "text-xl leading-tight font-semibold break-words tabular-nums sm:text-2xl",
                  item.tone === "negative"
                    ? "text-destructive"
                    : "text-foreground"
                )}
              >
                {item.value}
              </div>
              {item.detail ? (
                <div className="mt-1 text-xs leading-5 break-words text-muted-foreground">
                  {item.detail}
                </div>
              ) : null}
            </CardContent>
          </Card>
        )
      })}
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

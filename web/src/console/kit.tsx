import type { ReactNode } from "react"
import { Banner } from "@cloudflare/kumo/components/banner"
import { Empty } from "@cloudflare/kumo/components/empty"
import { LayerCard } from "@cloudflare/kumo/components/layer-card"
import { Loader } from "@cloudflare/kumo/components/loader"

export function Page({
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
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-kumo-strong">{title}</h1>
          {description ? (
            <p className="mt-1 max-w-2xl text-sm text-kumo-subtle">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        ) : null}
      </header>
      {children}
    </div>
  )
}

export function StatGrid({
  items,
}: {
  items: Array<{ label: string; value: ReactNode; detail?: ReactNode }>
}) {
  return (
    <dl className="grid grid-cols-2 gap-px bg-kumo-hairline ring-1 ring-kumo-hairline sm:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="bg-kumo-base px-4 py-3">
          <dt className="text-xs text-kumo-subtle">{item.label}</dt>
          <dd className="mt-1 text-lg font-semibold text-kumo-strong tabular-nums">
            {item.value}
          </dd>
          {item.detail ? (
            <dd className="mt-1 truncate text-xs text-kumo-subtle">
              {item.detail}
            </dd>
          ) : null}
        </div>
      ))}
    </dl>
  )
}

export function LoadingState({ label = "正在加载" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-kumo-subtle">
      <Loader />
      {label}
    </div>
  )
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string
  onRetry?: () => void
}) {
  return (
    <Banner
      variant="error"
      title="无法继续"
      description={message}
      size="sm"
      action={
        onRetry ? (
          <Banner.Action variant="secondary" onClick={onRetry}>
            重试
          </Banner.Action>
        ) : undefined
      }
    />
  )
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <Empty
      size="sm"
      title={title}
      description={description}
      contents={action}
    />
  )
}

export function Surface({
  title,
  children,
  className,
}: {
  title?: ReactNode
  children: ReactNode
  className?: string
}) {
  if (!title) {
    return <LayerCard className={className}>{children}</LayerCard>
  }
  return (
    <LayerCard className={className}>
      <LayerCard.Secondary>{title}</LayerCard.Secondary>
      <LayerCard.Primary>{children}</LayerCard.Primary>
    </LayerCard>
  )
}

export function DataTable({
  columns,
  rows,
  empty,
}: {
  columns: string[]
  rows: ReactNode[]
  empty?: ReactNode
}) {
  if (rows.length === 0) return empty ?? null
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-kumo-hairline text-xs text-kumo-subtle">
            {columns.map((column) => (
              <th key={column} className="px-3 py-2 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  )
}

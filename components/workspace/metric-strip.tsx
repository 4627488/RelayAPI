import * as React from "react";

import { cn } from "@/lib/utils";

export function MetricStrip({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid overflow-hidden rounded-md border bg-card sm:grid-cols-2 sm:divide-x xl:grid-cols-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function MetricStripItem({
  label,
  value,
  detail,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  detail?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 border-b px-3 py-2.5 last:border-b-0 sm:border-b-0", className)}>
      <div className="truncate text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 truncate font-mono text-xl font-semibold leading-none tracking-tight tabular-nums">
        {value}
      </div>
      {detail && (
        <div className="mt-1 truncate text-xs text-muted-foreground">
          {detail}
        </div>
      )}
    </div>
  );
}

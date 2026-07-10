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
        "grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2 xl:grid-cols-4",
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
    <div className={cn("min-w-0 bg-card px-3 py-2", className)}>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate font-mono text-lg font-semibold leading-none tabular-nums">
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

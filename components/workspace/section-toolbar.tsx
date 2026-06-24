import * as React from "react";

import { cn } from "@/lib/utils";

export function SectionToolbar({
  center,
  children,
  className,
  right,
}: {
  center?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  right?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-card p-2 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {children}
      </div>
      {center && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">{center}</div>
      )}
      {right && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          {right}
        </div>
      )}
    </div>
  );
}

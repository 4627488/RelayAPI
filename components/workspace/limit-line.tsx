"use client";

import { formatNumber } from "@/components/workspace/format";

export function LimitLine({
  hideValue,
  label,
  limit,
  value,
}: {
  label: string;
  value: number;
  limit: number | null;
  hideValue?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="truncate text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-mono font-medium tabular-nums">
        {hideValue ? "上限 " : ""}
        {hideValue ? "" : formatNumber(value)}
        {limit === null ? " / 不限制" : ` / ${formatNumber(limit)}`}
      </span>
    </div>
  );
}

"use client";

import { DashboardSummaryLine } from "@/components/dashboard-chrome";
import { formatNumber } from "@/components/dashboard/format";

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
    <DashboardSummaryLine
      label={label}
      value={
        <>
          {hideValue ? "上限 " : ""}
          {hideValue ? "" : formatNumber(value)}
          {limit === null ? " / 不限制" : ` / ${formatNumber(limit)}`}
        </>
      }
    />
  );
}

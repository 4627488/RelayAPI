"use client";

import { formatNumber } from "@/components/workspace/format";
import { WorkspaceSummaryLine } from "@/components/workspace/workspace-shell";

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
    <WorkspaceSummaryLine
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

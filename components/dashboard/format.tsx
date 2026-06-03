"use client";

import { Badge } from "@/components/ui/badge";

export function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

export function formatTokenNumber(value: number) {
  if (value >= 1_000_000) {
    return `${Math.round(value / 10_000) / 100}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 100) / 10}K`;
  }
  return formatNumber(value);
}

export function formatRatioPercent(part: number, total: number) {
  if (total <= 0) {
    return "0%";
  }
  return `${Math.round((part / total) * 1000) / 10}%`;
}

export function formatDateTime(value: string | null) {
  if (!value) {
    return "未记录";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(date);
}

export function renderBadgeList(values: string[], empty: string) {
  if (values.length === 0) {
    return <span className="text-muted-foreground">{empty}</span>;
  }

  return (
    <span className="inline-flex max-w-full flex-wrap gap-1">
      {values.slice(0, 4).map((value) => (
        <Badge key={value} variant="outline">
          {value}
        </Badge>
      ))}
      {values.length > 4 && (
        <Badge variant="outline">+{values.length - 4}</Badge>
      )}
    </span>
  );
}

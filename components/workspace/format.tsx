import * as React from "react";

import { Badge } from "@/components/ui/badge";
import {
  DEFAULT_TIME_ZONE,
  formatInstant,
  instantToLocalDateTime,
  isValidTimeZone,
  localDateTimeToInstant,
} from "@/src/shared/time";

let displayTimeZone = DEFAULT_TIME_ZONE;

export function setDisplayTimeZone(timeZone: string) {
  if (isValidTimeZone(timeZone)) {
    displayTimeZone = timeZone;
  }
}

export function getDisplayTimeZone() {
  return displayTimeZone;
}

export function formatNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatCompactNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: value >= 1000 ? 1 : 0,
    notation: "compact",
  }).format(value);
}

export function formatTokenNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  const absValue = Math.abs(value);
  if (absValue >= 1_000_000_000) {
    return `${formatScaledNumber(value / 1_000_000_000)}B`;
  }
  if (absValue >= 1_000_000) {
    return `${formatScaledNumber(value / 1_000_000)}M`;
  }
  if (absValue >= 1_000) {
    return `${formatScaledNumber(value / 1_000)}K`;
  }
  return formatNumber(value);
}

export function formatDuration(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 ms";
  }
  if (value < 1000) {
    return `${Math.round(value)} ms`;
  }
  return `${(value / 1000).toFixed(2)} s`;
}

export function formatNullableDuration(value: number | null | undefined) {
  return typeof value === "number" ? formatDuration(value) : "-";
}

export function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "-";
  }
  return `${value.toFixed(1)}%`;
}

export function formatRatioPercent(part: number, total: number) {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) {
    return "0%";
  }
  return `${Math.round((part / total) * 1000) / 10}%`;
}

export function formatDateTime(value: string | null | undefined) {
  return formatInstant(value, displayTimeZone) || "-";
}

export function formatNullableDate(value: string | null | undefined) {
  if (!value) {
    return <span className="text-muted-foreground">-</span>;
  }
  return <time dateTime={value}>{formatDateTime(value)}</time>;
}

export function datetimeLocalToIso(value: string) {
  if (!value.trim()) {
    return null;
  }
  const result = localDateTimeToInstant(value, displayTimeZone);
  return result.ok ? result.value : null;
}

export function toDatetimeLocal(value: string | null) {
  return instantToLocalDateTime(value, displayTimeZone);
}

export function renderBadgeList(values: string[], empty: string) {
  if (values.length === 0) {
    return <span className="text-muted-foreground">{empty}</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {values.map((value) => (
        <Badge key={value} variant="outline">
          {value}
        </Badge>
      ))}
    </div>
  );
}

function formatScaledNumber(value: number) {
  const absValue = Math.abs(value);
  const maximumFractionDigits = absValue >= 100 ? 0 : absValue >= 10 ? 1 : 2;
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value);
}

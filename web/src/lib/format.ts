export function compact(value: number) {
  return new Intl.NumberFormat("zh-CN", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value)
}

export function money(nanoUsd: number | null | undefined) {
  if (nanoUsd == null) return "—"
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(nanoUsd / 1_000_000_000)
}

export function dateTime(value: string | null | undefined) {
  if (!value) return "从未"
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value))
}

export function initials(name?: string) {
  return (name?.trim().slice(0, 2) || "RA").toUpperCase()
}

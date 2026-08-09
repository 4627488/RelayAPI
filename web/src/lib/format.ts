export function compact(value: number) {
  return new Intl.NumberFormat("zh-CN", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value)
}

export function compactTokens(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: value >= 1_000 ? "compact" : "standard",
    compactDisplay: "short",
    maximumFractionDigits: 1,
  }).format(value)
}

export function bytes(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  const amount = value / 1024 ** exponent
  return `${new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: amount >= 10 || exponent === 0 ? 0 : 1,
  }).format(amount)} ${units[exponent]}`
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

export function requestLogSucceeded(statusCode: number, errorCode?: string) {
  return !errorCode && (statusCode === 101 || (statusCode >= 200 && statusCode < 400))
}

export function requestLogStatus(statusCode: number) {
  if (!statusCode) return "中断"
  if (statusCode === 101) return "101 · WS"
  return String(statusCode)
}

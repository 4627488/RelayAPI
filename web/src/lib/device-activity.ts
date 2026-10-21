/** The device API records model activity, not browser presence. */
export function deviceActivity(value: string | null, now: number) {
  if (!value || !Number.isFinite(Date.parse(value))) return "尚未使用"
  const seconds = Math.max(0, Math.floor((now - Date.parse(value)) / 1000))
  if (seconds < 60) return "刚刚使用"
  const units = [
    [365 * 24 * 3600, "年"],
    [30 * 24 * 3600, "个月"],
    [24 * 3600, "天"],
    [3600, "小时"],
    [60, "分钟"],
  ] as const
  const [duration, label] = units.find(([duration]) => seconds >= duration)!
  return `${Math.floor(seconds / duration)} ${label}前使用`
}

export function deviceTimestamp(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "时间未记录"
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

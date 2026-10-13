import type { RequestLog } from "./api"
import { money } from "./format"

export function requestTokenRate(log: RequestLog): number | null {
  if (["connection", "prewarm", "legacy_session"].includes(log.log_unit || ""))
    return null
  if (
    ["missing", "incomplete", "inconsistent", "ambiguous"].includes(
      log.usage_quality || ""
    )
  )
    return null
  const tokens = log.completion_tokens
  const first = log.first_token_ms
  if (
    first == null ||
    !Number.isFinite(first) ||
    first < 0 ||
    !Number.isFinite(log.latency_ms) ||
    log.latency_ms <= first ||
    !Number.isFinite(tokens) ||
    tokens <= 0
  )
    return null
  return (tokens * 1000) / (log.latency_ms - first)
}

export function requestTokenRateLabel(log: RequestLog) {
  const rate = requestTokenRate(log)
  return rate == null
    ? "—"
    : `${rate.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} token/s`
}

export function requestLogCost(log: RequestLog) {
  const amount = money(log.cost_nano_usd)
  return log.cost_nano_usd != null && !log.pricing_complete
    ? `估算 ${amount}`
    : amount
}

export function requestLogTier(log: RequestLog) {
  if (log.log_unit === "prewarm" || log.log_unit === "connection") return null
  const actual = log.response_service_tier?.trim().toLowerCase()
  const requested = log.service_tier?.trim().toLowerCase()
  if (actual === "priority") {
    return {
      label: "Fast",
      title: "上游返回 Priority 档位；费用按此记录的价格规则计算",
    }
  }
  if (requested === "priority" || requested === "fast") {
    return {
      label: "请求 Fast",
      title: actual
        ? `请求 Priority，上游返回 ${actual}；费用按实际档位计算`
        : "请求 Priority，上游未返回实际档位；计价使用请求档位，未确认 Fast",
    }
  }
  return null
}

export function requestLogUsageQuality(log: RequestLog) {
  const labels: Record<string, string> = {
    complete: "完整用量",
    not_generated: "预热，不计费",
    missing: "用量缺失",
    incomplete: "用量不完整",
    inconsistent: "用量不一致",
    unclassified: "用量未分类",
    ambiguous: "用量关联不唯一",
  }
  return labels[log.usage_quality || ""] || log.usage_quality || "未记录"
}

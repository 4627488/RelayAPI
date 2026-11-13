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
  if (
    !Number.isFinite(log.decode_ms) ||
    !Number.isFinite(log.decode_out) ||
    !log.decode_ms ||
    !log.decode_out ||
    log.decode_ms <= 0 ||
    log.decode_out <= 0 ||
    log.canceled
  )
    return null
  return (log.decode_out * 1000) / log.decode_ms
}

export function requestTokenRateLabel(log: RequestLog) {
  const rate = requestTokenRate(log)
  return rate == null
    ? "—"
    : `${rate.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} token/s`
}

export function requestLogCost(log: RequestLog) {
  return log.pricing_complete && log.settled ? money(log.cost_nano_usd) : "—"
}

// Mirror the server's disjoint billing buckets. Input excludes cache traffic;
// reasoning is already included in output and never forms a second charge.
export function requestLogCostRows(
  log: RequestLog
): [string, number, number][] {
  if (!log.pricing_complete || !log.price_model) return []
  const cachedImage = Math.min(
    Math.max(0, log.cached_image_input_tokens ?? 0),
    Math.max(0, log.image_input_tokens ?? 0),
    Math.max(0, log.cache_read)
  )
  const imageInput = Math.min(
    Math.max(0, (log.image_input_tokens ?? 0) - cachedImage),
    Math.max(0, log.input)
  )
  const imageOutput = Math.min(
    Math.max(0, log.image_output_tokens ?? 0),
    Math.max(0, log.output)
  )
  const hour = Math.min(
    Math.max(0, log.cache_write_1h ?? 0),
    Math.max(0, log.cache_write)
  )
  const rows: [string, number, number][] = [
    [
      "文本输入（未缓存）",
      Math.max(0, log.input - imageInput),
      log.input_price_nano_usd_per_token ?? 0,
    ],
    [
      "文本缓存读取",
      Math.max(0, log.cache_read - cachedImage),
      log.cached_input_price_nano_usd_per_token ?? 0,
    ],
    [
      "图片输入（未缓存）",
      imageInput,
      log.image_input_price_nano_usd_per_token ?? 0,
    ],
    [
      "图片缓存读取",
      cachedImage,
      log.cached_image_input_price_nano_usd_per_token ?? 0,
    ],
    [
      "缓存写入",
      Math.max(0, log.cache_write - hour),
      log.cache_write_price_nano_usd_per_token ?? 0,
    ],
    [
      "缓存写入（1 小时）",
      hour,
      log.cache_write_1h_nano_usd_per_token ||
        log.cache_write_price_nano_usd_per_token ||
        0,
    ],
    [
      "文本输出（含推理）",
      Math.max(0, log.output - imageOutput),
      log.output_price_nano_usd_per_token ?? 0,
    ],
    ["图片输出", imageOutput, log.image_output_price_nano_usd_per_token ?? 0],
  ]
  return rows.filter(([, tokens]) => tokens > 0)
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

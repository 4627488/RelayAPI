import { Token } from "@astryxdesign/core/Token"
import { cacheHitRate, cacheHitRateLabel } from "@/lib/format"

export function CacheHitRateBadge({
  cachedTokens,
  promptTokens,
}: {
  cachedTokens: number
  promptTokens: number
}) {
  const rate = cacheHitRate(cachedTokens, promptTokens)
  const label = cacheHitRateLabel(cachedTokens, promptTokens)
  const low = promptTokens > 40_000 && rate != null && rate < 0.7
  return (
    <Token
      label={low ? `低缓存 ${label}` : `缓存 ${label}`}
      color={low ? "red" : "gray"}
    />
  )
}

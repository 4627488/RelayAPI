import { Badge } from "@/components/ui/badge"
import { cacheHitRate } from "@/lib/format"

const lowCacheHitRate = 0.7
const highPromptTokenThreshold = 40_000

export function CacheHitRateBadge({
  cachedTokens,
  promptTokens,
}: {
  cachedTokens: number
  promptTokens: number
}) {
  const rate = cacheHitRate(cachedTokens, promptTokens)
  const low =
    rate != null &&
    rate < lowCacheHitRate &&
    promptTokens > highPromptTokenThreshold
  const label =
    rate == null
      ? "缓存 —"
      : `${low ? "低缓存" : "缓存"} ${(rate * 100).toFixed(1)}%`

  return (
    <Badge
      variant={low ? "destructive" : "outline"}
      title={
        low
          ? "输入超过 40k Token，缓存命中率低于 70%"
          : "缓存读取 Token 占输入 Token 的比例"
      }
    >
      {label}
    </Badge>
  )
}

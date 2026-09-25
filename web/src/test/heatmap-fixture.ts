import type { TokenHeatmapReport } from "@/components/user/token-heatmap"

export function heatmapFixture(): TokenHeatmapReport {
  const models = [
    { name: "gpt-5.6-sol", tokens: 0, color: "#1b9e77" },
    { name: "claude-sonnet-4.6", tokens: 0, color: "#d95f02" },
    { name: "grok-4.6", tokens: 0, color: "#7570b3" },
  ]
  const days = Array.from({ length: 365 }, (_, i) => {
    const date = new Date(Date.UTC(2025, 8, 27 + i)).toISOString().slice(0, 10)
    const active = i % 11 !== 0 && i % 7 !== 0 && i > 20
    const model = models[i % 9 < 6 ? 0 : i % 9 < 8 ? 1 : 2]
    const tokens = active ? (((i * 137) % 31) + 1) * 4721 : 0
    model.tokens += tokens
    return {
      date,
      tokens,
      model: active ? model.name : "",
      level: active ? (i % 4) + 1 : 0,
      color: active ? model.color : "",
    }
  })
  return {
    start: days[0].date,
    end: days[364].date,
    timezone: "UTC",
    total_tokens: days.reduce((n, d) => n + d.tokens, 0),
    active_days: days.filter((d) => d.tokens > 0).length,
    peak_tokens: Math.max(...days.map((d) => d.tokens)),
    days,
    models,
    share_path: "",
  }
}

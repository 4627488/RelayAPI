import type { ParentSubscription } from "@/lib/api"

export function defaultSubscriptionName(
  parent: Pick<ParentSubscription, "provider" | "plan_type" | "capacity_mode">,
  allocationPPM: number
) {
  const provider = parent.provider.trim().toLowerCase()
  const plan = (parent.plan_type ?? "").trim().toLowerCase()
  let product = "共享订阅"
  if (["codex", "openai", "chatgpt"].includes(provider)) {
    product = `ChatGPT${plan === "pro" ? " Pro" : plan === "plus" ? " Plus" : ""}`
  } else if (["xai", "grok"].includes(provider)) {
    product = `Grok${plan.includes("heavy") ? " SuperHeavy" : ""}`
  } else if (["claude", "anthropic"].includes(provider)) {
    product = `Claude${plan === "pro" ? " Pro" : plan === "max" ? " Max" : plan === "team" ? " Team" : ""}`
  } else {
    product =
      (
        {
          antigravity: "Antigravity",
          "aliyun-bailian": "阿里云百炼",
          kimi: "Kimi",
        } as Record<string, string>
      )[provider] ?? product
  }
  if (parent.capacity_mode === "unmetered") return `${product} 余额付费`
  if (!Number.isSafeInteger(allocationPPM) || allocationPPM <= 0) return product
  if (product === "ChatGPT Pro" || ["claude", "anthropic"].includes(provider)) {
    const divisor = product === "ChatGPT Pro" ? 50000 : 200000
    return `${product} ${Number((allocationPPM / divisor).toFixed(6))}X`
  }
  let a = allocationPPM,
    b = 1000000
  while (b) {
    const remainder = a % b
    a = b
    b = remainder
  }
  return `${product} ${allocationPPM / a}/${1000000 / a}`
}

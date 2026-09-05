import type { ProviderAccount } from "@/lib/api"
import { dateTime } from "@/lib/format"

export const oauthProviders = [
  { value: "codex", label: "OpenAI Codex", detail: "ChatGPT / Codex 订阅账户" },
  { value: "kimi", label: "Kimi", detail: "使用设备码连接" },
  { value: "xai", label: "xAI", detail: "使用设备码连接" },
]

export const apiKeyProviders = [
  { value: "openai", label: "OpenAI" },
  { value: "aliyun-bailian", label: "阿里云百炼" },
  { value: "openai-compatibility", label: "OpenAI 兼容接口" },
  { value: "codex", label: "Codex API Key" },
  { value: "xai", label: "xAI" },
]

export const importProviders = [
  ...new Set([...apiKeyProviders.map((item) => item.value), "kimi"]),
]

export type OAuthStart = {
  status: string
  url: string
  state: string
  flow: "callback" | "device"
  user_code?: string
  expires_in?: number
}
export type OAuthStatus = {
  status: "waiting" | "authorized" | "error"
  provider?: string
  email?: string
  suggested_name?: string
  error?: string
}
export type ConnectMode = "oauth" | "api_key" | "import"
export type ProviderAccountUpdate = {
  name: string
  models?: string[]
  base_url?: string
  websockets?: boolean
  proxy_id: string
  api_key?: string
  headers?: Record<string, string>
  document?: Record<string, unknown>
}

export function displayName(account: ProviderAccount) {
  return account.label || account.email || account.name
}
export function providerLabel(provider: string) {
  return (
    [...oauthProviders, ...apiKeyProviders].find(
      (item) => item.value === provider
    )?.label ?? provider
  )
}
export function sourceLabel(account: ProviderAccount) {
  if (account.auth_kind === "oauth" || account.source === "oauth")
    return "OAuth"
  if (account.auth_kind === "api_key" || account.source === "api_key")
    return "API Key"
  return "导入"
}

export function isOAuthAccount(account: ProviderAccount) {
  return account.auth_kind === "oauth" || account.source === "oauth"
}

export function accountKey(account: ProviderAccount) {
  return account.id || account.name
}

export function accountStatus(account: ProviderAccount) {
  if (account.disabled)
    return { label: "已停用", variant: "secondary" as const }
  if (account.unavailable) {
    if (account.quota_exceeded) {
      return { label: "额度冷却", variant: "destructive" as const }
    }
    if (account.status === "cooldown") {
      return { label: "故障冷却", variant: "destructive" as const }
    }
    return { label: "暂不可用", variant: "secondary" as const }
  }
  if (!account.models?.length)
    return { label: "未发布模型", variant: "secondary" as const }
  return { label: "可调度", variant: "outline" as const }
}

export function publishedModels(account: ProviderAccount) {
  return account.models ?? []
}

export function modelSummary(account: ProviderAccount) {
  const models = publishedModels(account)
  if (!models.length) return { primary: "未发布", extra: "" }
  if (models.length === 1) return { primary: models[0], extra: "" }
  return { primary: models[0], extra: `另 ${models.length - 1} 个` }
}

export function quotaSummary(account: ProviderAccount) {
  if (account.quota_exceeded) {
    return account.quota_recover_at
      ? `${dateTime(account.quota_recover_at)} 后可重试`
      : "上游已限流"
  }
  const snapshot = account.quota_snapshot
  const windows =
    snapshot && "windows" in snapshot && Array.isArray(snapshot.windows)
      ? snapshot.windows
      : []
  const window = windows.find((item) => typeof item.used_percent === "number")
  if (window && typeof window.used_percent === "number") {
    const label = window.label || window.kind || "额度"
    return `${label} ${Math.round(window.used_percent)}%`
  }
  if (account.quota_probe_status === "unsupported") return "上游无自动额度"
  if (account.quota_probe_status === "error") {
    return account.quota_probe_error || "额度探测失败"
  }
  return "尚未探测"
}

export function normalizedOAuthProvider(provider: string) {
  const value = provider.trim().toLowerCase()
  if (value === "openai") return "codex"
  if (value === "grok" || value === "x.ai") return "xai"
  return value
}

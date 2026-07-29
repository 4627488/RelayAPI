export type Role = "admin" | "tenant"

export interface User {
  id: string
  name: string
  owner_email: string
  enabled: boolean
  balance_nano_usd: number
  rate_limit_per_minute: number | null
  token_limit_daily: number | null
  model_allowlist: string[]
  created_at: string
  last_used_at?: string
}

export interface Session {
  role: Role
  tenant?: User
}

export interface ApiKey {
  id: string
  name: string
  prefix: string
  enabled: boolean
  rate_limit_per_minute: number | null
  token_limit_daily: number | null
  model_allowlist: string[]
  last_used_at: string | null
  created_at: string
}

export interface Invitation {
  id: string
  email?: string
  expires_at: string
  used_at?: string
  used_by_user_id?: string
  revoked_at?: string
  created_at: string
}

export interface RequestLog {
  id: string
  tenant_id: string
  model: string
  method: string
  path: string
  status_code: number
  stream: boolean
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cost_nano_usd: number | null
  latency_ms: number
  error_message?: string
  started_at: string
}

export interface UsageReport {
  days: number
  user_id: string
  summary: {
    requests: number
    errors: number
    tokens: number
    cost_nano_usd: number
  }
  daily: Array<{
    date: string
    requests: number
    errors: number
    tokens: number
    cost_nano_usd: number
  }>
  models: Array<{
    model: string
    requests: number
    tokens: number
    cost_nano_usd: number
  }>
}

export interface AdminOverview {
  users: number
  enabled_users: number
  active_api_keys: number
  pending_invitations: number
  today: {
    requests: number
    tokens: number
    cost_nano_usd: number
    errors: number
  }
}

export interface ProviderAccount {
  id: string
  auth_index?: string
  name: string
  provider: string
  type?: string
  email?: string
  label?: string
  status?: string
  status_message?: string
  disabled: boolean
  unavailable?: boolean
  success?: number
  failed?: number
}

type ApiErrorBody = {
  error?: { code?: string; message?: string } | string
  message?: string
  status?: string
}

export type CapacityMode = "unmetered" | "manual" | "observed"

export interface ParentQuotaWindow {
  parent_subscription_id: string
  kind: string
  limit_nano_usd: number
  resets_at: string
  source: string
  observed_used_percent?: number | null
}

export interface ParentSubscription {
  id: string
  cpa_auth_id: string
  cpa_auth_index: string
  cpa_auth_name: string
  name: string
  provider: string
  plan_type: string
  status: string
  cpa_unavailable: boolean
  capacity_mode: CapacityMode
  allocation_limit_ppm: number
  enabled: boolean
  cpa_model_allowlist: string[]
  model_allowlist: string[]
  last_synced_at?: string | null
  quota_supported: boolean
  quota_probe_status: "unknown" | "supported" | "unsupported" | "error"
  quota_probe_error?: string
  quota_observed_at?: string | null
  created_at: string
  updated_at: string
}

export interface ParentSubscriptionView {
  item: ParentSubscription
  windows: ParentQuotaWindow[]
  allocated_ppm: number
}

export interface ChildQuotaWindow {
  child_subscription_id: string
  kind: string
  started_at: string
  resets_at: string
  limit_nano_usd: number
  settled_nano_usd: number
  reserved_nano_usd: number
}

export interface ChildSubscription {
  id: string
  tenant_id: string
  parent_subscription_id: string
  name: string
  allocation_ppm: number
  priority: number
  enabled: boolean
  capacity_mode?: CapacityMode
  model_allowlist: string[]
  starts_at: string
  expires_at?: string | null
  created_at?: string
  updated_at?: string
  windows?: ChildQuotaWindow[]
}

export class ApiError extends Error {
  status: number
  code?: string

  constructor(status: number, body: ApiErrorBody) {
    const nestedError = typeof body.error === "object" ? body.error : undefined
    const message = nestedError?.message
      ?? (typeof body.error === "string" ? body.error : undefined)
      ?? body.message
      ?? `请求失败 (${status})`
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = nestedError?.code
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "include",
  })
  if (response.status === 204) {
    return undefined as T
  }
  const body = (await response.json().catch(() => ({}))) as T & ApiErrorBody
  if (!response.ok) {
    throw new ApiError(response.status, body)
  }
  return body
}

export const postJSON = <T>(path: string, value: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(value) })

export const deleteRequest = (path: string) => api<void>(path, { method: "DELETE" })

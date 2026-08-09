export type Role = "tenant"

export interface User {
  id: string
  name: string
  owner_email: string
  enabled: boolean
  is_admin: boolean
  must_change_password: boolean
  balance_nano_usd: number
  rate_limit_per_minute: number | null
  token_limit_daily: number | null
  model_allowlist: string[]
  created_at: string
  last_used_at?: string
}

export interface Session {
  role: Role
  is_admin: boolean
  tenant: User
}

export interface AuthStatus {
  setup_required: boolean
}

export interface ApiKey {
  id: string
  name: string
  prefix: string
  recoverable: boolean
  enabled: boolean
  rate_limit_per_minute: number | null
  token_limit_daily: number | null
  model_allowlist: string[]
  model_aliases: ApiKeyModelAlias[]
  last_used_at: string | null
  created_at: string
}

export interface ApiKeyModelAlias {
  id?: string
  alias: string
  model: string
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
  requested_model: string
  actual_model: string
  model_alias?: string
  provider?: string
  executor_type?: string
  auth_type?: string
  auth_index?: string
  cpa_request_id?: string
  cpa_trace_id?: string
  cpa_execution_id?: string
  tenant_name?: string
  api_key_name?: string
  api_key_prefix?: string
  parent_subscription_name?: string
  child_subscription_name?: string
  channel_id?: string
  channel_name?: string
  credential_id?: string
  credential_name?: string
  credential_email?: string
  request_type?: string
  method: string
  path: string
  status_code: number
  stream: boolean
  request_body_bytes: number
  forwarded_body_bytes: number
  response_body_bytes: number
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  total_tokens: number
  cost_nano_usd: number | null
  price_model?: string
  price_source?: string
  price_version?: string
  input_price_nano_usd_per_token?: number
  output_price_nano_usd_per_token?: number
  cached_input_price_nano_usd_per_token?: number
  cache_write_price_nano_usd_per_token?: number
  reasoning_price_nano_usd_per_token?: number
  price_multiplier?: number
  pricing_complete: boolean
  settled: boolean
  reserved_nano_usd: number
  latency_ms: number
  ttft_ms?: number
  error_code?: string
  error_message?: string
  started_at: string
  completed_at: string
}

export interface RequestLogDetail {
  request_log_id: string
  request_headers: string
  request_body: string
  request_body_truncated: boolean
  request_body_bytes: number
  forwarded_headers: string
  forwarded_body: string
  forwarded_body_truncated: boolean
  forwarded_body_bytes: number
  upstream_status: number
  upstream_headers: string
  upstream_body: string
  upstream_body_truncated: boolean
  upstream_body_bytes: number
  error_name?: string
  error_message?: string
  error_stack?: string
  error_cause?: string
  error_detail?: string
  stage_timings: string
}

export interface RequestLogPage {
  items: RequestLog[]
  page: number
  page_size: number
  total: number
  summary: {
    requests: number
    errors: number
    tokens: number
    cached_tokens: number
    cost_nano_usd: number
    average_latency_ms: number
    request_bytes: number
    response_bytes: number
  }
}

export interface ModelPrice {
  model: string
  input_nano_usd_per_token: number
  output_nano_usd_per_token: number
  cached_input_nano_usd_per_token: number
  cache_write_nano_usd_per_token: number
  reasoning_nano_usd_per_token: number
  source: string
  version: string
  price_multiplier: number
  updated_at?: string
}

export interface ModelAlias {
  alias: string
  model: string
}

export interface ModelPriceRule {
  id?: string
  model: string
  field: string
  value: string
  multiplier: number
}

export interface UsageReport {
  days: number
  user_id: string
  summary: {
    requests: number
    errors: number
    tokens: number
    cost_nano_usd: number
    subscription_covered_nano_usd: number
    balance_charged_nano_usd: number
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
  api_keys: Array<{
    api_key_id: string
    api_key_name: string
    api_key_prefix: string
    tenant_name?: string
    requests: number
    errors: number
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
  auth_kind?: "oauth" | "api_key"
  disabled: boolean
  unavailable?: boolean
  success?: number
  failed?: number
  source?: "oauth" | "api_key" | "import" | "config" | "native"
  config_path?: string
  config_index?: number
  base_url?: string
  prefix?: string
  models?: string[]
  key_count?: number
  can_inspect?: boolean
  can_toggle?: boolean
  can_delete?: boolean
  proxy_configured?: boolean
  revision?: number
}

type ApiErrorBody = {
  error?: { code?: string; message?: string } | string
  message?: string
  status?: string
}

export type CapacityMode = "unmetered" | "observed"

export interface UpstreamQuotaWindow {
  kind: string
  label?: string
  used_percent?: number | null
  remaining_percent?: number | null
  resets_at?: string | null
  enforceable: boolean
  unit?: string
  limit?: number | null
  remaining?: number | null
}

export interface UpstreamQuotaReport {
  auth_index?: string
  provider?: string
  plan_type?: string
  supported: boolean
  source?: string
  observed_at?: string
  windows: UpstreamQuotaWindow[]
}

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
  quota_snapshot?: UpstreamQuotaReport | Record<string, never>
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

export interface SubscriptionEntitlementWindow {
  kind: string
  allocation_ppm: number
  parent_limit_nano_usd: number
  limit_nano_usd: number
  settled_nano_usd: number
  reserved_nano_usd: number
  remaining_nano_usd: number
  upstream_used_percent?: number | null
  resets_at: string
  source: string
  observed_at?: string | null
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
  effective_model_allowlist?: string[]
  model_source?: "child" | "parent" | "cpa"
  parent_name?: string
  parent_plan_type?: string
  entitlement_windows?: SubscriptionEntitlementWindow[]
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
    const message =
      nestedError?.message ??
      (typeof body.error === "string" ? body.error : undefined) ??
      body.message ??
      `请求失败 (${status})`
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

export const deleteRequest = (path: string) =>
  api<void>(path, { method: "DELETE" })

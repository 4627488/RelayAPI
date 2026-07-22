import type {
  AdminOverviewStats,
  ChannelRecord,
  CodexUpstreamTransport,
  CreatedApiKey,
  PublicApiKey,
  CodexCredentialRecord,
  CredentialProxyType,
  GlobalSettingsRecord,
  JsonValue,
  ProxyPoolRecord,
  PublicTenant,
  CreatedTenantInvite,
} from "@/src/shared/types/entities";

export type AdminListResponse<T> = {
  object: "list";
  data: T[];
};

export type AdminDeleteResponse = {
  id: string;
  deleted: true;
};

export type AdminApiErrorBody = {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
  message?: string;
};

export class AdminApiError extends Error {
  status: number;
  code: string;
  details: unknown;

  constructor(input: {
    status: number;
    code: string;
    message: string;
    details?: unknown;
  }) {
    super(input.message);
    this.name = "AdminApiError";
    this.status = input.status;
    this.code = input.code;
    this.details = input.details;
  }
}

export type AdminDashboardRequestLogRow = {
  id: string;
  started_at: string;
  method: string;
  path: string;
  request_type: string;
  stream: number;
  model: string;
  status_code: number;
  latency_ms: number;
  first_token_latency_ms: number | null;
  tenant_id: string | null;
  tenant_name: string | null;
  api_key_prefix: string | null;
  api_key_name: string | null;
  channel_name: string | null;
  credential_email: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_nano_usd: string | null;
  price_model: string | null;
  price_version: string | null;
  pricing: ModelPricingSnapshot | null;
  pricing_complete: boolean;
  cache_hit_rate: number;
  error_code: string | null;
};

export type RequestLogDetail = {
  log: AdminDashboardRequestLogRow & {
    completed_at: string;
    error_message: string | null;
  };
  detail: {
    request_headers: Record<string, string> | null;
    request_body_text: string | null;
    request_body_truncated: boolean;
    request_body_bytes: number;
    forwarded_body_text: string | null;
    forwarded_body_truncated: boolean;
    forwarded_body_bytes: number;
    upstream_status_code: number | null;
    upstream_headers: Record<string, string> | null;
    upstream_body_text: string | null;
    upstream_body_truncated: boolean;
    upstream_body_bytes: number;
    error_name: string | null;
    error_message: string | null;
    error_stack: string | null;
    error_cause: unknown;
    detail: unknown;
    stage_timings: Array<{
      name: string;
      label: string;
      kind?: "period" | "point";
      startedAtMs: number;
      endedAtMs: number;
      durationMs: number;
    }>;
    created_at: string | null;
    updated_at: string | null;
  } | null;
};

export type RequestLogStatusFilter = "all" | "success" | "error" | "stream";

export type RequestLogFilters = {
  limit?: number;
  page?: number;
  query?: string;
  status?: RequestLogStatusFilter;
  method?: string;
  model?: string;
  from?: string;
  to?: string;
  minLatencyMs?: number;
};

export type RequestLogsPage = {
  object: "list";
  data: AdminDashboardRequestLogRow[];
  limit: number;
  page: number;
  offset: number;
  total: number;
  totalPages: number;
  summary: {
    errorCount: number;
    totalTokens: number;
    cachedTokens: number;
    cacheHitRate: number;
    avgLatencyMs: number;
  };
};

export type ApiKeyPayload = {
  name?: string;
  scopes?: string[];
  modelAllowlist?: string[];
  channelAllowlist?: string[];
  enabled?: boolean;
  tokenLimitDaily?: number | null;
  rateLimitPerMinute?: number | null;
  expiresAt?: string | null;
};

export type ApiKeyTransferResponse = {
  apiKey: PublicApiKey;
  tenant: PublicTenant;
  migrated: {
    requestLogs: number;
    usageRecords: number;
    usageDailyBuckets: number;
  };
};

export type CredentialProxyPayload =
  | null
  | string
  | {
      enabled?: boolean;
      type?: CredentialProxyType;
      url?: string;
      host?: string;
      port?: number;
      username?: string;
      password?: string;
    };

export type ProxyPoolPayload = {
  name?: string;
  enabled?: boolean;
  type?: CredentialProxyType;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  notes?: string;
};

export type ChannelPayload = {
  provider?: "codex" | "grok";
  name?: string;
  baseUrl?: string;
  credentialId?: string;
  credentialIds?: string[];
  enabled?: boolean;
  priority?: number;
  weight?: number;
  modelAllowlist?: string[];
  status?: ChannelRecord["status"];
  healthScore?: number;
  cooldownUntil?: string | null;
};

export type OAuthStartResponse = {
  state: string;
  redirectUri: string;
  authUrl: string;
};

export type CodexQuotaStatus =
  | "unknown"
  | "exhausted"
  | "low"
  | "medium"
  | "high"
  | "full"
  | "not_cached";

export type CodexQuotaWindow = {
  id: string;
  label: string;
  used_percent: number | null;
  remaining_percent: number | null;
  reset_label: string;
  exhausted: boolean;
};

export type CodexQuotaReport = {
  provider: "codex";
  credential_id: string;
  account_id: string;
  email: string;
  plan_type: string;
  status: CodexQuotaStatus;
  windows: CodexQuotaWindow[];
  additional_windows: CodexQuotaWindow[];
  retrieved_at: string;
  cached: boolean;
  cache_state: "cached" | "fresh" | "missing";
  message?: string;
  raw?: unknown;
};

export type CodexResetCredit = {
  id: string;
  available: boolean;
  expires_at: string | null;
  raw?: unknown;
};

export type CodexResetCreditsReport = {
  provider: "codex";
  credential_id: string;
  account_id: string;
  email: string;
  plan_type: string;
  available_count: number;
  credits: CodexResetCredit[];
  retrieved_at: string;
  raw?: unknown;
};

export type CodexResetCreditConsumeReport = {
  provider: "codex";
  credential_id: string;
  account_id: string;
  email: string;
  plan_type: string;
  credit_id: string;
  redeem_request_id: string;
  code: string;
  windows_reset: number | null;
  consumed_at: string;
  raw?: unknown;
};

export type PruneRequestLogsResponse = {
  summaryRetentionDays: number;
  detailRetentionDays: number;
  summaryCutoff: string;
  detailCutoff: string;
  deletedRequestLogDetails: number;
  deletedRequestLogs: number;
  deletedUsageRecords: number;
  deletedUsageDailyBuckets: number;
  deletedChannelHealthEvents: number;
  vacuumed: boolean;
};

export type AdminDashboardSnapshot = {
  apiKeys: PublicApiKey[];
  tenants: PublicTenant[];
  channels: ChannelRecord[];
  credentials: CodexCredentialRecord[];
  proxyPool: ProxyPoolRecord[];
  globalSettings: GlobalSettingsRecord;
  requestLogs: AdminDashboardRequestLogRow[];
  overviewStats: AdminOverviewStats;
  generatedAt: number;
};

export const WEB_AUTH_EXPIRED_EVENT = "relayapi:web-auth-expired";

let webAuthExpiredNotified = false;

type RequestJson = JsonValue | Record<string, unknown> | unknown[];

type AdminRequestInit = Omit<RequestInit, "body"> & {
  body?: RequestJson;
};

export async function adminRequest<T>(
  url: string,
  init: AdminRequestInit = {},
): Promise<T> {
  const { body, headers, ...rest } = init;
  const response = await fetch(url, {
    ...rest,
    credentials: rest.credentials ?? "same-origin",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const parsed = await parseResponseBody(response);
  if (!response.ok) {
    const error = toAdminApiError(response, parsed);
    notifyWebAuthExpired(error);
    throw error;
  }
  return parsed as T;
}

export async function listApiKeys() {
  const result = await adminRequest<AdminListResponse<PublicApiKey>>(
    "/api/admin/api-keys",
  );
  return result.data;
}

export function createApiKey(payload: ApiKeyPayload = {}) {
  return adminRequest<CreatedApiKey>("/api/admin/api-keys", {
    method: "POST",
    body: payload,
  });
}

export function updateApiKey(id: string, payload: ApiKeyPayload) {
  return adminRequest<PublicApiKey>(`/api/admin/api-keys/${encodePath(id)}`, {
    method: "PATCH",
    body: payload,
  });
}

export function deleteApiKey(id: string) {
  return adminRequest<AdminDeleteResponse>(
    `/api/admin/api-keys/${encodePath(id)}`,
    { method: "DELETE" },
  );
}

export function transferApiKeyToTenant(id: string, tenantId: string) {
  return adminRequest<ApiKeyTransferResponse>(
    `/api/admin/api-keys/${encodePath(id)}/transfer`,
    {
      method: "POST",
      body: { tenantId },
    },
  );
}

export type TenantPayload = {
  name?: string;
  ownerEmail?: string;
  enabled?: boolean;
  maxApiKeys?: number | null;
  tokenLimitDaily?: number | null;
  rateLimitPerMinute?: number | null;
  modelAllowlist?: string[];
  channelAllowlist?: string[];
  allowCustomProxy?: boolean;
  allowCustomUserAgent?: boolean;
  proxy?: CredentialProxyPayload;
  userAgent?: string | null;
  expiresAt?: string | null;
};

export type TenantSubscriptionRecord = {
  id: string; tenantId: string; tenantUserId: string | null; credentialId: string; name: string;
  units: number; unitsPerCredential: number; enabled: boolean; priority: number;
  allocatedPoolUnits?: number;
  startsAt: string; expiresAt: string | null; createdAt: string; updatedAt: string;
  quota?: Partial<Record<"5h" | "7d", {
    limitNanoUsd: string; settledNanoUsd: string; reservedNanoUsd: string; resetsAt: string;
  }>>;
  tenant?: { id: string; name: string; enabled: boolean; ownerEmail: string | null } | null;
  user?: { id: string; email: string; displayName: string } | null;
  lifecycle?: "active" | "disabled" | "scheduled" | "expired";
};

export type SubscriptionCapacityPool = {
  id: string; provider: "codex" | "grok"; email: string; accountId: string; planType: string; enabled: boolean;
  expiresAt: string | null; cooldownUntil: string | null; lastError: string | null;
  capacityUnits: number; allocatedUnits: number;
  allocationCount: number; activeAllocationCount: number;
  quotaEstimates: Record<"5h" | "7d", { automaticNanoUsd: string | null; overrideNanoUsd: string | null; effectiveNanoUsd: string | null; confidence: number; sampleCount: number }>;
  subscriptions: TenantSubscriptionRecord[];
};

export type SubscriptionAllocationOverview = {
  generatedAt: string;
  summary: { credentialCount: number; usableCredentialCount: number; capacityUnits: number; allocatedUnits: number; oversoldCredentialCount: number };
  pools: SubscriptionCapacityPool[];
};

export type TenantSubscriptionPayload = {
  tenantId?: string; credentialId?: string; name?: string; units?: number;
  unitsPerCredential?: number; enabled?: boolean; priority?: number;
  startsAt?: string; expiresAt?: string | null;
};
export type SubscriptionCalibrationTask = { subscriptionId: string; status: "idle" | "pending" | "running" | "completed" | "failed"; startedAt: string | null; completedAt: string | null; error: string | null; windows?: Record<"5h" | "7d", { startedAt: string; costNanoUsd: string; requestCount: number }> };
export function startSubscriptionCalibration(id: string) { return adminRequest<SubscriptionCalibrationTask>(`/api/admin/subscriptions/${encodePath(id)}/calibration`, { method: "POST" }); }
export function getSubscriptionCalibration(id: string) { return adminRequest<SubscriptionCalibrationTask>(`/api/admin/subscriptions/${encodePath(id)}/calibration`); }

export type ModelPricingSnapshot = {
  inputNanoUsdPerToken: string;
  outputNanoUsdPerToken: string;
  cachedInputNanoUsdPerToken: string;
  cacheWriteNanoUsdPerToken: string;
  reasoningNanoUsdPerToken: string;
};

export type QuotaAdministration = {
  baselines: Record<"5h" | "7d", {
    automaticNanoUsd: string | null;
    overrideNanoUsd: string | null;
    effectiveNanoUsd: string | null;
    confidence: number;
    sampleCount: number;
    oversellRatio: number;
  }>;
  pricing: {
    aliases: Record<string, string>;
    overrides: Array<Record<string, string>>;
    catalogModelCount: number;
    catalogVersion: string | null;
    catalogUpdatedAt: string | null;
    catalogError: string | null;
    pendingModels: Array<{ model: string; requestCount: number; latestStartedAt: string }>;
    backfill: { status: "idle" | "pending" | "running" | "completed" | "failed"; updatedRequests: number; startedAt: string | null; completedAt: string | null; error: string | null };
  };
};

export type CredentialQuotaResetEvent = {
  id: string;
  credentialId?: string;
  windowKind: "5h" | "7d" | "all";
  source: "natural" | "reset_credit";
  previousResetsAt: string | null;
  nextResetsAt: string | null;
  previousUsedPercent: number | null;
  windowsReset: number | null;
  occurredAt: string;
};

export type CredentialQuotaResetHistory = {
  credential: { id: string; email: string; accountId: string; planType: string };
  events: CredentialQuotaResetEvent[];
};

export function getQuotaAdministration() {
  return adminRequest<QuotaAdministration>("/api/admin/quota");
}

export function updateQuotaAdministration(payload: Record<string, unknown>) {
  return adminRequest<QuotaAdministration>("/api/admin/quota", {
    method: "PATCH",
    body: payload,
  });
}

export function refreshQuotaPricing() {
  return adminRequest<QuotaAdministration>("/api/admin/quota/pricing/refresh", {
    method: "POST",
  });
}

export type CostAnalysis = {
  totalCostNanoUsd: string;
  pricedRequests: number;
  models: Array<{
    model: string;
    costNanoUsd: string;
    requestCount: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    reasoningTokens: number;
    pricing: ModelPricingSnapshot | null;
  }>;
};

export function getAdminCostAnalysis(tenantId?: string) {
  const suffix = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : "";
  return adminRequest<CostAnalysis>(`/api/admin/cost-analysis${suffix}`);
}

export async function listTenants() {
  const result = await adminRequest<AdminListResponse<PublicTenant>>(
    "/api/admin/tenants",
  );
  return result.data;
}

export function createTenant(payload: TenantPayload) {
  return adminRequest<PublicTenant>("/api/admin/tenants", {
    method: "POST",
    body: payload,
  });
}

export function updateTenant(id: string, payload: TenantPayload) {
  return adminRequest<PublicTenant>(`/api/admin/tenants/${encodePath(id)}`, {
    method: "PATCH",
    body: payload,
  });
}

export async function listTenantSubscriptions(tenantId?: string) {
  const suffix = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : "?view=list";
  const result = await adminRequest<{ object: "list"; data: TenantSubscriptionRecord[] }>(`/api/admin/subscriptions${suffix}`);
  return result.data;
}

export function getSubscriptionAllocationOverview() {
  return adminRequest<SubscriptionAllocationOverview>("/api/admin/subscriptions");
}

export function updateSubscriptionPoolQuotaEstimates(id: string, payload: Partial<Record<"5h" | "7d", string | null>>) {
  return adminRequest(`/api/admin/subscriptions/pools/${encodePath(id)}/quota-estimates`, { method: "PATCH", body: payload });
}

export function createTenantSubscription(payload: TenantSubscriptionPayload) {
  return adminRequest<TenantSubscriptionRecord>("/api/admin/subscriptions", { method: "POST", body: payload });
}

export function updateTenantSubscription(id: string, payload: TenantSubscriptionPayload) {
  return adminRequest<TenantSubscriptionRecord>(`/api/admin/subscriptions/${encodePath(id)}`, { method: "PATCH", body: payload });
}

export function deleteTenantSubscription(id: string) {
  return adminRequest<AdminDeleteResponse>(`/api/admin/subscriptions/${encodePath(id)}`, { method: "DELETE" });
}

export function deleteTenant(id: string) {
  return adminRequest<AdminDeleteResponse>(
    `/api/admin/tenants/${encodePath(id)}`,
    { method: "DELETE" },
  );
}

export function createTenantInvite(id: string) {
  return adminRequest<CreatedTenantInvite>(
    `/api/admin/tenants/${encodePath(id)}/invite`,
    { method: "POST" },
  );
}

export function createTenantPasswordReset(id: string) {
  return adminRequest<{ token: string; resetPath: string; expiresAt: string }>(
    `/api/admin/tenants/${encodePath(id)}/password-reset`, { method: "POST" },
  );
}

export function revokeTenantSessions(id: string) {
  return adminRequest<{ revoked: true }>(
    `/api/admin/tenants/${encodePath(id)}/sessions`, { method: "DELETE" },
  );
}

export function listChannels() {
  return adminRequest<ChannelRecord[]>("/api/admin/channels");
}

export function createChannel(payload: ChannelPayload) {
  return adminRequest<ChannelRecord>("/api/admin/channels", {
    method: "POST",
    body: payload,
  });
}

export function updateChannel(id: string, payload: ChannelPayload) {
  return adminRequest<ChannelRecord>(`/api/admin/channels/${encodePath(id)}`, {
    method: "PATCH",
    body: payload,
  });
}

export function deleteChannel(id: string) {
  return adminRequest<AdminDeleteResponse>(
    `/api/admin/channels/${encodePath(id)}`,
    { method: "DELETE" },
  );
}

export function listCredentials() {
  return adminRequest<CodexCredentialRecord[]>("/api/admin/codex/credentials");
}

export function importCredentialJson(
  credential: Record<string, unknown>,
  filename?: string,
) {
  return adminRequest<CodexCredentialRecord>(
    "/api/admin/codex/credentials/import",
    {
      method: "POST",
      body: { credential, filename },
    },
  );
}

export function updateCredentialRouting(
  id: string,
  payload: {
    enabled?: boolean;
    priority?: number;
    weight?: number;
    fastEnabled?: boolean;
    upstreamTransport?: CodexUpstreamTransport;
    userAgent?: string | null;
    useGlobalProxy?: boolean;
    proxyPoolId?: string | null;
    proxy?: CredentialProxyPayload;
  },
) {
  return adminRequest<CodexCredentialRecord>(
    `/api/admin/codex/credentials/${encodePath(id)}`,
    { method: "PATCH", body: payload },
  );
}

export function deleteCredential(id: string) {
  return adminRequest<AdminDeleteResponse>(
    `/api/admin/codex/credentials/${encodePath(id)}`,
    { method: "DELETE" },
  );
}

export function refreshCredential(id: string) {
  return adminRequest<CodexCredentialRecord>(
    `/api/admin/codex/credentials/${encodePath(id)}/refresh`,
    { method: "POST" },
  );
}

export function downloadCredentialsExport(id?: string) {
  const path = id
    ? `/api/admin/codex/credentials/${encodePath(id)}/export`
    : "/api/admin/codex/credentials/export";
  return downloadAdminFile(path);
}

export function getCredentialQuota(
  id: string,
  options: { refresh?: boolean; raw?: boolean } = {},
) {
  const params = new URLSearchParams();
  if (options.refresh) {
    params.set("refresh", "1");
  }
  if (options.raw) {
    params.set("raw", "1");
  }
  const suffix = params.size ? `?${params.toString()}` : "";
  return adminRequest<CodexQuotaReport>(
    `/api/admin/codex/credentials/${encodePath(id)}/quota${suffix}`,
  );
}

export function getCredentialResetCredits(
  id: string,
  options: { raw?: boolean } = {},
) {
  const params = new URLSearchParams();
  if (options.raw) {
    params.set("raw", "1");
  }
  const suffix = params.size ? `?${params.toString()}` : "";
  return adminRequest<CodexResetCreditsReport>(
    `/api/admin/codex/credentials/${encodePath(id)}/quota/reset-credits${suffix}`,
  );
}

export function getCredentialResetEvents(id: string) {
  return adminRequest<CredentialQuotaResetHistory>(
    `/api/admin/codex/credentials/${encodePath(id)}/quota/reset-events`,
  );
}

export function consumeCredentialResetCredit(
  id: string,
  payload: { creditId?: string; redeemRequestId?: string } = {},
) {
  return adminRequest<CodexResetCreditConsumeReport>(
    `/api/admin/codex/credentials/${encodePath(id)}/quota/reset-credits`,
    {
      method: "POST",
      body: payload,
    },
  );
}

export function startCodexOAuth() {
  return adminRequest<OAuthStartResponse>(
    "/api/admin/codex/credentials/oauth/start",
    { method: "POST" },
  );
}

export function finishCodexOAuth(callbackUrl: string) {
  return adminRequest<CodexCredentialRecord>(
    "/api/admin/codex/credentials/oauth/callback",
    {
      method: "POST",
      body: { callbackUrl },
    },
  );
}

export function listProxyPoolItems() {
  return adminRequest<AdminListResponse<ProxyPoolRecord>>(
    "/api/admin/proxy-pool",
  ).then((result) => result.data);
}

export function createProxyPoolItem(payload: ProxyPoolPayload) {
  return adminRequest<ProxyPoolRecord>("/api/admin/proxy-pool", {
    method: "POST",
    body: payload,
  });
}

export function updateProxyPoolItem(id: string, payload: ProxyPoolPayload) {
  return adminRequest<ProxyPoolRecord>(
    `/api/admin/proxy-pool/${encodePath(id)}`,
    {
      method: "PATCH",
      body: payload,
    },
  );
}

export function deleteProxyPoolItem(id: string) {
  return adminRequest<AdminDeleteResponse>(
    `/api/admin/proxy-pool/${encodePath(id)}`,
    { method: "DELETE" },
  );
}

export function logoutWebSession() {
  return adminRequest<{ authenticated: false }>("/api/auth/logout", {
    method: "POST",
  });
}

export function changeAdminPassword(payload: { currentPassword: string; newPassword: string }) {
  return adminRequest<{ changed: true }>("/api/admin/account/password", { method: "POST", body: payload });
}

export function getOverview(options: { days?: number } = {}) {
  const params = new URLSearchParams();
  if (options.days) {
    params.set("days", String(options.days));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return adminRequest<AdminOverviewStats>(`/api/admin/overview${suffix}`);
}

export function getGlobalSettings() {
  return adminRequest<GlobalSettingsRecord>("/api/admin/settings");
}

export function updateGlobalSettings(payload: {
  publicBaseUrl?: string;
  proxy?: CredentialProxyPayload;
  userAgent?: string | null;
  fullRequestLoggingEnabled?: boolean;
  codexAutoDisableRefreshExhausted?: boolean;
  requestLogRetentionDays?: number;
  requestLogDetailRetentionDays?: number;
  timeZone?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  oidcRedirectUris?: string[];
}) {
  return adminRequest<GlobalSettingsRecord>("/api/admin/settings", {
    method: "PATCH",
    body: payload,
  });
}

export function rotateOidcClientSecret() {
  return adminRequest<{ clientSecret: string; settings: GlobalSettingsRecord }>(
    "/api/admin/settings/oidc-secret",
    { method: "POST" },
  );
}

export function getRequestLogDetail(id: string) {
  return adminRequest<RequestLogDetail>(
    `/api/admin/request-logs/${encodePath(id)}`,
  );
}

export function pruneRequestLogs(payload: {
  summaryRetentionDays: number;
  detailRetentionDays: number;
  vacuum?: boolean;
}) {
  return adminRequest<PruneRequestLogsResponse>(
    "/api/admin/request-logs/prune",
    {
      method: "POST",
      body: payload,
    },
  );
}

export function getRequestLogsPage(
  options: RequestLogFilters = {},
) {
  const params = new URLSearchParams({
    limit: String(options.limit ?? 50),
    page: String(options.page ?? 1),
  });
  if (options.query?.trim()) {
    params.set("query", options.query.trim());
  }
  if (options.status && options.status !== "all") {
    params.set("status", options.status);
  }
  for (const key of ["method", "model", "from", "to"] as const) {
    if (options[key]) params.set(key, options[key]);
  }
  if (options.minLatencyMs) params.set("minLatencyMs", String(options.minLatencyMs));
  return adminRequest<RequestLogsPage>(
    `/api/admin/request-logs?${params.toString()}`,
  );
}

export async function getRequestLogs(limit = 100) {
  const result = await getRequestLogsPage({ limit, page: 1 });
  return result.data;
}

export async function getDashboardSnapshot(
  options: { requestLogLimit?: number } = {},
): Promise<AdminDashboardSnapshot> {
  const requestLogLimit = options.requestLogLimit ?? 100;
  const [
    apiKeys,
    tenants,
    channels,
    credentials,
    proxyPool,
    globalSettings,
    requestLogs,
    overviewStats,
  ] = await Promise.all([
    listApiKeys(),
    listTenants(),
    listChannels(),
    listCredentials(),
    listProxyPoolItems(),
    getGlobalSettings(),
    getRequestLogs(requestLogLimit),
    getOverview(),
  ]);

  return {
    apiKeys,
    tenants,
    channels,
    credentials,
    proxyPool,
    globalSettings,
    requestLogs,
    overviewStats,
    generatedAt: Date.now(),
  };
}

export function adminErrorMessage(error: unknown) {
  if (isWebAuthError(error)) {
    return "管理台会话已过期，请重新登录";
  }
  if (error instanceof AdminApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function isWebAuthError(error: unknown) {
  return error instanceof AdminApiError && error.code === "web_auth_required";
}

function notifyWebAuthExpired(error: unknown) {
  if (
    !isWebAuthError(error) ||
    webAuthExpiredNotified ||
    typeof window === "undefined"
  ) {
    return;
  }

  webAuthExpiredNotified = true;
  window.dispatchEvent(
    new CustomEvent(WEB_AUTH_EXPIRED_EVENT, {
      detail: { message: adminErrorMessage(error) },
    }),
  );
}

async function parseResponseBody(response: Response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (response.ok) {
      return text;
    }
    return { message: text } satisfies AdminApiErrorBody;
  }
}

function toAdminApiError(response: Response, parsed: unknown) {
  const body = isObject(parsed) ? (parsed as AdminApiErrorBody) : null;
  const error = isObject(body?.error) ? body.error : null;
  const fallbackCode =
    response.status === 401
      ? "web_auth_required"
      : response.status || "request_failed";

  return new AdminApiError({
    status: response.status,
    code: String(error?.code || fallbackCode),
    message: String(
      error?.message ||
        body?.message ||
        response.statusText ||
        "Request failed",
    ),
    details: error?.details,
  });
}

async function downloadAdminFile(url: string) {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) {
    const parsed = await parseResponseBody(response);
    const error = toAdminApiError(response, parsed);
    notifyWebAuthExpired(error);
    throw error;
  }

  const blob = await response.blob();
  const filename = responseFilename(response) || "relayapi-export.json";
  const href = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = href;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(href);
  }
}

function responseFilename(response: Response) {
  const disposition = response.headers.get("Content-Disposition") || "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  const quoted = disposition.match(/filename="([^\"]+)"/i)?.[1];
  if (quoted) {
    return quoted;
  }
  return disposition.match(/filename=([^;]+)/i)?.[1]?.trim();
}

function encodePath(value: string) {
  return encodeURIComponent(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

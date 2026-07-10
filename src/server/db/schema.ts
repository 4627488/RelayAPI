import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    prefix: text("prefix").notNull(),
    scopesJson: text("scopes_json").notNull(),
    modelAllowlistJson: text("model_allowlist_json").notNull(),
    channelAllowlistJson: text("channel_allowlist_json").notNull(),
    enabled: integer("enabled").notNull().default(1),
    tokenLimitDaily: integer("token_limit_daily"),
    rateLimitPerMinute: integer("rate_limit_per_minute"),
    expiresAt: text("expires_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastUsedAt: text("last_used_at"),
  },
  (table) => [
    uniqueIndex("idx_api_keys_hash").on(table.keyHash),
    index("idx_api_keys_prefix").on(table.prefix),
    index("idx_api_keys_tenant").on(table.tenantId, table.createdAt),
  ],
);

export const codexCredentials = sqliteTable("codex_credentials", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull().default("codex"),
  email: text("email").notNull().default(""),
  accountId: text("account_id").notNull().default(""),
  planType: text("plan_type").notNull().default(""),
  tokenEnvelope: text("token_envelope").notNull(),
  proxyEnvelope: text("proxy_envelope"),
  enabled: integer("enabled").notNull().default(1),
  priority: integer("priority").notNull().default(100),
  weight: integer("weight").notNull().default(1),
  expiresAt: text("expires_at"),
  lastRefreshAt: text("last_refresh_at"),
  lastUsedAt: text("last_used_at"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const channels = sqliteTable(
  "channels",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    provider: text("provider").notNull().default("codex"),
    baseUrl: text("base_url").notNull(),
    credentialId: text("credential_id").notNull(),
    enabled: integer("enabled").notNull().default(1),
    priority: integer("priority").notNull().default(100),
    weight: integer("weight").notNull().default(1),
    modelAllowlistJson: text("model_allowlist_json").notNull().default("[]"),
    status: text("status").notNull().default("healthy"),
    healthScore: real("health_score").notNull().default(100),
    cooldownUntil: text("cooldown_until"),
    lastError: text("last_error"),
    lastUsedAt: text("last_used_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_channels_credential").on(table.credentialId),
    index("idx_channels_routing").on(
      table.enabled,
      table.status,
      table.priority,
      table.weight,
    ),
  ],
);

export const channelCredentials = sqliteTable(
  "channel_credentials",
  {
    channelId: text("channel_id").notNull(),
    credentialId: text("credential_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.credentialId] }),
    index("idx_channel_credentials_credential").on(table.credentialId),
  ],
);

export const codexQuotaCache = sqliteTable("codex_quota_cache", {
  credentialId: text("credential_id").primaryKey(),
  status: text("status").notNull().default("unknown"),
  cacheJson: text("cache_json").notNull(),
  retrievedAt: text("retrieved_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const proxyPool = sqliteTable(
  "proxy_pool",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    username: text("username").notNull().default(""),
    passwordEnvelope: text("password_envelope"),
    enabled: integer("enabled").notNull().default(1),
    notes: text("notes").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastUsedAt: text("last_used_at"),
  },
  (table) => [index("idx_proxy_pool_enabled").on(table.enabled, table.updatedAt)],
);

export const tenants = sqliteTable(
  "tenants",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    ownerEmail: text("owner_email").notNull(),
    enabled: integer("enabled").notNull().default(1),
    maxApiKeys: integer("max_api_keys"),
    tokenLimitDaily: integer("token_limit_daily"),
    quotaSharesMilli: integer("quota_shares_milli"),
    rateLimitPerMinute: integer("rate_limit_per_minute"),
    modelAllowlistJson: text("model_allowlist_json").notNull().default("[]"),
    channelAllowlistJson: text("channel_allowlist_json").notNull().default("[]"),
    allowCustomProxy: integer("allow_custom_proxy").notNull().default(0),
    allowCustomUserAgent: integer("allow_custom_user_agent")
      .notNull()
      .default(0),
    proxyEnvelope: text("proxy_envelope"),
    userAgent: text("user_agent"),
    expiresAt: text("expires_at"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    index("idx_tenants_enabled").on(table.enabled, table.createdAt),
    index("idx_tenants_owner_email").on(table.ownerEmail),
  ],
);

export const tenantQuotaWindows = sqliteTable(
  "tenant_quota_windows",
  {
    tenantId: text("tenant_id").notNull(),
    windowKind: text("window_kind").notNull(),
    startedAt: text("started_at").notNull(),
    resetsAt: text("resets_at").notNull(),
    limitNanoUsd: text("limit_nano_usd").notNull(),
    settledNanoUsd: text("settled_nano_usd").notNull().default("0"),
    reservedNanoUsd: text("reserved_nano_usd").notNull().default("0"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.windowKind] }),
    index("idx_tenant_quota_windows_reset").on(table.resetsAt),
  ],
);

export const quotaReservations = sqliteTable(
  "quota_reservations",
  {
    requestId: text("request_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    reserveNanoUsd: text("reserve_nano_usd").notNull(),
    actualNanoUsd: text("actual_nano_usd"),
    status: text("status").notNull().default("active"),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
    settledAt: text("settled_at"),
  },
  (table) => [index("idx_quota_reservations_tenant_status").on(table.tenantId, table.status)],
);

export const tenantUsers = sqliteTable(
  "tenant_users",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull().default(""),
    role: text("role").notNull().default("owner"),
    enabled: integer("enabled").notNull().default(1),
    passwordHash: text("password_hash"),
    lastLoginAt: text("last_login_at"),
    passwordChangedAt: text("password_changed_at"),
    sessionVersion: integer("session_version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("tenant_users_email_unique").on(table.email),
    index("idx_tenant_users_tenant").on(table.tenantId),
  ],
);

export const tenantPasswordResets = sqliteTable(
  "tenant_password_resets",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("tenant_password_resets_token_unique").on(table.tokenHash),
    index("idx_tenant_password_resets_tenant").on(table.tenantId, table.createdAt),
  ],
);

export const tenantInvites = sqliteTable(
  "tenant_invites",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id"),
    email: text("email").notNull().default(""),
    tokenHash: text("token_hash").notNull(),
    expiresAt: text("expires_at").notNull(),
    acceptedAt: text("accepted_at"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("tenant_invites_token_hash_unique").on(table.tokenHash),
    index("idx_tenant_invites_tenant").on(table.tenantId, table.createdAt),
    index("idx_tenant_invites_token").on(table.tokenHash),
  ],
);

export const oauthPendingStates = sqliteTable("oauth_pending_states", {
  state: text("state").primaryKey(),
  provider: text("provider").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const requestLogs = sqliteTable(
  "request_logs",
  {
    id: text("id").primaryKey(),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    requestType: text("request_type").notNull(),
    stream: integer("stream").notNull().default(0),
    model: text("model").notNull().default(""),
    statusCode: integer("status_code").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    tenantId: text("tenant_id"),
    tenantName: text("tenant_name"),
    apiKeyId: text("api_key_id"),
    apiKeyPrefix: text("api_key_prefix"),
    apiKeyName: text("api_key_name"),
    channelId: text("channel_id"),
    channelName: text("channel_name"),
    credentialId: text("credential_id"),
    credentialEmail: text("credential_email"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    costNanoUsd: text("cost_nano_usd"),
    priceModel: text("price_model"),
    priceVersion: text("price_version"),
    inputNanoUsdPerToken: text("input_nano_usd_per_token"),
    outputNanoUsdPerToken: text("output_nano_usd_per_token"),
    cachedInputNanoUsdPerToken: text("cached_input_nano_usd_per_token"),
    cacheWriteNanoUsdPerToken: text("cache_write_nano_usd_per_token"),
    reasoningNanoUsdPerToken: text("reasoning_nano_usd_per_token"),
    pricingComplete: integer("pricing_complete").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
  },
  (table) => [
    index("idx_request_logs_started").on(table.startedAt),
    index("idx_request_logs_api_key").on(table.apiKeyId, table.startedAt),
    index("idx_request_logs_channel").on(table.channelId, table.startedAt),
    index("idx_request_logs_credential").on(
      table.credentialId,
      table.startedAt,
    ),
    index("idx_request_logs_tenant").on(table.tenantId, table.startedAt),
  ],
);

export const requestLogDetails = sqliteTable("request_log_details", {
  requestLogId: text("request_log_id").primaryKey(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  requestHeadersJson: text("request_headers_json"),
  requestBodyText: text("request_body_text"),
  requestBodyTruncated: integer("request_body_truncated").notNull().default(0),
  requestBodyBytes: integer("request_body_bytes").notNull().default(0),
  forwardedBodyText: text("forwarded_body_text"),
  forwardedBodyTruncated: integer("forwarded_body_truncated")
    .notNull()
    .default(0),
  forwardedBodyBytes: integer("forwarded_body_bytes").notNull().default(0),
  upstreamStatusCode: integer("upstream_status_code"),
  upstreamHeadersJson: text("upstream_headers_json"),
  upstreamBodyText: text("upstream_body_text"),
  upstreamBodyTruncated: integer("upstream_body_truncated")
    .notNull()
    .default(0),
  upstreamBodyBytes: integer("upstream_body_bytes").notNull().default(0),
  errorName: text("error_name"),
  errorMessage: text("error_message"),
  errorStack: text("error_stack"),
  errorCauseJson: text("error_cause_json"),
  detailJson: text("detail_json"),
  stageTimingsJson: text("stage_timings_json"),
});

export const usageRecords = sqliteTable("usage_records", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
  tenantId: text("tenant_id"),
  tenantName: text("tenant_name"),
  apiKeyId: text("api_key_id"),
  apiKeyPrefix: text("api_key_prefix"),
  apiKeyName: text("api_key_name"),
  channelId: text("channel_id"),
  channelName: text("channel_name"),
  credentialId: text("credential_id"),
  credentialEmail: text("credential_email"),
  model: text("model").notNull().default(""),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  cachedTokens: integer("cached_tokens").notNull().default(0),
});

export const usageDailyBuckets = sqliteTable("usage_daily_buckets", {
  bucketDate: text("bucket_date").notNull(),
  tenantId: text("tenant_id"),
  apiKeyId: text("api_key_id").notNull().default(""),
  channelId: text("channel_id").notNull().default(""),
  credentialId: text("credential_id").notNull().default(""),
  model: text("model").notNull().default(""),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  cachedTokens: integer("cached_tokens").notNull().default(0),
  requestCount: integer("request_count").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

export const requestDailyBuckets = sqliteTable("request_daily_buckets", {
  bucketDate: text("bucket_date").notNull(),
  tenantId: text("tenant_id").notNull().default(""),
  apiKeyId: text("api_key_id").notNull().default(""),
  model: text("model").notNull().default(""),
  channelId: text("channel_id").notNull().default(""),
  credentialId: text("credential_id").notNull().default(""),
  requestType: text("request_type").notNull().default(""),
  requestCount: integer("request_count").notNull().default(0),
  successCount: integer("success_count").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  streamCount: integer("stream_count").notNull().default(0),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  cachedTokens: integer("cached_tokens").notNull().default(0),
  totalLatencyMs: integer("total_latency_ms").notNull().default(0),
  firstRequestAt: text("first_request_at"),
  lastRequestAt: text("last_request_at"),
  updatedAt: text("updated_at").notNull(),
});

export const channelHealthEvents = sqliteTable("channel_health_events", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
  channelId: text("channel_id").notNull(),
  channelName: text("channel_name").notNull().default(""),
  credentialId: text("credential_id"),
  eventType: text("event_type").notNull(),
  statusCode: integer("status_code"),
  healthScore: real("health_score"),
  cooldownUntil: text("cooldown_until"),
  message: text("message"),
});

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
  actorType: text("actor_type").notNull().default("system"),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  detailJson: text("detail_json").notNull().default("{}"),
});

export const mainSchema = {
  apiKeys,
  codexCredentials,
  channels,
  channelCredentials,
  codexQuotaCache,
  oauthPendingStates,
  proxyPool,
  settings,
  tenantInvites,
  tenantPasswordResets,
  tenantQuotaWindows,
  quotaReservations,
  tenants,
  tenantUsers,
};

export const logSchema = {
  auditLogs,
  channelHealthEvents,
  requestDailyBuckets,
  requestLogDetails,
  requestLogs,
  usageDailyBuckets,
  usageRecords,
};

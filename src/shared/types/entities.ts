export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ChannelStatus =
  | "healthy"
  | "degraded"
  | "cooling_down"
  | "disabled";

export type CodexAccountUsageStatus = "normal" | "warning" | "error" | "unused";

export interface CodexAccountUsageHealth {
  status: CodexAccountUsageStatus;
  score: number;
  requestCount: number;
  successCount: number;
  errorCount: number;
  lastUsedAt: string | null;
  lastStatusCode: number | null;
  lastErrorCode: string | null;
  windowSize: number;
}

export interface ApiKeyRecord {
  id: string;
  tenantId: string | null;
  name: string;
  prefix: string;
  keyHash: string;
  scopes: string[];
  modelAllowlist: string[];
  channelAllowlist: string[];
  enabled: boolean;
  tokenLimitDaily: number | null;
  rateLimitPerMinute: number | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface PublicApiKey {
  id: string;
  tenantId: string | null;
  name: string;
  prefix: string;
  scopes: string[];
  modelAllowlist: string[];
  channelAllowlist: string[];
  enabled: boolean;
  tokenLimitDaily: number | null;
  rateLimitPerMinute: number | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface CreatedApiKey extends PublicApiKey {
  key: string;
}

export interface TenantLimits {
  quotaShares: number | null;
  maxApiKeys: number | null;
  tokenLimitDaily: number | null;
  rateLimitPerMinute: number | null;
  modelAllowlist: string[];
  channelAllowlist: string[];
  expiresAt: string | null;
}

export interface TenantRecord extends TenantLimits {
  id: string;
  name: string;
  ownerEmail: string;
  enabled: boolean;
  allowCustomProxy: boolean;
  allowCustomUserAgent: boolean;
  proxy: PublicCredentialProxyConfig | null;
  userAgent: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  metadata: Record<string, unknown>;
}

export interface TenantWithSecrets
  extends Omit<TenantRecord, "proxy"> {
  proxy: CredentialProxyConfig | null;
}

export interface PublicTenant extends TenantRecord {
  apiKeyCount: number;
  enabledApiKeyCount: number;
  todayTokens: number;
  pendingInvite: boolean;
  lastLoginAt: string | null;
  passwordChangedAt: string | null;
}

export interface TenantUserRecord {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  role: "owner";
  enabled: boolean;
  passwordHash: string | null;
  lastLoginAt: string | null;
  passwordChangedAt: string | null;
  sessionVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface TenantPasswordResetRecord {
  id: string;
  tenantId: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreatedTenantPasswordReset {
  token: string;
  resetPath: string;
  expiresAt: string;
}

export interface TenantInviteRecord {
  id: string;
  tenantId: string;
  userId: string | null;
  email: string;
  tokenHash: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatedTenantInvite {
  id: string;
  tenantId: string;
  email: string;
  expiresAt: string;
  activateUrl: string;
  token: string;
}

export interface TenantResourceChannel {
  id: string;
  name: string;
  enabled: boolean;
  status: ChannelStatus;
  modelAllowlist: string[];
  credentialIds: string[];
}

export interface TenantResourceCredential {
  id: string;
  provider: "codex";
  email: string;
  accountId: string;
  planType: string;
  enabled: boolean;
  priority: number;
  weight: number;
  fastEnabled: boolean;
  upstreamTransport: CodexUpstreamTransport;
  useGlobalProxy: boolean;
  proxy: PublicCredentialProxyConfig | null;
  usageHealth?: CodexAccountUsageHealth;
  expiresAt: string | null;
  lastRefreshAt: string | null;
  lastUsedAt: string | null;
  cooldownUntil: string | null;
  lastError: string | null;
}

export interface TenantResources {
  models: string[];
  channels: TenantResourceChannel[];
  credentials: TenantResourceCredential[];
}

export interface TenantRuntimeContext {
  id: string;
  name: string;
  proxy: CredentialProxyConfig | null;
  userAgent: string | null;
  quotaShares: number | null;
}

export type CredentialProxyType = "socks5" | "socks5h";

export interface CredentialProxyConfig {
  enabled: boolean;
  type: CredentialProxyType;
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface PublicCredentialProxyConfig {
  enabled: boolean;
  type: CredentialProxyType;
  host: string;
  port: number;
  username: string;
  passwordSet?: boolean;
}

export interface ProxyPoolRecord {
  id: string;
  name: string;
  enabled: boolean;
  type: CredentialProxyType;
  host: string;
  port: number;
  username: string;
  passwordSet: boolean;
  notes: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface ProxyPoolRecordWithSecret extends Omit<
  ProxyPoolRecord,
  "passwordSet"
> {
  password: string;
}

export type CodexUpstreamTransport = "http" | "websocket";

export interface CodexTokenBundle {
  access_token: string;
  refresh_token: string;
  id_token: string;
  expired: string;
  last_refresh: string;
}

export interface CodexCredentialRecord {
  id: string;
  provider: "codex";
  email: string;
  accountId: string;
  planType: string;
  enabled: boolean;
  priority: number;
  weight: number;
  fastEnabled: boolean;
  upstreamTransport: CodexUpstreamTransport;
  userAgent: string | null;
  useGlobalProxy: boolean;
  proxyPoolId: string | null;
  proxy: PublicCredentialProxyConfig | null;
  usageHealth?: CodexAccountUsageHealth;
  expiresAt: string | null;
  lastRefreshAt: string | null;
  lastUsedAt: string | null;
  cooldownUntil: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export type CodexCredentialWithTokens = Omit<CodexCredentialRecord, "proxy"> & {
  proxy: CredentialProxyConfig | null;
  tokens: CodexTokenBundle;
};

export interface GlobalSettingsRecord {
  publicBaseUrl: string;
  proxy: PublicCredentialProxyConfig | null;
  proxySource: "database" | "environment" | "none";
  userAgent: string;
  userAgentSource: "database" | "environment" | "default";
  fullRequestLoggingEnabled: boolean;
  codexAutoDisableRefreshExhausted: boolean;
  requestLogRetentionDays: number | null;
  requestLogDetailRetentionDays: number | null;
  timeZone: string;
  timeZonePending: string | null;
  timeZoneRebuildStatus: TimeZoneRebuildStatus;
  timeZoneRebuildError: string | null;
  updatedAt: string | null;
}

export type TimeZoneRebuildStatus =
  | "idle"
  | "pending"
  | "running"
  | "failed";

export interface ChannelRecord {
  id: string;
  name: string;
  provider: "codex";
  baseUrl: string;
  credentialId: string;
  credentialIds: string[];
  enabled: boolean;
  priority: number;
  weight: number;
  modelAllowlist: string[];
  status: ChannelStatus;
  healthScore: number;
  usageHealth?: CodexAccountUsageHealth;
  cooldownUntil: string | null;
  lastError: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RelayApiKeyContext {
  id: string;
  tenantId: string | null;
  tenant: TenantRuntimeContext | null;
  name: string;
  prefix: string;
  scopes: string[];
  modelAllowlist: string[];
  channelAllowlist: string[];
  tokenLimitDaily: number | null;
  rateLimitPerMinute: number | null;
}

export interface RelayRequestContext {
  apiKey: RelayApiKeyContext;
  model: string;
  requestType: string;
  stream: boolean;
  method: string;
  path: string;
}

export interface SelectedChannel {
  channel: ChannelRecord;
  credential: CodexCredentialWithTokens;
}

export interface UsageSnapshot {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costNanoUsd?: string | null;
  priceModel?: string | null;
  priceVersion?: string | null;
  pricingComplete?: boolean;
}

export interface UsageStatsRow {
  key: string;
  label: string;
  subLabel: string | null;
  requestCount: number;
  successCount: number;
  errorCount: number;
  streamCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheHitRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgFirstTokenLatencyMs: number;
  p95FirstTokenLatencyMs: number;
  avgTokensPerRequest: number;
  tokensPerSecond: number;
  firstRequestAt: string | null;
  lastRequestAt: string | null;
}

export interface ApiKeyUsageStatsRow extends UsageStatsRow {
  apiKeyId: string | null;
  apiKeyPrefix: string | null;
  apiKeyName: string;
  enabled: boolean | null;
  tokenLimitDaily: number | null;
  todayTokens: number;
  tokenLimitUtilization: number | null;
}

export interface TenantUsageStatsRow extends UsageStatsRow {
  tenantId: string | null;
  tenantName: string;
  enabled: boolean | null;
  tokenLimitDaily: number | null;
  todayTokens: number;
  tokenLimitUtilization: number | null;
}

export interface ApiKeyModelUsageStatsRow extends UsageStatsRow {
  apiKeyId: string | null;
  apiKeyPrefix: string | null;
  apiKeyName: string;
  model: string;
}

export interface ApiKeyDailyUsageStatsRow extends DailyUsageStatsRow {
  apiKeyId: string | null;
  apiKeyPrefix: string | null;
  apiKeyName: string;
}

export interface DailyDimensionUsageStatsRow extends UsageStatsRow {
  date: string;
  dimension: "tenant" | "api_key" | "model" | "channel" | "credential" | "request_type";
  dimensionId: string | null;
  dimensionName: string;
}

export interface ErrorCodeDailyStatsRow {
  date: string;
  errorCode: string;
  requestCount: number;
  tenantId: string | null;
  tenantName: string | null;
}

export interface DailyUsageStatsRow {
  date: string;
  requestCount: number;
  successCount: number;
  errorCount: number;
  streamCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheHitRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgFirstTokenLatencyMs: number;
  p95FirstTokenLatencyMs: number;
  avgTokensPerRequest: number;
  tokensPerSecond: number;
}

export interface ActivityHeatmapDay {
  date: string;
  requestCount: number;
  successCount: number;
  errorCount: number;
  streamCount: number;
  totalTokens: number;
  level: number;
}

export interface ActivityHeatmapStats {
  generatedAt: string;
  scope: "site" | "api_key";
  apiKeyId: string | null;
  apiKeyName: string | null;
  apiKeyPrefix: string | null;
  from: string;
  to: string;
  weeks: number;
  days: ActivityHeatmapDay[];
  totalRequests: number;
  totalTokens: number;
  activeDays: number;
  maxRequests: number;
  currentStreakDays: number;
  longestStreakDays: number;
}

export interface AdminOverviewTotals {
  requestCount: number;
  successCount: number;
  errorCount: number;
  streamCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheHitRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgFirstTokenLatencyMs: number;
  p95FirstTokenLatencyMs: number;
  avgTokensPerRequest: number;
  tokensPerSecond: number;
  distinctApiKeyCount: number;
  distinctModelCount: number;
  distinctChannelCount: number;
  firstRequestAt: string | null;
  lastRequestAt: string | null;
}

export interface AdminOverviewRange {
  from: string;
  to: string;
  days: number;
}

export interface AdminOverviewAnomaly {
  id: string;
  severity: "info" | "warning" | "critical";
  category: "error" | "latency" | "quota" | "traffic" | "routing";
  title: string;
  description: string;
  date: string | null;
  tenantId: string | null;
  tenantName: string | null;
  targetId: string | null;
  targetName: string | null;
  metric: string;
  value: number;
  baseline: number | null;
}

export interface AdminOverviewStats {
  generatedAt: string;
  range: AdminOverviewRange;
  totals: AdminOverviewTotals;
  byTenant: TenantUsageStatsRow[];
  byApiKey: ApiKeyUsageStatsRow[];
  byApiKeyDay: ApiKeyDailyUsageStatsRow[];
  byApiKeyModel: ApiKeyModelUsageStatsRow[];
  byModel: UsageStatsRow[];
  byChannel: UsageStatsRow[];
  byCredential: UsageStatsRow[];
  byRequestType: UsageStatsRow[];
  byDay: DailyUsageStatsRow[];
  byTenantDay: DailyDimensionUsageStatsRow[];
  byModelDay: DailyDimensionUsageStatsRow[];
  byChannelDay: DailyDimensionUsageStatsRow[];
  byCredentialDay: DailyDimensionUsageStatsRow[];
  byRequestTypeDay: DailyDimensionUsageStatsRow[];
  byErrorCodeDay: ErrorCodeDailyStatsRow[];
  anomalies: AdminOverviewAnomaly[];
}

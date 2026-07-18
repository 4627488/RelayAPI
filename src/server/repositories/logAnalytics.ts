import "server-only";

import { getLogClient, getMainClient } from "@/src/server/db/sqlite";
import { serverConfig } from "@/src/server/config/env";
import { flushLogWriteBarrier } from "@/src/server/repositories/logWriteBarrier";
import { getGlobalTimeZoneSetting } from "@/src/server/services/settings";
import type {
  AdminOverviewAnomaly,
  AdminOverviewStats,
  AdminOverviewTotals,
  ApiKeyDailyUsageStatsRow,
  ApiKeyModelUsageStatsRow,
  ApiKeyUsageStatsRow,
  CodexAccountUsageHealth,
  DailyDimensionUsageStatsRow,
  DailyUsageStatsRow,
  ErrorCodeDailyStatsRow,
  TenantUsageStatsRow,
  UsageStatsRow,
} from "@/src/shared/types/entities";
import { addDateKeyDays, instantToDateKey } from "@/src/shared/time";

const ADMIN_OVERVIEW_CACHE_TTL_MS = 15_000;
const OVERVIEW_GROUP_LIMIT = 100;
const OVERVIEW_DAILY_WINDOW_DAYS = 30;
const OVERVIEW_MAX_DAILY_WINDOW_DAYS = 90;

type LogScope = { tenantId?: string | null; days?: number };

let adminOverviewCache: { expiresAt: number; value: AdminOverviewStats } | null = null;
let usageHealthCache = new Map<string, {
  expiresAt: number;
  value: Record<string, CodexAccountUsageHealth>;
}>();

export function invalidateLogAnalyticsCache() {
  adminOverviewCache = null;
  usageHealthCache.clear();
}

export function getAdminOverviewStats(scope: LogScope = {}): AdminOverviewStats {
  const now = Date.now();
  const days = normalizeOverviewDays(scope.days);
  const normalizedScope = { ...scope, days };
  const range = overviewRange(days);
  const cacheable = scope.tenantId === undefined && days === OVERVIEW_DAILY_WINDOW_DAYS;
  if (cacheable && adminOverviewCache && adminOverviewCache.expiresAt > now) {
    return adminOverviewCache.value;
  }

  const totals = getOverviewTotals(normalizedScope);
  const byDay = getDailyUsageStats(normalizedScope);
  const byTenant = getTenantUsageStats(normalizedScope);
  const byChannel = getGroupedUsageStats("channel_id", "channel_name", normalizedScope);
  const byCredential = getGroupedUsageStats(
    "credential_id",
    "credential_email",
    normalizedScope,
  );
  const value = {
    generatedAt: new Date().toISOString(),
    range,
    totals,
    byTenant,
    byApiKey: getApiKeyUsageStats(normalizedScope),
    byApiKeyDay: getApiKeyDailyUsageStats(normalizedScope),
    byApiKeyModel: getApiKeyModelUsageStats(normalizedScope),
    byModel: getGroupedUsageStats("model", "model", normalizedScope),
    byChannel,
    byCredential,
    byRequestType: getGroupedUsageStats(
      "request_type",
      "request_type",
      normalizedScope,
    ),
    byDay,
    byTenantDay: getDailyDimensionUsageStats("tenant", "tenant_id", normalizedScope),
    byModelDay: getDailyDimensionUsageStats("model", "model", normalizedScope),
    byChannelDay: getDailyDimensionUsageStats("channel", "channel_id", normalizedScope),
    byCredentialDay: getDailyDimensionUsageStats("credential", "credential_id", normalizedScope),
    byRequestTypeDay: getDailyDimensionUsageStats("request_type", "request_type", normalizedScope),
    byErrorCodeDay: getErrorCodeDailyStats(normalizedScope),
    anomalies: buildAdminOverviewAnomalies({
      byDay,
      byTenant,
      byChannel,
      byCredential,
      totals,
    }),
  };
  if (cacheable) {
    adminOverviewCache = {
      expiresAt: now + ADMIN_OVERVIEW_CACHE_TTL_MS,
      value,
    };
  }
  return value;
}

export function emptyAdminOverviewStats(): AdminOverviewStats {
  const range = overviewRange(OVERVIEW_DAILY_WINDOW_DAYS);
  return {
    generatedAt: new Date().toISOString(),
    range,
    totals: {
      requestCount: 0,
      successCount: 0,
      errorCount: 0,
      streamCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      cacheHitRate: 0,
      avgLatencyMs: 0,
      p95LatencyMs: 0,
      avgFirstTokenLatencyMs: 0,
      p95FirstTokenLatencyMs: 0,
      avgTokensPerRequest: 0,
      tokensPerSecond: 0,
      distinctApiKeyCount: 0,
      distinctModelCount: 0,
      distinctChannelCount: 0,
      firstRequestAt: null,
      lastRequestAt: null,
    },
    byTenant: [],
    byApiKey: [],
    byApiKeyDay: [],
    byApiKeyModel: [],
    byModel: [],
    byChannel: [],
    byCredential: [],
    byRequestType: [],
    byDay: [],
    byTenantDay: [],
    byModelDay: [],
    byChannelDay: [],
    byCredentialDay: [],
    byRequestTypeDay: [],
    byErrorCodeDay: [],
    anomalies: [],
  };
}

const DEFAULT_CREDENTIAL_USAGE_WINDOW_SIZE = 50;
const DEFAULT_CHANNEL_USAGE_WINDOW_SIZE = 100;
const CREDENTIAL_USAGE_NORMAL_THRESHOLD = 80;
const CREDENTIAL_USAGE_WARNING_THRESHOLD = 50;

export function credentialUsageHealth(
  credentialIds: string[],
  windowSize = DEFAULT_CREDENTIAL_USAGE_WINDOW_SIZE,
): Record<string, CodexAccountUsageHealth> {
  return requestWindowUsageHealth(
    credentialIds,
    "credential_id",
    Math.max(1, Math.floor(windowSize)),
  );
}

export function channelUsageHealth(
  channelIds: string[],
  windowSize = DEFAULT_CHANNEL_USAGE_WINDOW_SIZE,
): Record<string, CodexAccountUsageHealth> {
  return requestWindowUsageHealth(
    channelIds,
    "channel_id",
    Math.max(1, Math.floor(windowSize)),
  );
}

function requestWindowUsageHealth(
  ids: string[],
  columnName: "credential_id" | "channel_id",
  windowSize: number,
): Record<string, CodexAccountUsageHealth> {
  const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  const healthById: Record<string, CodexAccountUsageHealth> = {};

  for (const id of uniqueIds) {
    healthById[id] = unusedUsageHealth(windowSize);
  }
  if (uniqueIds.length === 0) {
    return healthById;
  }

  const cacheKey = usageHealthCacheKey(columnName, windowSize, uniqueIds);
  const now = Date.now();
  const cached = usageHealthCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { ...healthById, ...cached.value };
  }

  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = logAll(
    `WITH ranked AS (
         SELECT ${columnName} AS target_id, started_at, status_code, error_code,
           ROW_NUMBER() OVER (
             PARTITION BY ${columnName}
             ORDER BY started_at DESC
           ) AS row_number
         FROM request_logs INDEXED BY ${requestLogWindowIndex(columnName)}
         WHERE ${columnName} IN (${placeholders})
       )
        SELECT target_id, started_at, status_code, error_code
        FROM ranked
        WHERE row_number <= ?
        ORDER BY target_id ASC, started_at DESC`,
    [...uniqueIds, windowSize],
  );

  const rowsById = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const id = String(row.target_id || "");
    if (!id) {
      continue;
    }
    const targetRows = rowsById.get(id) || [];
    targetRows.push(row);
    rowsById.set(id, targetRows);
  }
  for (const id of uniqueIds) {
    healthById[id] = calculateUsageHealth(rowsById.get(id) || [], windowSize);
  }

  if (serverConfig.usageHealthCacheTtlMs > 0) {
    usageHealthCache.set(cacheKey, {
      expiresAt: now + serverConfig.usageHealthCacheTtlMs,
      value: healthById,
    });
    pruneUsageHealthCache(now);
  }
  return healthById;
}

function usageHealthCacheKey(
  columnName: "credential_id" | "channel_id",
  windowSize: number,
  ids: string[],
) {
  return `${columnName}:${windowSize}:${ids.toSorted().join(",")}`;
}

function pruneUsageHealthCache(now: number) {
  if (usageHealthCache.size <= 100) {
    return;
  }
  usageHealthCache = new Map(
    [...usageHealthCache.entries()].filter(([, item]) => item.expiresAt > now),
  );
}

function requestLogWindowIndex(columnName: "credential_id" | "channel_id") {
  return columnName === "credential_id"
    ? "idx_request_logs_credential"
    : "idx_request_logs_channel";
}

function unusedUsageHealth(windowSize: number): CodexAccountUsageHealth {
  return {
    status: "unused",
    score: 100,
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    lastUsedAt: null,
    lastStatusCode: null,
    lastErrorCode: null,
    windowSize,
  };
}

function calculateUsageHealth(
  rows: Array<Record<string, unknown>>,
  windowSize: number,
): CodexAccountUsageHealth {
  if (rows.length === 0) {
    return unusedUsageHealth(windowSize);
  }
  const requestCount = rows.length;
  const successCount = rows.filter((row) =>
    isSuccessfulStatusCode(row.status_code),
  ).length;
  const errorCount = requestCount - successCount;
  const score = Math.round((successCount / requestCount) * 100);
  const lastRow = rows[0] || {};
  const lastStatusCode = Number(lastRow.status_code || 0) || null;
  return {
    status:
      score >= CREDENTIAL_USAGE_NORMAL_THRESHOLD
        ? "normal"
        : score >= CREDENTIAL_USAGE_WARNING_THRESHOLD
          ? "warning"
          : "error",
    score,
    requestCount,
    successCount,
    errorCount,
    lastUsedAt: nullableString(lastRow.started_at),
    lastStatusCode,
    lastErrorCode: nullableString(lastRow.error_code),
    windowSize,
  };
}

function isSuccessfulStatusCode(value: unknown) {
  const statusCode = Number(value || 0);
  return statusCode >= 200 && statusCode < 400;
}

function overviewWhere(
  scope: LogScope,
  conditions: string[] = [],
  params: string[] = [],
) {
  const nextConditions = [...conditions];
  const nextParams = [...params];
  if (scope.tenantId !== undefined) {
    if (scope.tenantId === null) {
      nextConditions.push("tenant_id IS NULL");
    } else {
      nextConditions.push("tenant_id = ?");
      nextParams.push(scope.tenantId);
    }
  }
  return {
    where:
      nextConditions.length > 0
        ? `WHERE ${nextConditions.join(" AND ")}`
        : "",
    params: nextParams,
  };
}

function bucketWhere(
  scope: LogScope,
  conditions: string[] = [],
  params: string[] = [],
) {
  return overviewWhere(scope, conditions, params);
}

function getOverviewTotals(scope: LogScope = {}): AdminOverviewTotals {
  const { where, params } = bucketWhere(scope);
  const row = logGet(
    `SELECT
        COALESCE(SUM(request_count), 0) AS request_count,
        COALESCE(SUM(success_count), 0) AS success_count,
        COALESCE(SUM(error_count), 0) AS error_count,
        COALESCE(SUM(stream_count), 0) AS stream_count,
        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
        COALESCE(SUM(total_latency_ms), 0) AS total_latency_ms,
        COUNT(DISTINCT NULLIF(api_key_id, '')) AS distinct_api_key_count,
        COUNT(DISTINCT NULLIF(model, '')) AS distinct_model_count,
        COUNT(DISTINCT NULLIF(channel_id, '')) AS distinct_channel_count,
        MIN(first_request_at) AS first_request_at,
        MAX(last_request_at) AS last_request_at
      FROM request_daily_buckets
      ${where}`,
    params,
  );
  const requestCount = numberValue(row?.request_count);
  const promptTokens = numberValue(row?.prompt_tokens);
  const totalTokens = numberValue(row?.total_tokens);
  const cachedTokens = numberValue(row?.cached_tokens);
  return {
    requestCount,
    successCount: numberValue(row?.success_count),
    errorCount: numberValue(row?.error_count),
    streamCount: numberValue(row?.stream_count),
    promptTokens,
    completionTokens: numberValue(row?.completion_tokens),
    totalTokens,
    cachedTokens,
    cacheHitRate: cacheHitRate(cachedTokens, promptTokens),
    avgLatencyMs: Math.round(average(numberValue(row?.total_latency_ms), requestCount)),
    p95LatencyMs: 0,
    avgFirstTokenLatencyMs: 0,
    p95FirstTokenLatencyMs: 0,
    avgTokensPerRequest: average(totalTokens, requestCount),
    tokensPerSecond: throughput(totalTokens, row?.total_latency_ms),
    distinctApiKeyCount: numberValue(row?.distinct_api_key_count),
    distinctModelCount: numberValue(row?.distinct_model_count),
    distinctChannelCount: numberValue(row?.distinct_channel_count),
    firstRequestAt: nullableString(row?.first_request_at),
    lastRequestAt: nullableString(row?.last_request_at),
  };
}

function getApiKeyUsageStats(scope: LogScope = {}): ApiKeyUsageStatsRow[] {
  const overviewWindowStart = overviewRecentStartedAt(scope).slice(0, 10);
  const { where, params } = bucketWhere(scope, ["bucket_date >= ?"], [
    overviewWindowStart,
  ]);
  const rows = logAll(
    `${bucketAggregateSelect("api_key_id")}
       ${where}
       GROUP BY COALESCE(api_key_id, '')
       ORDER BY total_tokens DESC, request_count DESC
       LIMIT ?`,
    [...params, OVERVIEW_GROUP_LIMIT],
  );
  const keysById = apiKeysById(scope);
  const todayTokensByKey = todayTokensByApiKey(scope);
  const stats = rows.map((row) => {
    const apiKeyId = nullableString(row.group_key);
    const keyRecord = apiKeyId ? keysById.get(apiKeyId) : undefined;
    const base = toUsageStatsRow(row, {
      label:
        keyRecord?.name ||
        nullableString(row.group_label) ||
        "未知 Key",
      subLabel: keyRecord?.prefix || nullableString(row.group_label),
      emptyLabel: "未知 Key",
      groupColumn: "api_key_id",
      scope,
    });
    const tokenLimitDaily = keyRecord?.token_limit_daily ?? null;
    const todayTokens = apiKeyId ? todayTokensByKey.get(apiKeyId) || 0 : 0;
    return {
      ...base,
      apiKeyId,
      apiKeyPrefix: keyRecord?.prefix || null,
      apiKeyName: keyRecord?.name || base.label,
      enabled:
        typeof keyRecord?.enabled === "number" ? keyRecord.enabled === 1 : null,
      tokenLimitDaily,
      todayTokens,
      tokenLimitUtilization:
        tokenLimitDaily && tokenLimitDaily > 0
          ? Math.round((todayTokens / tokenLimitDaily) * 100)
          : null,
    };
  });

  const seenKeyIds = new Set(stats.map((row) => row.apiKeyId).filter(Boolean));
  for (const keyRecord of keysById.values()) {
    if (seenKeyIds.has(keyRecord.id)) {
      continue;
    }
    const todayTokens = todayTokensByKey.get(keyRecord.id) || 0;
    const tokenLimitDaily = keyRecord.token_limit_daily;
    stats.push({
      ...emptyUsageStatsRow({
        key: keyRecord.id,
        label: keyRecord.name,
        subLabel: keyRecord.prefix,
      }),
      apiKeyId: keyRecord.id,
      apiKeyPrefix: keyRecord.prefix,
      apiKeyName: keyRecord.name,
      enabled: keyRecord.enabled === 1,
      tokenLimitDaily,
      todayTokens,
      tokenLimitUtilization:
        tokenLimitDaily && tokenLimitDaily > 0
          ? Math.round((todayTokens / tokenLimitDaily) * 100)
          : null,
    });
  }

  return stats;
}

function getTenantUsageStats(scope: LogScope = {}): TenantUsageStatsRow[] {
  if (scope.tenantId !== undefined) {
    return [];
  }
  const overviewWindowStart = overviewRecentStartedAt(scope).slice(0, 10);
  const { where, params } = bucketWhere(scope, ["bucket_date >= ?"], [
    overviewWindowStart,
  ]);
  const rows = logAll(
    `${bucketAggregateSelect("tenant_id")}
       ${where}
       GROUP BY COALESCE(tenant_id, '')
       ORDER BY total_tokens DESC, request_count DESC
       LIMIT ?`,
    [...params, OVERVIEW_GROUP_LIMIT],
  );
  const tenantsById = tenantRecordsById();
  const todayTokensByTenant = todayTokensByTenantId();

  return rows.map((row) => {
    const tenantId = nullableString(row.group_key);
    const tenantRecord = tenantId ? tenantsById.get(tenantId) : undefined;
    const tenantName =
      tenantRecord?.name ||
      nullableString(row.group_label) ||
      (tenantId ? "未知租户" : "未归属");
    const base = toUsageStatsRow(row, {
      label: tenantName,
      subLabel: tenantRecord?.owner_email || tenantId,
      emptyLabel: "未归属",
      groupColumn: "tenant_id",
      scope,
    });
    const tokenLimitDaily = tenantRecord?.token_limit_daily ?? null;
    const todayTokens = tenantId
      ? todayTokensByTenant.get(tenantId) || 0
      : todayTokensByTenant.get("") || 0;
    return {
      ...base,
      tenantId,
      tenantName,
      enabled:
        typeof tenantRecord?.enabled === "number"
          ? tenantRecord.enabled === 1
          : tenantId
            ? null
            : true,
      tokenLimitDaily,
      todayTokens,
      tokenLimitUtilization:
        tokenLimitDaily && tokenLimitDaily > 0
          ? Math.round((todayTokens / tokenLimitDaily) * 100)
          : null,
    };
  });
}

function getApiKeyModelUsageStats(
  scope: LogScope = {},
): ApiKeyModelUsageStatsRow[] {
  const recentStartedAt = overviewRecentStartedAt(scope).slice(0, 10);
  const { where, params } = bucketWhere(scope, ["bucket_date >= ?"], [
    recentStartedAt,
  ]);
  const rows = logAll(
    `SELECT
        COALESCE(api_key_id, '') AS api_key_id,
        COALESCE(model, '') AS model,
        COALESCE(SUM(request_count), 0) AS request_count,
        COALESCE(SUM(success_count), 0) AS success_count,
        COALESCE(SUM(error_count), 0) AS error_count,
        COALESCE(SUM(stream_count), 0) AS stream_count,
        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
        COALESCE(SUM(total_latency_ms), 0) AS total_latency_ms,
        MIN(first_request_at) AS first_request_at,
        MAX(last_request_at) AS last_request_at
      FROM request_daily_buckets
      ${where}
      GROUP BY COALESCE(api_key_id, ''), COALESCE(model, '')
      ORDER BY total_tokens DESC, request_count DESC
      LIMIT ?`,
    [...params, OVERVIEW_GROUP_LIMIT],
  );
  const keysById = apiKeysById(scope);
  return rows.map((row) => {
    const apiKeyId = nullableString(row.api_key_id);
    const keyRecord = apiKeyId ? keysById.get(apiKeyId) : undefined;
    const model = nullableString(row.model) || "未知模型";
    const base = toUsageStatsRow(
      {
        ...row,
        group_key: `${apiKeyId || "unknown"}:${model}`,
        group_label: model,
      },
      {
        label: model,
        subLabel:
          keyRecord?.name ||
          nullableString(row.api_key_id),
        emptyLabel: "未知模型",
        filters: [
          { column: "api_key_id", value: apiKeyId || "" },
          { column: "model", value: nullableString(row.model) || "" },
        ],
        scope,
      },
    );
    return {
      ...base,
      apiKeyId,
      apiKeyPrefix: keyRecord?.prefix || null,
      apiKeyName: keyRecord?.name || nullableString(row.api_key_id) || "未知 Key",
      model,
    };
  });
}

function getApiKeyDailyUsageStats(
  scope: LogScope = {},
): ApiKeyDailyUsageStatsRow[] {
  const recentStartedAt = overviewRecentStartedAt(scope).slice(0, 10);
  const { where, params } = bucketWhere(scope, ["bucket_date >= ?"], [
    recentStartedAt,
  ]);
  const rows = logAll(
    `SELECT
        bucket_date,
        COALESCE(api_key_id, '') AS api_key_id,
        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
        COALESCE(SUM(request_count), 0) AS request_count
       FROM usage_daily_buckets
       ${where}
       GROUP BY bucket_date, COALESCE(api_key_id, '')
       ORDER BY bucket_date DESC
       LIMIT ?`,
    [...params, OVERVIEW_GROUP_LIMIT * OVERVIEW_DAILY_WINDOW_DAYS],
  );
  const keysById = apiKeysById(scope);
  return rows.map((row) => {
    const apiKeyId = nullableString(row.api_key_id);
    const keyRecord = apiKeyId ? keysById.get(apiKeyId) : undefined;
    const requestCount = numberValue(row.request_count);
    const promptTokens = numberValue(row.prompt_tokens);
    const totalTokens = numberValue(row.total_tokens);
    const cachedTokens = numberValue(row.cached_tokens);
    return {
      date: String(row.bucket_date || ""),
      apiKeyId,
      apiKeyPrefix: keyRecord?.prefix || null,
      apiKeyName: keyRecord?.name || "未知 Key",
      requestCount,
      successCount: requestCount,
      errorCount: 0,
      streamCount: 0,
      promptTokens,
      completionTokens: numberValue(row.completion_tokens),
      totalTokens,
      cachedTokens,
      cacheHitRate: cacheHitRate(cachedTokens, promptTokens),
      avgLatencyMs: 0,
      p95LatencyMs: 0,
      avgFirstTokenLatencyMs: 0,
      p95FirstTokenLatencyMs: 0,
      avgTokensPerRequest: average(totalTokens, requestCount),
      tokensPerSecond: 0,
    };
  });
}

function getGroupedUsageStats(
  keyColumn: string,
  _labelColumn: string,
  scope: LogScope = {},
): UsageStatsRow[] {
  const recentStartedAt = overviewRecentStartedAt(scope).slice(0, 10);
  const { where, params } = bucketWhere(scope, ["bucket_date >= ?"], [
    recentStartedAt,
  ]);
  const rows = logAll(
    `${bucketAggregateSelect(keyColumn)}
       ${where}
       GROUP BY COALESCE(${keyColumn}, '')
       ORDER BY total_tokens DESC, request_count DESC
       LIMIT ?`,
    [...params, OVERVIEW_GROUP_LIMIT],
  );
  return rows.map((row) =>
    toUsageStatsRow(row, {
      emptyLabel: "未记录",
      groupColumn: keyColumn,
      scope,
    }),
  );
}

function getDailyUsageStats(scope: LogScope = {}): DailyUsageStatsRow[] {
  const recentStartedAt = overviewRecentStartedAt(scope).slice(0, 10);
  const { where, params } = bucketWhere(scope, ["bucket_date >= ?"], [
    recentStartedAt,
  ]);
  const rows = logAll(
    `SELECT
        bucket_date AS date,
        COALESCE(SUM(request_count), 0) AS request_count,
        COALESCE(SUM(success_count), 0) AS success_count,
        COALESCE(SUM(error_count), 0) AS error_count,
        COALESCE(SUM(stream_count), 0) AS stream_count,
        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
        COALESCE(SUM(total_latency_ms), 0) AS total_latency_ms
      FROM request_daily_buckets
      ${where}
      GROUP BY bucket_date
      ORDER BY date DESC
      LIMIT ?`,
    [...params, OVERVIEW_DAILY_WINDOW_DAYS],
  );
  return rows.map((row) => {
    const requestCount = numberValue(row.request_count);
    const totalTokens = numberValue(row.total_tokens);
    const cachedTokens = numberValue(row.cached_tokens);
    const date = String(row.date || "");
    return {
      date,
      requestCount,
      successCount: numberValue(row.success_count),
      errorCount: numberValue(row.error_count),
      streamCount: numberValue(row.stream_count),
      promptTokens: numberValue(row.prompt_tokens),
      completionTokens: numberValue(row.completion_tokens),
      totalTokens,
      cachedTokens,
      cacheHitRate: cacheHitRate(cachedTokens, numberValue(row.prompt_tokens)),
      avgLatencyMs: Math.round(average(numberValue(row.total_latency_ms), requestCount)),
      p95LatencyMs: 0,
      avgFirstTokenLatencyMs: 0,
      p95FirstTokenLatencyMs: 0,
      avgTokensPerRequest: average(totalTokens, requestCount),
      tokensPerSecond: throughput(totalTokens, row.total_latency_ms),
    };
  });
}

function getDailyDimensionUsageStats(
  dimension: DailyDimensionUsageStatsRow["dimension"],
  keyColumn: string,
  scope: LogScope = {},
): DailyDimensionUsageStatsRow[] {
  const safeKeyColumn = safeLatencyColumnName(keyColumn);
  const recentStartedAt = overviewRecentStartedAt(scope).slice(0, 10);
  const { where, params } = bucketWhere(scope, ["bucket_date >= ?"], [
    recentStartedAt,
  ]);
  const rows = logAll(
    `${bucketAggregateSelect(safeKeyColumn, "bucket_date AS date,")}
       ${where}
       GROUP BY bucket_date, COALESCE(${safeKeyColumn}, '')
       ORDER BY bucket_date DESC, total_tokens DESC, request_count DESC
        LIMIT ?`,
    [...params, OVERVIEW_GROUP_LIMIT * normalizeOverviewDays(scope.days)],
  );
  return rows.map((row) => {
    const dimensionId = nullableString(row.group_key);
    const label = dimensionUsageLabel(dimension, dimensionId, row);
    return {
      ...toUsageStatsRow(row, {
        label,
        subLabel: dimensionId,
        emptyLabel: dimensionEmptyLabel(dimension),
        groupColumn: keyColumn,
        scope,
      }),
      date: String(row.date || ""),
      dimension,
      dimensionId,
      dimensionName: label,
    };
  });
}

function getErrorCodeDailyStats(scope: LogScope = {}): ErrorCodeDailyStatsRow[] {
  const recentStartedAt = overviewRecentStartedAt(scope);
  const { where, params } = overviewWhere(scope, [
    "started_at >= ?",
    "status_code >= 400",
  ], [recentStartedAt]);
  const rows = logAll(
    `SELECT
        relay_date_key(started_at) AS date,
        COALESCE(error_code, 'unknown') AS error_code,
        COALESCE(tenant_id, '') AS tenant_id,
        COALESCE(tenant_name, '') AS tenant_name,
        COUNT(*) AS request_count
       FROM request_logs
       ${where}
       GROUP BY date, COALESCE(error_code, 'unknown'), COALESCE(tenant_id, ''), COALESCE(tenant_name, '')
       ORDER BY date DESC, request_count DESC
       LIMIT ?`,
    [...params, OVERVIEW_GROUP_LIMIT * normalizeOverviewDays(scope.days)],
  );
  return rows.map((row) => ({
    date: String(row.date || ""),
    errorCode: String(row.error_code || "unknown"),
    requestCount: numberValue(row.request_count),
    tenantId: nullableString(row.tenant_id),
    tenantName: nullableString(row.tenant_name),
  }));
}

function dimensionUsageLabel(
  dimension: DailyDimensionUsageStatsRow["dimension"],
  dimensionId: string | null,
  row: Record<string, unknown>,
) {
  if (dimension === "tenant") {
    if (!dimensionId) {
      return "未归属流量";
    }
    return tenantRecordsById().get(dimensionId)?.name || dimensionId;
  }
  if (dimension === "api_key") {
    return (dimensionId && apiKeysById().get(dimensionId)?.name) || dimensionId || "未知 Key";
  }
  const fallback = dimensionEmptyLabel(dimension);
  return nullableString(row.group_label) || dimensionId || fallback;
}

function dimensionEmptyLabel(
  dimension: DailyDimensionUsageStatsRow["dimension"],
) {
  const labels: Record<DailyDimensionUsageStatsRow["dimension"], string> = {
    tenant: "未归属流量",
    api_key: "未知 Key",
    model: "未知模型",
    channel: "未知通道",
    credential: "未知凭据",
    request_type: "未知请求类型",
  };
  return labels[dimension];
}

function buildAdminOverviewAnomalies(input: {
  byDay: DailyUsageStatsRow[];
  byTenant: TenantUsageStatsRow[];
  byChannel: UsageStatsRow[];
  byCredential: UsageStatsRow[];
  totals: AdminOverviewTotals;
}): AdminOverviewAnomaly[] {
  const anomalies: AdminOverviewAnomaly[] = [];
  const today = input.byDay[0];
  const yesterday = input.byDay[1];
  if (today) {
    const errorRate = ratio(today.errorCount, today.requestCount) || 0;
    if (errorRate >= 15) {
      anomalies.push(adminOverviewAnomaly({
        severity: "critical",
        category: "error",
        title: `今日错误率 ${errorRate.toFixed(1)}%`,
        description: `今日错误率 ${errorRate.toFixed(1)}%，共 ${formatInteger(today.errorCount)} 个错误请求。`,
        date: today.date,
        metric: "error_rate",
        value: errorRate,
      }));
    } else if (errorRate >= 5) {
      anomalies.push(adminOverviewAnomaly({
        severity: "warning",
        category: "error",
        title: `今日错误率 ${errorRate.toFixed(1)}%`,
        description: `今日错误率 ${errorRate.toFixed(1)}%，建议查看错误码和通道分布。`,
        date: today.date,
        metric: "error_rate",
        value: errorRate,
      }));
    }
    if (today.avgLatencyMs >= 30_000) {
      anomalies.push(adminOverviewAnomaly({
        severity: "critical",
        category: "latency",
        title: `今日平均延迟 ${formatMilliseconds(today.avgLatencyMs)}`,
        description: `今日平均延迟 ${formatMilliseconds(today.avgLatencyMs)}，可能存在上游或代理瓶颈。`,
        date: today.date,
        metric: "avg_latency_ms",
        value: today.avgLatencyMs,
      }));
    } else if (today.avgLatencyMs >= 10_000) {
      anomalies.push(adminOverviewAnomaly({
        severity: "warning",
        category: "latency",
        title: `今日平均延迟 ${formatMilliseconds(today.avgLatencyMs)}`,
        description: `今日平均延迟 ${formatMilliseconds(today.avgLatencyMs)}。`,
        date: today.date,
        metric: "avg_latency_ms",
        value: today.avgLatencyMs,
      }));
    }
    if (yesterday && yesterday.totalTokens > 0) {
      const tokenGrowth = ((today.totalTokens - yesterday.totalTokens) / yesterday.totalTokens) * 100;
      if (tokenGrowth >= 100 && today.totalTokens >= 10_000) {
        anomalies.push(adminOverviewAnomaly({
          severity: "warning",
          category: "traffic",
          title: "今日 Token 消耗突增",
          description: `今日 Token 较昨日增长 ${tokenGrowth.toFixed(1)}%。`,
          date: today.date,
          metric: "token_growth",
          value: tokenGrowth,
          baseline: yesterday.totalTokens,
        }));
      }
    }
  }

  for (const tenant of input.byTenant.slice(0, 10)) {
    if (tenant.tokenLimitUtilization !== null && tenant.tokenLimitUtilization >= 95) {
      anomalies.push(adminOverviewAnomaly({
        severity: "critical",
        category: "quota",
        title: `${tenant.tenantName} 今日额度使用 ${tenant.tokenLimitUtilization}%`,
        description: `今日已使用 ${formatInteger(tenant.todayTokens)} token，额度利用率 ${tenant.tokenLimitUtilization}%。`,
        tenantId: tenant.tenantId,
        tenantName: tenant.tenantName,
        targetId: tenant.tenantId,
        targetName: tenant.tenantName,
        metric: "tenant_quota_utilization",
        value: tenant.tokenLimitUtilization,
      }));
    } else if (tenant.tokenLimitUtilization !== null && tenant.tokenLimitUtilization >= 80) {
      anomalies.push(adminOverviewAnomaly({
        severity: "warning",
        category: "quota",
        title: `${tenant.tenantName} 今日额度使用 ${tenant.tokenLimitUtilization}%`,
        description: `额度利用率 ${tenant.tokenLimitUtilization}%。`,
        tenantId: tenant.tenantId,
        tenantName: tenant.tenantName,
        targetId: tenant.tenantId,
        targetName: tenant.tenantName,
        metric: "tenant_quota_utilization",
        value: tenant.tokenLimitUtilization,
      }));
    }
  }

  for (const row of [...input.byChannel, ...input.byCredential].slice(0, 30)) {
    const errorRate = ratio(row.errorCount, row.requestCount) || 0;
    if (row.requestCount >= 20 && errorRate >= 10) {
      anomalies.push(adminOverviewAnomaly({
        severity: errorRate >= 25 ? "critical" : "warning",
        category: "routing",
        title: `${row.label || row.key} 错误率 ${errorRate.toFixed(1)}%`,
        description: `最近窗口内 ${formatInteger(row.requestCount)} 次请求，错误率 ${errorRate.toFixed(1)}%。`,
        targetId: row.key,
        targetName: row.label,
        metric: "dimension_error_rate",
        value: errorRate,
      }));
    }
  }

  const unassigned = input.byTenant.find((row) => !row.tenantId);
  if (unassigned && input.totals.requestCount > 0) {
    const unassignedRate = (unassigned.requestCount / input.totals.requestCount) * 100;
    if (unassignedRate >= 5) {
      anomalies.push(adminOverviewAnomaly({
        severity: "warning",
        category: "traffic",
        title: `未归属流量占比 ${unassignedRate.toFixed(1)}%`,
        description: `未归属流量占最近窗口请求的 ${unassignedRate.toFixed(1)}%。`,
        targetName: "未归属流量",
        metric: "unassigned_traffic_rate",
        value: unassignedRate,
      }));
    }
  }

  return anomalies.slice(0, 12);
}

function adminOverviewAnomaly(
  input: Partial<AdminOverviewAnomaly> &
    Pick<
      AdminOverviewAnomaly,
      "severity" | "category" | "title" | "description" | "metric" | "value"
    >,
): AdminOverviewAnomaly {
  return {
    id: `${input.category}:${input.metric}:${input.date || input.targetId || input.targetName || input.title}`,
    severity: input.severity,
    category: input.category,
    title: input.title,
    description: input.description,
    date: input.date ?? null,
    tenantId: input.tenantId ?? null,
    tenantName: input.tenantName ?? null,
    targetId: input.targetId ?? null,
    targetName: input.targetName ?? null,
    metric: input.metric,
    value: input.value,
    baseline: input.baseline ?? null,
  };
}

function bucketAggregateSelect(keyColumn: string, prefix = "") {
  const safeKeyColumn = safeLatencyColumnName(keyColumn);
  return `SELECT
    ${prefix}
    COALESCE(${safeKeyColumn}, '') AS group_key,
    COALESCE(${safeKeyColumn}, '') AS group_label,
    COALESCE(SUM(request_count), 0) AS request_count,
    COALESCE(SUM(success_count), 0) AS success_count,
    COALESCE(SUM(error_count), 0) AS error_count,
    COALESCE(SUM(stream_count), 0) AS stream_count,
    COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
    COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
    COALESCE(SUM(total_tokens), 0) AS total_tokens,
    COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
    COALESCE(SUM(total_latency_ms), 0) AS total_latency_ms,
    MIN(first_request_at) AS first_request_at,
    MAX(last_request_at) AS last_request_at
  FROM request_daily_buckets`;
}

function emptyUsageStatsRow(input: {
  key: string;
  label: string;
  subLabel?: string | null;
}): UsageStatsRow {
  return {
    key: input.key,
    label: input.label,
    subLabel: input.subLabel ?? null,
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    streamCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    cacheHitRate: 0,
    avgLatencyMs: 0,
    p95LatencyMs: 0,
    avgFirstTokenLatencyMs: 0,
    p95FirstTokenLatencyMs: 0,
    avgTokensPerRequest: 0,
    tokensPerSecond: 0,
    firstRequestAt: null,
    lastRequestAt: null,
  };
}

function toUsageStatsRow(
  row: Record<string, unknown>,
  options: {
    label?: string;
    subLabel?: string | null;
    emptyLabel: string;
    groupColumn?: string;
    filters?: Array<{ column: string; value: string }>;
    scope?: LogScope;
  },
): UsageStatsRow {
  const requestCount = numberValue(row.request_count);
  const promptTokens = numberValue(row.prompt_tokens);
  const totalTokens = numberValue(row.total_tokens);
  const cachedTokens = numberValue(row.cached_tokens);
  const firstRequestAt = nullableString(row.first_request_at);
  const lastRequestAt = nullableString(row.last_request_at);
  const avgLatencyMs =
    row.avg_latency_ms === undefined
      ? average(numberValue(row.total_latency_ms), requestCount)
      : Math.round(numberValue(row.avg_latency_ms));
  return {
    key: nullableString(row.group_key) || options.emptyLabel,
    label:
      options.label || nullableString(row.group_label) || options.emptyLabel,
    subLabel:
      options.subLabel === undefined
        ? nullableString(row.group_key)
        : options.subLabel,
    requestCount,
    successCount: numberValue(row.success_count),
    errorCount: numberValue(row.error_count),
    streamCount: numberValue(row.stream_count),
    promptTokens,
    completionTokens: numberValue(row.completion_tokens),
    totalTokens,
    cachedTokens,
    cacheHitRate: cacheHitRate(cachedTokens, promptTokens),
    avgLatencyMs,
    p95LatencyMs: numberValue(row.p95_latency_ms),
    avgFirstTokenLatencyMs: numberValue(row.avg_first_token_latency_ms),
    p95FirstTokenLatencyMs: numberValue(row.p95_first_token_latency_ms),
    avgTokensPerRequest: average(totalTokens, requestCount),
    tokensPerSecond: throughput(totalTokens, row.total_latency_ms),
    firstRequestAt,
    lastRequestAt,
  };
}

function safeLatencyColumnName(name: string) {
  if (!/^[a-z_]+$/i.test(name)) {
    throw new Error("Invalid latency column name");
  }
  return name;
}

function apiKeysById(scope: LogScope = {}) {
  const { where, params } =
    scope.tenantId === undefined
      ? { where: "", params: [] as string[] }
      : scope.tenantId === null
        ? { where: "WHERE tenant_id IS NULL", params: [] as string[] }
        : { where: "WHERE tenant_id = ?", params: [scope.tenantId] };
  const rows = mainAll(
    `SELECT id, name, prefix, enabled, token_limit_daily FROM api_keys ${where}`,
    params,
  ) as Array<{
    id: string;
    name: string;
    prefix: string;
    enabled: number;
    token_limit_daily: number | null;
  }>;
  return new Map(rows.map((row) => [String(row.id), row]));
}

function todayTokensByApiKey(scope: LogScope = {}) {
  const today = instantToDateKey(new Date(), getGlobalTimeZoneSetting());
  const { where, params } = overviewWhere(scope, ["bucket_date = ?"], [today]);
  const rows = logAll(
    `SELECT api_key_id, COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM usage_daily_buckets
       ${where}
       GROUP BY api_key_id`,
    params,
  ) as Array<{ api_key_id: string; total_tokens: number }>;
  return new Map(
    rows.map((row) => [String(row.api_key_id), numberValue(row.total_tokens)]),
  );
}

function tenantRecordsById() {
  const rows = mainAll(
    `SELECT id, name, owner_email, enabled, token_limit_daily
       FROM tenants
       WHERE deleted_at IS NULL`,
  ) as Array<{
    id: string;
    name: string;
    owner_email: string;
    enabled: number;
    token_limit_daily: number | null;
  }>;
  return new Map(rows.map((row) => [String(row.id), row]));
}

function todayTokensByTenantId() {
  const today = instantToDateKey(new Date(), getGlobalTimeZoneSetting());
  const rows = logAll(
    `SELECT tenant_id, COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM usage_daily_buckets
       WHERE bucket_date = ?
       GROUP BY tenant_id`,
    [today],
  ) as Array<{ tenant_id: string; total_tokens: number }>;
  return new Map(
    rows.map((row) => [String(row.tenant_id), numberValue(row.total_tokens)]),
  );
}


function logAll(query: string, params: unknown[] = []) {
  flushLogWriteBarrier();
  return getLogClient().prepare(query).all(...params) as Array<Record<string, unknown>>;
}

function logGet(query: string, params: unknown[] = []) {
  flushLogWriteBarrier();
  return getLogClient().prepare(query).get(...params) as Record<string, unknown> | undefined;
}

function mainAll(query: string, params: unknown[] = []) {
  return getMainClient().prepare(query).all(...params) as Array<Record<string, unknown>>;
}

function overviewRange(daysInput = OVERVIEW_DAILY_WINDOW_DAYS) {
  const days = normalizeOverviewDays(daysInput);
  const to = instantToDateKey(new Date(), getGlobalTimeZoneSetting());
  return { from: addDateKeyDays(to, -days + 1), to, days };
}

function normalizeOverviewDays(days?: number) {
  const parsed = Number(days || OVERVIEW_DAILY_WINDOW_DAYS);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(OVERVIEW_MAX_DAILY_WINDOW_DAYS, Math.floor(parsed)))
    : OVERVIEW_DAILY_WINDOW_DAYS;
}

function overviewRecentStartedAt(scope: LogScope = {}) {
  return new Date(Date.now() - normalizeOverviewDays(scope.days) * 86_400_000)
    .toISOString().slice(0, 10);
}

function average(total: number, count: number) {
  return count > 0 ? Math.round((total / count) * 100) / 100 : 0;
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

function throughput(totalTokens: number, totalLatencyMs: unknown) {
  const latencySeconds = numberValue(totalLatencyMs) / 1000;
  return latencySeconds > 0
    ? Math.round((totalTokens / latencySeconds) * 100) / 100
    : 0;
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
}

function formatMilliseconds(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 ms";
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
}

function cacheHitRate(cachedTokens: number, promptTokens: number) {
  return promptTokens > 0
    ? Math.round((cachedTokens / promptTokens) * 10_000) / 100
    : 0;
}

function numberValue(value: unknown) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function nullableString(value: unknown) {
  return value === null || value === undefined ? null : String(value);
}

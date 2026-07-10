import "server-only";

import {
  and,
  eq,
  lt,
  sql,
  type SQL,
  type SQLChunk,
} from "drizzle-orm";

import {
  getLogOrm,
  getMainOrm,
  setSqliteTimeZone,
} from "@/src/server/db/sqlite";
import { serverConfig } from "@/src/server/config/env";
import {
  auditLogs,
  channelHealthEvents,
  requestLogDetails,
  requestLogs as requestLogsTable,
  usageDailyBuckets,
  usageRecords,
} from "@/src/server/db/schema";
import { jsonStringify, randomId } from "@/src/server/services/crypto";
import type { StageTimingEntry } from "@/src/server/http/stageTimer";
import type {
  ActivityHeatmapStats,
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
  UsageSnapshot,
  UsageStatsRow,
} from "@/src/shared/types/entities";
import { addDateKeyDays, instantToDateKey } from "@/src/shared/time";
import { getGlobalTimeZoneSetting } from "@/src/server/services/settings";

const ADMIN_OVERVIEW_CACHE_TTL_MS = 15_000;
const OVERVIEW_GROUP_LIMIT = 100;
const OVERVIEW_DAILY_WINDOW_DAYS = 30;
const OVERVIEW_MAX_DAILY_WINDOW_DAYS = 90;
const DEFAULT_HEATMAP_WEEKS = 53;
const MAX_HEATMAP_WEEKS = 53;

let adminOverviewCache: {
  expiresAt: number;
  value: AdminOverviewStats;
} | null = null;
let usageHealthCache = new Map<
  string,
  {
    expiresAt: number;
    value: Record<string, CodexAccountUsageHealth>;
  }
>();

type LogScope = {
  tenantId?: string | null;
  days?: number;
};

function boundSql(query: string, params: unknown[] = []): SQL {
  const parts = query.split("?");
  if (parts.length - 1 !== params.length) {
    throw new Error("SQL parameter count mismatch");
  }
  const chunks: SQLChunk[] = [];
  for (const [index, part] of parts.entries()) {
    if (part) {
      chunks.push(sql.raw(part));
    }
    if (index < params.length) {
      chunks.push(sql`${params[index]}`);
    }
  }
  return sql.join(chunks);
}

function logAll(query: string, params: unknown[] = []) {
  return getLogOrm().all(boundSql(query, params)) as Array<
    Record<string, unknown>
  >;
}

function logGet(query: string, params: unknown[] = []) {
  return getLogOrm().get(boundSql(query, params)) as
    | Record<string, unknown>
    | undefined;
}

function logRun(query: string, params: unknown[] = []) {
  return getLogOrm().run(boundSql(query, params)) as unknown as {
    changes: number | bigint;
  };
}

function mainAll(query: string, params: unknown[] = []) {
  return getMainOrm().all(boundSql(query, params)) as Array<
    Record<string, unknown>
  >;
}

export interface RequestLogInput {
  startedAt: string;
  completedAt?: string;
  method: string;
  path: string;
  requestType: string;
  stream: boolean;
  model?: string;
  statusCode: number;
  latencyMs: number;
  tenantId?: string | null;
  tenantName?: string | null;
  apiKeyId?: string | null;
  apiKeyPrefix?: string | null;
  apiKeyName?: string | null;
  channelId?: string | null;
  channelName?: string | null;
  credentialId?: string | null;
  credentialEmail?: string | null;
  usage?: UsageSnapshot;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface PruneRequestLogsInput {
  summaryRetentionDays: number;
  detailRetentionDays: number;
  vacuum?: boolean;
}

export interface PruneRequestLogsResult {
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
}

export interface RequestLogDetailInput {
  requestHeaders?: Record<string, string> | null;
  requestBodyText?: string | null;
  requestBodyTruncated?: boolean;
  requestBodyBytes?: number;
  forwardedBodyText?: string | null;
  forwardedBodyTruncated?: boolean;
  forwardedBodyBytes?: number;
  upstreamStatusCode?: number | null;
  upstreamHeaders?: Record<string, string> | null;
  upstreamBodyText?: string | null;
  upstreamBodyTruncated?: boolean;
  upstreamBodyBytes?: number;
  errorName?: string | null;
  errorMessage?: string | null;
  errorStack?: string | null;
  errorCause?: unknown;
  detail?: unknown;
  stageTimings?: StageTimingEntry[];
}

export function appendRequestLog(input: RequestLogInput) {
  const usage = normalizeUsageSnapshot(input.usage);
  const completedAt = input.completedAt || new Date().toISOString();
  const id = randomId("reqlog");
  getLogOrm()
    .insert(requestLogsTable)
    .values({
      id,
      startedAt: input.startedAt,
      completedAt,
      method: input.method,
      path: input.path,
      requestType: input.requestType,
      stream: input.stream ? 1 : 0,
      model: input.model || "",
      statusCode: input.statusCode,
      latencyMs: input.latencyMs,
      tenantId: input.tenantId || null,
      tenantName: input.tenantName || null,
      apiKeyId: input.apiKeyId || null,
      apiKeyPrefix: input.apiKeyPrefix || null,
      apiKeyName: input.apiKeyName || null,
      channelId: input.channelId || null,
      channelName: input.channelName || null,
      credentialId: input.credentialId || null,
      credentialEmail: input.credentialEmail || null,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      cachedTokens: usage.cachedTokens,
      errorCode: input.errorCode || null,
      errorMessage: input.errorMessage || null,
    })
    .run();

  if (usage.totalTokens > 0) {
    appendUsageRecord({
      createdAt: completedAt,
      apiKeyId: input.apiKeyId,
      apiKeyPrefix: input.apiKeyPrefix,
      apiKeyName: input.apiKeyName,
      tenantId: input.tenantId,
      tenantName: input.tenantName,
      channelId: input.channelId,
      channelName: input.channelName,
      credentialId: input.credentialId,
      credentialEmail: input.credentialEmail,
      model: input.model || "",
      usage,
    });
  }

  return id;
}

export function appendRequestLogDetail(
  requestLogId: string,
  input: RequestLogDetailInput,
) {
  const now = new Date().toISOString();
  const values = {
    requestLogId,
    createdAt: now,
    updatedAt: now,
    requestHeadersJson: input.requestHeaders
      ? jsonStringify(input.requestHeaders)
      : null,
    requestBodyText: input.requestBodyText ?? null,
    requestBodyTruncated: input.requestBodyTruncated ? 1 : 0,
    requestBodyBytes: Math.max(0, Math.floor(input.requestBodyBytes || 0)),
    forwardedBodyText: input.forwardedBodyText ?? null,
    forwardedBodyTruncated: input.forwardedBodyTruncated ? 1 : 0,
    forwardedBodyBytes: Math.max(0, Math.floor(input.forwardedBodyBytes || 0)),
    upstreamStatusCode: input.upstreamStatusCode ?? null,
    upstreamHeadersJson: input.upstreamHeaders
      ? jsonStringify(input.upstreamHeaders)
      : null,
    upstreamBodyText: input.upstreamBodyText ?? null,
    upstreamBodyTruncated: input.upstreamBodyTruncated ? 1 : 0,
    upstreamBodyBytes: Math.max(0, Math.floor(input.upstreamBodyBytes || 0)),
    errorName: input.errorName || null,
    errorMessage: input.errorMessage || null,
    errorStack: input.errorStack || null,
    errorCauseJson:
      input.errorCause === undefined ? null : safeDetailJson(input.errorCause),
    detailJson: input.detail === undefined ? null : safeDetailJson(input.detail),
    stageTimingsJson: input.stageTimings
      ? jsonStringify(input.stageTimings)
      : null,
  };
  getLogOrm()
    .insert(requestLogDetails)
    .values(values)
    .onConflictDoUpdate({
      target: requestLogDetails.requestLogId,
      set: {
        updatedAt: values.updatedAt,
        requestHeadersJson: sql`COALESCE(excluded.request_headers_json, ${requestLogDetails.requestHeadersJson})`,
        requestBodyText: sql`COALESCE(excluded.request_body_text, ${requestLogDetails.requestBodyText})`,
        requestBodyTruncated: sql`CASE WHEN excluded.request_body_text IS NULL THEN ${requestLogDetails.requestBodyTruncated} ELSE excluded.request_body_truncated END`,
        requestBodyBytes: sql`CASE WHEN excluded.request_body_text IS NULL THEN ${requestLogDetails.requestBodyBytes} ELSE excluded.request_body_bytes END`,
        forwardedBodyText: sql`COALESCE(excluded.forwarded_body_text, ${requestLogDetails.forwardedBodyText})`,
        forwardedBodyTruncated: sql`CASE WHEN excluded.forwarded_body_text IS NULL THEN ${requestLogDetails.forwardedBodyTruncated} ELSE excluded.forwarded_body_truncated END`,
        forwardedBodyBytes: sql`CASE WHEN excluded.forwarded_body_text IS NULL THEN ${requestLogDetails.forwardedBodyBytes} ELSE excluded.forwarded_body_bytes END`,
        upstreamStatusCode: sql`COALESCE(excluded.upstream_status_code, ${requestLogDetails.upstreamStatusCode})`,
        upstreamHeadersJson: sql`COALESCE(excluded.upstream_headers_json, ${requestLogDetails.upstreamHeadersJson})`,
        upstreamBodyText: sql`COALESCE(excluded.upstream_body_text, ${requestLogDetails.upstreamBodyText})`,
        upstreamBodyTruncated: sql`CASE WHEN excluded.upstream_body_text IS NULL THEN ${requestLogDetails.upstreamBodyTruncated} ELSE excluded.upstream_body_truncated END`,
        upstreamBodyBytes: sql`CASE WHEN excluded.upstream_body_text IS NULL THEN ${requestLogDetails.upstreamBodyBytes} ELSE excluded.upstream_body_bytes END`,
        errorName: sql`COALESCE(excluded.error_name, ${requestLogDetails.errorName})`,
        errorMessage: sql`COALESCE(excluded.error_message, ${requestLogDetails.errorMessage})`,
        errorStack: sql`COALESCE(excluded.error_stack, ${requestLogDetails.errorStack})`,
        errorCauseJson: sql`COALESCE(excluded.error_cause_json, ${requestLogDetails.errorCauseJson})`,
        detailJson: sql`COALESCE(excluded.detail_json, ${requestLogDetails.detailJson})`,
        stageTimingsJson: sql`COALESCE(excluded.stage_timings_json, ${requestLogDetails.stageTimingsJson})`,
      },
    })
    .run();
}

export function appendUsageRecord(input: {
  createdAt: string;
  tenantId?: string | null;
  tenantName?: string | null;
  apiKeyId?: string | null;
  apiKeyPrefix?: string | null;
  apiKeyName?: string | null;
  channelId?: string | null;
  channelName?: string | null;
  credentialId?: string | null;
  credentialEmail?: string | null;
  model: string;
  usage: UsageSnapshot;
}) {
  getLogOrm()
    .insert(usageRecords)
    .values({
      id: randomId("usage"),
      createdAt: input.createdAt,
      tenantId: input.tenantId || null,
      tenantName: input.tenantName || null,
      apiKeyId: input.apiKeyId || null,
      apiKeyPrefix: input.apiKeyPrefix || null,
      apiKeyName: input.apiKeyName || null,
      channelId: input.channelId || null,
      channelName: input.channelName || null,
      credentialId: input.credentialId || null,
      credentialEmail: input.credentialEmail || null,
      model: input.model,
      promptTokens: input.usage.promptTokens,
      completionTokens: input.usage.completionTokens,
      totalTokens: input.usage.totalTokens,
      cachedTokens: input.usage.cachedTokens,
    })
    .run();

  const day = instantToDateKey(input.createdAt, getGlobalTimeZoneSetting());
  getLogOrm()
    .insert(usageDailyBuckets)
    .values({
      bucketDate: day,
      tenantId: input.tenantId || "",
      apiKeyId: input.apiKeyId || "",
      channelId: input.channelId || "",
      credentialId: input.credentialId || "",
      model: input.model,
      promptTokens: input.usage.promptTokens,
      completionTokens: input.usage.completionTokens,
      totalTokens: input.usage.totalTokens,
      cachedTokens: input.usage.cachedTokens,
      requestCount: 1,
      updatedAt: input.createdAt,
    })
    .onConflictDoUpdate({
      target: [
        usageDailyBuckets.bucketDate,
        usageDailyBuckets.apiKeyId,
        usageDailyBuckets.channelId,
        usageDailyBuckets.credentialId,
        usageDailyBuckets.model,
      ],
      set: {
        promptTokens: sql`${usageDailyBuckets.promptTokens} + excluded.prompt_tokens`,
        completionTokens: sql`${usageDailyBuckets.completionTokens} + excluded.completion_tokens`,
        totalTokens: sql`${usageDailyBuckets.totalTokens} + excluded.total_tokens`,
        cachedTokens: sql`${usageDailyBuckets.cachedTokens} + excluded.cached_tokens`,
        requestCount: sql`${usageDailyBuckets.requestCount} + 1`,
        updatedAt: input.createdAt,
      },
    })
    .run();
}

export function rebuildDailyAggregates(timeZone: string) {
  const previousTimeZone = getGlobalTimeZoneSetting();
  setSqliteTimeZone(timeZone);
  try {
    getLogOrm().transaction(() => {
      logRun("DELETE FROM request_daily_buckets");
      logRun(`INSERT INTO request_daily_buckets (
          bucket_date, tenant_id, api_key_id, model, channel_id, credential_id,
          request_type, request_count, success_count, error_count, stream_count,
          prompt_tokens, completion_tokens, total_tokens, cached_tokens,
          total_latency_ms, first_request_at, last_request_at, updated_at
        )
        SELECT
          relay_date_key(started_at), COALESCE(tenant_id, ''),
          COALESCE(api_key_id, ''), COALESCE(model, ''),
          COALESCE(channel_id, ''), COALESCE(credential_id, ''),
          COALESCE(request_type, ''), COUNT(*),
          SUM(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END),
          SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END),
          SUM(stream), COALESCE(SUM(prompt_tokens), 0),
          COALESCE(SUM(completion_tokens), 0), COALESCE(SUM(total_tokens), 0),
          COALESCE(SUM(cached_tokens), 0), COALESCE(SUM(latency_ms), 0),
          MIN(started_at), MAX(started_at), MAX(completed_at)
        FROM request_logs
        GROUP BY relay_date_key(started_at), tenant_id, api_key_id, model,
          channel_id, credential_id, request_type`);

      logRun("DELETE FROM usage_daily_buckets");
      logRun(`INSERT INTO usage_daily_buckets (
          bucket_date, tenant_id, api_key_id, channel_id, credential_id, model,
          prompt_tokens, completion_tokens, total_tokens, cached_tokens,
          request_count, updated_at
        )
        SELECT relay_date_key(created_at), COALESCE(tenant_id, ''),
          COALESCE(api_key_id, ''), COALESCE(channel_id, ''),
          COALESCE(credential_id, ''), COALESCE(model, ''),
          COALESCE(SUM(prompt_tokens), 0), COALESCE(SUM(completion_tokens), 0),
          COALESCE(SUM(total_tokens), 0), COALESCE(SUM(cached_tokens), 0),
          COUNT(*), MAX(created_at)
        FROM usage_records
        GROUP BY relay_date_key(created_at), tenant_id, api_key_id,
          channel_id, credential_id, model`);
    });
  } catch (error) {
    setSqliteTimeZone(previousTimeZone);
    throw error;
  }
}

export function pruneRequestLogs(
  input: PruneRequestLogsInput,
): PruneRequestLogsResult {
  const summaryRetentionDays = normalizeRetentionDays(
    input.summaryRetentionDays,
  );
  const detailRetentionDays = normalizeRetentionDays(input.detailRetentionDays);
  const summaryCutoff = retentionCutoff(summaryRetentionDays);
  const detailCutoff = retentionCutoff(detailRetentionDays);
  const deleted = {
    requestLogDetails: 0,
    requestLogs: 0,
    usageRecords: 0,
    usageDailyBuckets: 0,
    channelHealthEvents: 0,
  };

  getLogOrm().transaction(() => {
    deleted.requestLogDetails += changedRows(
      runResult(getLogOrm()
        .delete(requestLogDetails)
        .where(lt(requestLogDetails.createdAt, detailCutoff))
        .run()),
    );
    deleted.requestLogDetails += changedRows(
      logRun(
        `DELETE FROM request_log_details
         WHERE request_log_id IN (
           SELECT id FROM request_logs WHERE started_at < ?
         )`,
        [summaryCutoff],
      ),
    );
    deleted.requestLogs = changedRows(
      runResult(getLogOrm()
        .delete(requestLogsTable)
        .where(lt(requestLogsTable.startedAt, summaryCutoff))
        .run()),
    );
    deleted.usageRecords = changedRows(
      runResult(getLogOrm()
        .delete(usageRecords)
        .where(lt(usageRecords.createdAt, summaryCutoff))
        .run()),
    );
    deleted.usageDailyBuckets = changedRows(
      runResult(getLogOrm()
        .delete(usageDailyBuckets)
        .where(lt(usageDailyBuckets.bucketDate, summaryCutoff.slice(0, 10)))
        .run()),
    );
    deleted.requestLogDetails += changedRows(
      logRun(
        `DELETE FROM request_log_details
         WHERE NOT EXISTS (
           SELECT 1 FROM request_logs
           WHERE request_logs.id = request_log_details.request_log_id
         )`,
      ),
    );
    deleted.channelHealthEvents = changedRows(
      runResult(getLogOrm()
        .delete(channelHealthEvents)
        .where(lt(channelHealthEvents.createdAt, summaryCutoff))
        .run()),
    );
  });

  if (input.vacuum) {
    getLogOrm().run(sql.raw("VACUUM"));
  }

  adminOverviewCache = null;
  return {
    summaryRetentionDays,
    detailRetentionDays,
    summaryCutoff,
    detailCutoff,
    deletedRequestLogDetails: deleted.requestLogDetails,
    deletedRequestLogs: deleted.requestLogs,
    deletedUsageRecords: deleted.usageRecords,
    deletedUsageDailyBuckets: deleted.usageDailyBuckets,
    deletedChannelHealthEvents: deleted.channelHealthEvents,
    vacuumed: Boolean(input.vacuum),
  };
}

export function appendChannelHealthEvent(input: {
  channelId: string;
  channelName?: string;
  credentialId?: string | null;
  eventType: string;
  statusCode?: number | null;
  healthScore?: number | null;
  cooldownUntil?: string | null;
  message?: string | null;
}) {
  getLogOrm()
    .insert(channelHealthEvents)
    .values({
      id: randomId("chevt"),
      createdAt: new Date().toISOString(),
      channelId: input.channelId,
      channelName: input.channelName || "",
      credentialId: input.credentialId || null,
      eventType: input.eventType,
      statusCode: input.statusCode ?? null,
      healthScore: input.healthScore ?? null,
      cooldownUntil: input.cooldownUntil || null,
      message: input.message || null,
    })
    .run();
}

export function appendAuditLog(input: {
  action: string;
  actorType?: string;
  actorId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  detail?: Record<string, unknown>;
}) {
  getLogOrm()
    .insert(auditLogs)
    .values({
      id: randomId("audit"),
      createdAt: new Date().toISOString(),
      actorType: input.actorType || "system",
      actorId: input.actorId || null,
      action: input.action,
      targetType: input.targetType || null,
      targetId: input.targetId || null,
      detailJson: jsonStringify(input.detail || {}),
    })
    .run();
}

export function transferApiKeyLogScope(input: {
  apiKeyId: string;
  tenantId: string;
  tenantName: string;
}) {
  const migratedRequestLogs = changedRows(
    runResult(getLogOrm()
      .update(requestLogsTable)
      .set({ tenantId: input.tenantId, tenantName: input.tenantName })
      .where(eq(requestLogsTable.apiKeyId, input.apiKeyId))
      .run()),
  );
  const migratedUsageRecords = changedRows(
    runResult(getLogOrm()
      .update(usageRecords)
      .set({ tenantId: input.tenantId, tenantName: input.tenantName })
      .where(eq(usageRecords.apiKeyId, input.apiKeyId))
      .run()),
  );
  const migratedUsageDailyBuckets = changedRows(
    runResult(getLogOrm()
      .update(usageDailyBuckets)
      .set({ tenantId: input.tenantId })
      .where(eq(usageDailyBuckets.apiKeyId, input.apiKeyId))
      .run()),
  );

  adminOverviewCache = null;
  return {
    requestLogs: migratedRequestLogs,
    usageRecords: migratedUsageRecords,
    usageDailyBuckets: migratedUsageDailyBuckets,
  };
}

export function getApiKeyDailyUsage(apiKeyId: string, day = new Date()) {
  const bucketDate = instantToDateKey(day, getGlobalTimeZoneSetting());
  const row = getLogOrm()
    .select({
      totalTokens: sql<number>`COALESCE(SUM(${usageDailyBuckets.totalTokens}), 0)`,
    })
    .from(usageDailyBuckets)
    .where(
      and(
        eq(usageDailyBuckets.bucketDate, bucketDate),
        eq(usageDailyBuckets.apiKeyId, apiKeyId),
      ),
    )
    .get();
  return Number(row?.totalTokens || 0);
}

export function getTenantDailyUsage(tenantId: string, day = new Date()) {
  const bucketDate = instantToDateKey(day, getGlobalTimeZoneSetting());
  const row = getLogOrm()
    .select({
      totalTokens: sql<number>`COALESCE(SUM(${usageDailyBuckets.totalTokens}), 0)`,
    })
    .from(usageDailyBuckets)
    .where(
      and(
        eq(usageDailyBuckets.bucketDate, bucketDate),
        eq(usageDailyBuckets.tenantId, tenantId),
      ),
    )
    .get();
  return Number(row?.totalTokens || 0);
}

export function getApiKeyRequestCountSince(apiKeyId: string, since: Date) {
  const row = logGet(
    `SELECT COUNT(*) AS request_count
     FROM request_logs
     WHERE api_key_id = ? AND started_at >= ?`,
    [apiKeyId, since.toISOString()],
  );
  return Number(row?.request_count || 0);
}

export function getTenantRequestCountSince(tenantId: string, since: Date) {
  const row = logGet(
    `SELECT COUNT(*) AS request_count
     FROM request_logs
     WHERE tenant_id = ? AND started_at >= ?`,
    [tenantId, since.toISOString()],
  );
  return Number(row?.request_count || 0);
}

export interface ActivityHeatmapQueryInput {
  apiKeyId?: string | null;
  apiKeyName?: string | null;
  apiKeyPrefix?: string | null;
  endDate?: Date;
  weeks?: number;
}

export function getActivityHeatmapStats(
  input: ActivityHeatmapQueryInput = {},
): ActivityHeatmapStats {
  const weeks = normalizeHeatmapWeeks(input.weeks);
  const endDateKey = instantToDateKey(
    input.endDate || new Date(),
    getGlobalTimeZoneSetting(),
  );
  const weekStart = addDateKeyDays(endDateKey, -calendarWeekday(endDateKey));
  const startDateKey = addDateKeyDays(weekStart, -(weeks - 1) * 7);
  const endExclusive = addDateKeyDays(endDateKey, 1);
  const apiKeyId = cleanNullableString(input.apiKeyId);
  const conditions = ["started_at >= ?", "started_at < ?"];
  const params: string[] = [startDateKey, endExclusive];
  if (apiKeyId) {
    conditions.push("api_key_id = ?");
    params.push(apiKeyId);
  }

  const rows = logAll(
    `SELECT
        relay_date_key(started_at) AS date,
        COUNT(*) AS request_count,
        SUM(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS error_count,
        SUM(stream) AS stream_count,
        COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM request_logs
       WHERE ${conditions.join(" AND ")}
       GROUP BY relay_date_key(started_at)`,
    params,
  );

  const rowsByDate = new Map(rows.map((row) => [String(row.date || ""), row]));
  const rawDays = Array.from({ length: weeks * 7 }, (_, index) => {
    const date = addDateKeyDays(startDateKey, index);
    if (date > endDateKey) {
      return null;
    }
    const row = rowsByDate.get(date);
    return {
      date,
      requestCount: numberValue(row?.request_count),
      successCount: numberValue(row?.success_count),
      errorCount: numberValue(row?.error_count),
      streamCount: numberValue(row?.stream_count),
      totalTokens: numberValue(row?.total_tokens),
      level: 0,
    };
  }).filter((day): day is ActivityHeatmapStats["days"][number] =>
    Boolean(day),
  );

  const maxRequests = Math.max(
    0,
    ...rawDays.map((day) => day.requestCount),
  );
  const days = rawDays.map((day) => ({
    ...day,
    level: activityHeatmapLevel(day.requestCount, maxRequests),
  }));
  const streaks = activityHeatmapStreaks(days);

  return {
    generatedAt: new Date().toISOString(),
    scope: apiKeyId ? "api_key" : "site",
    apiKeyId: apiKeyId || null,
    apiKeyName: cleanNullableString(input.apiKeyName),
    apiKeyPrefix: cleanNullableString(input.apiKeyPrefix),
    from: startDateKey,
    to: endDateKey,
    weeks,
    days,
    totalRequests: days.reduce((total, day) => total + day.requestCount, 0),
    totalTokens: days.reduce((total, day) => total + day.totalTokens, 0),
    activeDays: days.filter((day) => day.requestCount > 0).length,
    maxRequests,
    currentStreakDays: streaks.current,
    longestStreakDays: streaks.longest,
  };
}

export interface PublicRequestLogRow {
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
  cache_hit_rate: number;
  error_code: string | null;
}

export interface PublicRequestLogDetail {
  log: PublicRequestLogRow & {
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
    stage_timings: StageTimingEntry[];
    created_at: string | null;
    updated_at: string | null;
  } | null;
}

export function latestRequestLogs(limit = 20): PublicRequestLogRow[] {
  return queryRequestLogs({ limit, offset: 0, skipTotal: true }).data;
}

export type RequestLogStatusFilter = "all" | "success" | "error" | "stream";

export interface RequestLogQueryInput {
  limit?: number;
  offset?: number;
  query?: string;
  status?: RequestLogStatusFilter;
  tenantId?: string | null;
  includeSummary?: boolean;
  skipTotal?: boolean;
}

export interface RequestLogQueryResult {
  data: PublicRequestLogRow[];
  limit: number;
  offset: number;
  total: number;
  errorCount: number;
  totalTokens: number;
  cachedTokens: number;
  cacheHitRate: number;
  avgLatencyMs: number;
}

export function getRequestLogDetail(
  id: string,
  input: { tenantId?: string | null } = {},
): PublicRequestLogDetail | null {
  const tenantWhere =
    input.tenantId === undefined
      ? ""
      : input.tenantId === null
        ? "AND tenant_id IS NULL"
        : "AND tenant_id = ?";
  const params =
    input.tenantId === undefined || input.tenantId === null
      ? [id]
      : [id, input.tenantId];
  const row = logGet(
    `SELECT
        id, started_at, completed_at, method, path, request_type, stream,
        model, status_code, latency_ms,
        ${firstTokenLatencySelect("request_logs")},
        tenant_id, tenant_name, api_key_id, api_key_prefix, api_key_name, channel_name,
        credential_email, prompt_tokens, completion_tokens, total_tokens,
        cached_tokens, error_code, error_message
      FROM request_logs
      WHERE id = ? ${tenantWhere}`,
    params,
  );
  if (!row) {
    return null;
  }

  const detailRow = logGet(
    `SELECT
        created_at, updated_at, request_headers_json, request_body_text,
        request_body_truncated, request_body_bytes, forwarded_body_text,
        forwarded_body_truncated, forwarded_body_bytes, upstream_status_code,
        upstream_headers_json, upstream_body_text, upstream_body_truncated,
        upstream_body_bytes, error_name, error_message, error_stack,
        error_cause_json, detail_json, stage_timings_json
      FROM request_log_details
      WHERE request_log_id = ?`,
    [id],
  );

  return {
    log: {
      ...toPublicRequestLogRow(attachApiKeyNames([row])[0] || row),
      completed_at: String(row.completed_at || ""),
      error_message: nullableString(row.error_message),
    },
    detail: detailRow ? toPublicRequestLogDetailRow(detailRow) : null,
  };
}

export function queryRequestLogs(
  input: RequestLogQueryInput = {},
): RequestLogQueryResult {
  const limit = Math.max(1, Math.floor(input.limit || 20));
  const offset = Math.max(0, Math.floor(input.offset || 0));
  const { where, params } = requestLogWhere(input);
  const rows = logAll(
    `SELECT
        id, started_at, method, path, request_type, stream, model,
        status_code, latency_ms,
        ${firstTokenLatencySelect("request_logs")},
        tenant_id, tenant_name, api_key_id, api_key_prefix, api_key_name, channel_name,
        credential_email, prompt_tokens, completion_tokens, total_tokens,
        cached_tokens, error_code
      FROM request_logs
      ${where}
      ORDER BY started_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const publicRows = attachApiKeyNames(rows).map(toPublicRequestLogRow);
  const pageSummary = input.includeSummary
    ? summarizeRequestLogs(where, params)
    : summarizeRequestLogRows(publicRows);

  return {
    data: publicRows,
    limit,
    offset,
    total: input.skipTotal
      ? publicRows.length
      : countRequestLogs(where, params),
    errorCount: pageSummary.errorCount,
    totalTokens: pageSummary.totalTokens,
    cachedTokens: pageSummary.cachedTokens,
    cacheHitRate: pageSummary.cacheHitRate,
    avgLatencyMs: pageSummary.avgLatencyMs,
  };
}

function countRequestLogs(where: string, params: string[]) {
  const row = logGet(`SELECT COUNT(*) AS total FROM request_logs ${where}`, params);
  return numberValue(row?.total);
}

function summarizeRequestLogs(where: string, params: string[]) {
  const summary = logGet(
    `SELECT
        SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS error_count,
        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
        COALESCE(AVG(latency_ms), 0) AS avg_latency_ms
      FROM request_logs
      ${where}`,
    params,
  );
  const promptTokens = numberValue(summary?.prompt_tokens);
  const totalTokens = numberValue(summary?.total_tokens);
  const cachedTokens = numberValue(summary?.cached_tokens);
  return {
    errorCount: numberValue(summary?.error_count),
    totalTokens,
    cachedTokens,
    cacheHitRate: cacheHitRate(cachedTokens, promptTokens),
    avgLatencyMs: Math.round(numberValue(summary?.avg_latency_ms)),
  };
}

function summarizeRequestLogRows(rows: PublicRequestLogRow[]) {
  const errorCount = rows.filter((row) => row.status_code >= 400).length;
  const promptTokens = rows.reduce(
    (total, row) => total + row.prompt_tokens,
    0,
  );
  const totalTokens = rows.reduce((total, row) => total + row.total_tokens, 0);
  const cachedTokens = rows.reduce(
    (total, row) => total + row.cached_tokens,
    0,
  );
  const totalLatencyMs = rows.reduce((total, row) => total + row.latency_ms, 0);
  return {
    errorCount,
    totalTokens,
    cachedTokens,
    cacheHitRate: cacheHitRate(cachedTokens, promptTokens),
    avgLatencyMs:
      rows.length > 0 ? Math.round(totalLatencyMs / rows.length) : 0,
  };
}

function requestLogWhere(input: RequestLogQueryInput) {
  const conditions: string[] = [];
  const params: string[] = [];
  if (input.tenantId !== undefined) {
    if (input.tenantId === null) {
      conditions.push("tenant_id IS NULL");
    } else {
      conditions.push("tenant_id = ?");
      params.push(input.tenantId);
    }
  }
  if (input.status === "success") {
    conditions.push("status_code >= 200 AND status_code < 400");
  } else if (input.status === "error") {
    conditions.push("status_code >= 400");
  } else if (input.status === "stream") {
    conditions.push("stream = 1");
  }

  const query = String(input.query || "").trim();
  if (query) {
    const like = `%${query.toLowerCase()}%`;
    conditions.push(
      `(
        lower(method) LIKE ? OR
        lower(path) LIKE ? OR
        lower(request_type) LIKE ? OR
        lower(model) LIKE ? OR
        lower(tenant_id) LIKE ? OR
        lower(tenant_name) LIKE ? OR
        lower(api_key_prefix) LIKE ? OR
        lower(api_key_name) LIKE ? OR
        lower(channel_name) LIKE ? OR
        lower(credential_email) LIKE ? OR
        lower(error_code) LIKE ? OR
        lower(error_message) LIKE ? OR
        CAST(status_code AS TEXT) LIKE ? OR
        EXISTS (
          SELECT 1
          FROM request_log_details
          WHERE request_log_details.request_log_id = request_logs.id
            AND (
              lower(request_log_details.request_body_text) LIKE ? OR
              lower(request_log_details.forwarded_body_text) LIKE ? OR
              lower(request_log_details.upstream_body_text) LIKE ? OR
              lower(request_log_details.error_message) LIKE ? OR
              lower(request_log_details.error_stack) LIKE ? OR
              lower(request_log_details.detail_json) LIKE ?
            )
        )
      )`,
    );
    params.push(
      like,
      like,
      like,
      like,
      like,
      like,
      like,
      like,
      like,
      like,
      like,
      like,
      like,
      like,
      like,
      like,
      like,
      like,
      like,
    );
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
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
        title: "今日错误率严重偏高",
        description: `今日错误率 ${errorRate.toFixed(1)}%，共 ${formatInteger(today.errorCount)} 个错误请求。`,
        date: today.date,
        metric: "error_rate",
        value: errorRate,
      }));
    } else if (errorRate >= 5) {
      anomalies.push(adminOverviewAnomaly({
        severity: "warning",
        category: "error",
        title: "今日错误率偏高",
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
        title: "今日平均延迟严重偏高",
        description: `今日平均延迟 ${formatMilliseconds(today.avgLatencyMs)}，可能存在上游或代理瓶颈。`,
        date: today.date,
        metric: "avg_latency_ms",
        value: today.avgLatencyMs,
      }));
    } else if (today.avgLatencyMs >= 10_000) {
      anomalies.push(adminOverviewAnomaly({
        severity: "warning",
        category: "latency",
        title: "今日平均延迟偏高",
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
        title: `${tenant.tenantName} 接近或已达到今日额度`,
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
        title: `${tenant.tenantName} 今日额度使用较高`,
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
        title: `${row.label || row.key} 错误率偏高`,
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
        title: "未归属流量占比较高",
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

function normalizeHeatmapWeeks(value: unknown) {
  const weeks = Number(value || DEFAULT_HEATMAP_WEEKS);
  if (!Number.isFinite(weeks)) {
    return DEFAULT_HEATMAP_WEEKS;
  }
  return Math.max(1, Math.min(MAX_HEATMAP_WEEKS, Math.floor(weeks)));
}

function activityHeatmapLevel(count: number, max: number) {
  if (count <= 0 || max <= 0) {
    return 0;
  }
  return Math.max(1, Math.min(4, Math.ceil(Math.sqrt(count / max) * 4)));
}

function activityHeatmapStreaks(days: ActivityHeatmapStats["days"]) {
  let current = 0;
  let longest = 0;
  for (const day of days) {
    if (day.requestCount > 0) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return { current, longest };
}

function calendarWeekday(dateKey: string) {
  return new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
}

function cleanNullableString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function changedRows(result: { changes: number | bigint }) {
  return Number(result.changes || 0);
}

function runResult(result: unknown) {
  return result as { changes: number | bigint };
}

function normalizeRetentionDays(days: number) {
  if (!Number.isFinite(days)) {
    throw new Error("Retention days must be finite");
  }
  return Math.max(1, Math.floor(days));
}

function retentionCutoff(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function overviewRange(daysInput = OVERVIEW_DAILY_WINDOW_DAYS) {
  const days = normalizeOverviewDays(daysInput);
  const to = instantToDateKey(new Date(), getGlobalTimeZoneSetting());
  return {
    from: addDateKeyDays(to, -days + 1),
    to,
    days,
  };
}

function normalizeOverviewDays(days?: number) {
  const parsed = Number(days || OVERVIEW_DAILY_WINDOW_DAYS);
  if (!Number.isFinite(parsed)) {
    return OVERVIEW_DAILY_WINDOW_DAYS;
  }
  return Math.max(1, Math.min(OVERVIEW_MAX_DAILY_WINDOW_DAYS, Math.floor(parsed)));
}

function overviewRecentStartedAt(scope: LogScope = {}) {
  return new Date(Date.now() - normalizeOverviewDays(scope.days) * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function average(total: number, count: number) {
  return count > 0 ? Math.round((total / count) * 100) / 100 : 0;
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

function throughput(totalTokens: number, totalLatencyMs: unknown) {
  const latencySeconds = numberValue(totalLatencyMs) / 1000;
  if (latencySeconds <= 0) {
    return 0;
  }
  return Math.round((totalTokens / latencySeconds) * 100) / 100;
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatMilliseconds(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 ms";
  }
  if (value < 1000) {
    return `${Math.round(value)} ms`;
  }
  return `${(value / 1000).toFixed(2)} s`;
}

function cacheHitRate(cachedTokens: number, promptTokens: number) {
  return promptTokens > 0
    ? Math.round((cachedTokens / promptTokens) * 10_000) / 100
    : 0;
}

function normalizeUsageSnapshot(usage?: UsageSnapshot): UsageSnapshot {
  return {
    promptTokens: Math.max(0, Math.floor(numberValue(usage?.promptTokens))),
    completionTokens: Math.max(
      0,
      Math.floor(numberValue(usage?.completionTokens)),
    ),
    totalTokens: Math.max(0, Math.floor(numberValue(usage?.totalTokens))),
    cachedTokens: Math.max(0, Math.floor(numberValue(usage?.cachedTokens))),
  };
}

function numberValue(value: unknown) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstTokenLatencySelect(tableAlias: string) {
  const alias = safeLatencyColumnName(tableAlias);
  return `(
    SELECT COALESCE(
      MAX(CASE WHEN json_extract(value, '$.name') = 'stream_first_token' THEN json_extract(value, '$.startedAtMs') END),
      MAX(CASE WHEN json_extract(value, '$.name') = 'stream_first_chunk' THEN json_extract(value, '$.startedAtMs') END)
    )
    FROM request_log_details,
      json_each(request_log_details.stage_timings_json)
    WHERE request_log_details.request_log_id = ${alias}.id
  ) AS first_token_latency_ms`;
}

function toPublicRequestLogDetailRow(row: Record<string, unknown>) {
  return {
    request_headers: parseJsonObject(row.request_headers_json),
    request_body_text: nullableString(row.request_body_text),
    request_body_truncated: Boolean(row.request_body_truncated),
    request_body_bytes: numberValue(row.request_body_bytes),
    forwarded_body_text: nullableString(row.forwarded_body_text),
    forwarded_body_truncated: Boolean(row.forwarded_body_truncated),
    forwarded_body_bytes: numberValue(row.forwarded_body_bytes),
    upstream_status_code: numberValue(row.upstream_status_code) || null,
    upstream_headers: parseJsonObject(row.upstream_headers_json),
    upstream_body_text: nullableString(row.upstream_body_text),
    upstream_body_truncated: Boolean(row.upstream_body_truncated),
    upstream_body_bytes: numberValue(row.upstream_body_bytes),
    error_name: nullableString(row.error_name),
    error_message: nullableString(row.error_message),
    error_stack: nullableString(row.error_stack),
    error_cause: parseJsonValue(row.error_cause_json),
    detail: parseJsonValue(row.detail_json),
    stage_timings: parseStageTimings(row.stage_timings_json),
    created_at: nullableString(row.created_at),
    updated_at: nullableString(row.updated_at),
  };
}

function toPublicRequestLogRow(
  row: Record<string, unknown>,
): PublicRequestLogRow {
  return {
    id: String(row.id || ""),
    started_at: String(row.started_at || ""),
    method: String(row.method || ""),
    path: String(row.path || ""),
    request_type: String(row.request_type || ""),
    stream: Number(row.stream || 0),
    model: String(row.model || ""),
    status_code: Number(row.status_code || 0),
    latency_ms: Number(row.latency_ms || 0),
    first_token_latency_ms: nullableNumber(row.first_token_latency_ms),
    tenant_id: nullableString(row.tenant_id),
    tenant_name: nullableString(row.tenant_name),
    api_key_prefix: nullableString(row.api_key_prefix),
    api_key_name: nullableString(row.api_key_name),
    channel_name: nullableString(row.channel_name),
    credential_email: nullableString(row.credential_email),
    prompt_tokens: Number(row.prompt_tokens || 0),
    completion_tokens: Number(row.completion_tokens || 0),
    total_tokens: Number(row.total_tokens || 0),
    cached_tokens: Number(row.cached_tokens || 0),
    cache_hit_rate: cacheHitRate(
      Number(row.cached_tokens || 0),
      Number(row.prompt_tokens || 0),
    ),
    error_code: nullableString(row.error_code),
  };
}

function attachApiKeyNames(rows: Array<Record<string, unknown>>) {
  const apiKeyIds = [
    ...new Set(
      rows.map((row) => nullableString(row.api_key_id)).filter(Boolean),
    ),
  ];
  if (apiKeyIds.length === 0) {
    return rows;
  }

  const placeholders = apiKeyIds.map(() => "?").join(", ");
  const apiKeyRows = mainAll(
    `SELECT id, name FROM api_keys WHERE id IN (${placeholders})`,
    apiKeyIds,
  ) as Array<{ id: string; name: string }>;
  const namesById = new Map(
    apiKeyRows.map((row) => [String(row.id), String(row.name || "")]),
  );

  return rows.map((row) => {
    const apiKeyId = nullableString(row.api_key_id);
    return {
      ...row,
      api_key_name: apiKeyId
        ? namesById.get(apiKeyId) || nullableString(row.api_key_name)
        : nullableString(row.api_key_name),
    };
  });
}

function nullableString(value: unknown) {
  return value === null || value === undefined ? null : String(value);
}

function safeDetailJson(value: unknown) {
  try {
    return jsonStringify(value);
  } catch {
    return jsonStringify(String(value));
  }
}

function parseJsonObject(value: unknown): Record<string, string> | null {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([key, item]) => [
      key,
      String(item ?? ""),
    ]),
  );
}

function parseStageTimings(value: unknown): StageTimingEntry[] {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const row = item as Record<string, unknown>;
      return {
        name: String(row.name || ""),
        label: String(row.label || row.name || ""),
        startedAtMs: numberValue(row.startedAtMs),
        endedAtMs: numberValue(row.endedAtMs),
        durationMs: numberValue(row.durationMs),
      };
    })
    .filter((item): item is StageTimingEntry => Boolean(item?.name));
}

function parseJsonValue(value: unknown) {
  if (typeof value !== "string" || !value) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

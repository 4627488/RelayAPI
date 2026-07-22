import "server-only";

import {
  eq,
  lt,
  sql,
  type SQL,
  type SQLChunk,
} from "drizzle-orm";

import {
  getLogOrm,
  setSqliteTimeZone,
} from "@/src/server/db/sqlite";
import {
  channelHealthEvents,
  requestLogDetails,
  requestLogs as requestLogsTable,
  usageDailyBuckets,
  usageRecords,
} from "@/src/server/db/schema";
import { jsonStringify, randomId } from "@/src/server/services/crypto";
import type { StageTimingEntry } from "@/src/server/http/stageTimer";
import type { UsageSnapshot } from "@/src/shared/types/entities";
import { instantToDateKey } from "@/src/shared/time";
import { getGlobalTimeZoneSetting } from "@/src/server/services/settings";
import { LogWriteQueue } from "@/src/server/services/logWriteQueue";
import { calculateRequestCost, type ModelPriceSnapshot } from "@/src/server/services/modelPricing";
import { registerLogWriteBarrier } from "@/src/server/repositories/logWriteBarrier";
import { invalidateLogAnalyticsCache } from "@/src/server/repositories/logAnalytics";

export {
  getRequestLogDetail,
  latestRequestLogs,
  queryRequestLogs,
  type PublicRequestLogDetail,
  type PublicRequestLogRow,
  type RequestLogQueryInput,
  type RequestLogQueryResult,
  type RequestLogStatusFilter,
} from "@/src/server/repositories/requestLogQueries";
export {
  channelUsageHealth,
  credentialUsageHealth,
  emptyAdminOverviewStats,
  getAdminOverviewStats,
} from "@/src/server/repositories/logAnalytics";

const LOG_WRITE_FLUSH_INTERVAL_MS = 100;
const LOG_WRITE_MAX_BATCH_SIZE = 100;

type LogWriteOperation = () => void;

const requestLogWriteQueue = new LogWriteQueue<LogWriteOperation>({
  flushIntervalMs: LOG_WRITE_FLUSH_INTERVAL_MS,
  maxBatchSize: LOG_WRITE_MAX_BATCH_SIZE,
  writeBatch: (operations) => {
    getLogOrm().transaction(() => {
      for (const operation of operations) {
        operation();
      }
    });
  },
  onBackgroundError: (error) => {
    console.error("[request-log-writer] Failed to flush log batch", error);
  },
});
registerLogWriteBarrier(() => requestLogWriteQueue.flushNow());
let requestLogShutdownRegistered = false;

export function flushRequestLogWrites() {
  requestLogWriteQueue.flushNow();
}

export function closeRequestLogWriter() {
  flushRequestLogWrites();
  requestLogWriteQueue.close();
}

export function registerRequestLogWriterShutdown() {
  if (requestLogShutdownRegistered) {
    return;
  }
  requestLogShutdownRegistered = true;
  process.once("beforeExit", closeRequestLogWriter);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      try {
        closeRequestLogWriter();
      } catch (error) {
        console.error("[request-log-writer] Failed to flush during shutdown", error);
      } finally {
        process.exit(signal === "SIGINT" ? 130 : 143);
      }
    });
  }
}

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
  flushRequestLogWrites();
  return getLogOrm().all(boundSql(query, params)) as Array<
    Record<string, unknown>
  >;
}

function logGet(query: string, params: unknown[] = []) {
  flushRequestLogWrites();
  return getLogOrm().get(boundSql(query, params)) as
    | Record<string, unknown>
    | undefined;
}

function logRun(query: string, params: unknown[] = []) {
  flushRequestLogWrites();
  return getLogOrm().run(boundSql(query, params)) as unknown as {
    changes: number | bigint;
  };
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
  subscriptionId?: string | null;
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
  requestLogWriteQueue.enqueue(() => {
    insertRequestLog(id, input, usage, completedAt);
    if (usage.totalTokens > 0) {
      appendUsageRecordSync({
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
  });
  return id;
}

export function getCostAnalysis(scope: { tenantId?: string | null; subscriptionId?: string; credentialId?: string; startedAt?: string; endedAt?: string } = {}) {
  const clauses = ["cost_nano_usd IS NOT NULL"];
  const params: unknown[] = [];
  if (scope.tenantId !== undefined) {
    if (scope.tenantId === null) {
      clauses.push("tenant_id IS NULL");
    } else {
      clauses.push("tenant_id = ?");
      params.push(scope.tenantId);
    }
  }
  if (scope.subscriptionId) {
    if (scope.credentialId && typeof scope.tenantId === "string") {
      clauses.push("(subscription_id = ? OR (subscription_id IS NULL AND tenant_id = ? AND credential_id = ?))");
      params.push(scope.subscriptionId, scope.tenantId, scope.credentialId);
    } else {
      clauses.push("subscription_id = ?");
      params.push(scope.subscriptionId);
    }
  }
  if (scope.startedAt) { clauses.push("started_at >= ?"); params.push(scope.startedAt); }
  if (scope.endedAt) { clauses.push("started_at < ?"); params.push(scope.endedAt); }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const total = logGet(
    `SELECT COALESCE(SUM(CAST(cost_nano_usd AS INTEGER)), 0) AS cost,
            COUNT(*) AS priced_requests
       FROM request_logs ${where}`,
    params,
  );
  const models = logAll(
    `SELECT model,
            COALESCE(SUM(CAST(cost_nano_usd AS INTEGER)), 0) AS cost,
            COUNT(*) AS request_count,
            COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
            COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
            COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
            MAX(started_at) AS latest_started_at,
            input_nano_usd_per_token, output_nano_usd_per_token,
            cached_input_nano_usd_per_token, cache_write_nano_usd_per_token,
            reasoning_nano_usd_per_token
       FROM request_logs ${where}
       GROUP BY model
       ORDER BY cost DESC`,
    params,
  );
  return {
    totalCostNanoUsd: String(total?.cost || 0),
    pricedRequests: numberValue(total?.priced_requests),
    models: models.map((row) => ({
      model: String(row.model || ""),
      costNanoUsd: String(row.cost || 0),
      requestCount: numberValue(row.request_count),
      promptTokens: numberValue(row.prompt_tokens),
      completionTokens: numberValue(row.completion_tokens),
      cachedTokens: numberValue(row.cached_tokens),
      reasoningTokens: numberValue(row.reasoning_tokens),
      pricing: priceSnapshot(row),
    })),
  };
}

export function getPendingPricingSummary() {
  const rows = logAll(
    `SELECT model, COUNT(*) AS request_count, MAX(started_at) AS latest_started_at
       FROM request_logs
      WHERE pricing_complete = 0 AND model <> '' AND status_code >= 200 AND status_code < 400
      GROUP BY model ORDER BY request_count DESC, model ASC`,
  );
  return rows.map((row) => ({
    model: String(row.model || ""),
    requestCount: numberValue(row.request_count),
    latestStartedAt: String(row.latest_started_at || ""),
  }));
}

export function backfillPendingRequestPricing(
  resolvePrice: (model: string) => ModelPriceSnapshot | null,
) {
  flushRequestLogWrites();
  const rows = logAll(
    `SELECT id, model, prompt_tokens, completion_tokens, cached_tokens,
            cache_write_tokens, reasoning_tokens
       FROM request_logs
      WHERE pricing_complete = 0 AND model <> '' AND status_code >= 200 AND status_code < 400`,
  );
  let updated = 0;
  getLogOrm().transaction((tx) => {
    for (const row of rows) {
      const price = resolvePrice(String(row.model || ""));
      if (!price) continue;
      const cost = calculateRequestCost(price, {
        inputTokens: numberValue(row.prompt_tokens),
        outputTokens: numberValue(row.completion_tokens),
        cachedInputTokens: numberValue(row.cached_tokens),
        cacheWriteTokens: numberValue(row.cache_write_tokens),
        reasoningTokens: numberValue(row.reasoning_tokens),
      });
      tx.update(requestLogsTable).set({
        costNanoUsd: String(cost.totalNanoUsd), priceModel: price.pricedModel,
        priceVersion: price.version,
        inputNanoUsdPerToken: String(price.inputNanoUsdPerToken),
        outputNanoUsdPerToken: String(price.outputNanoUsdPerToken),
        cachedInputNanoUsdPerToken: String(price.cachedInputNanoUsdPerToken),
        cacheWriteNanoUsdPerToken: String(price.cacheWriteNanoUsdPerToken),
        reasoningNanoUsdPerToken: String(price.reasoningNanoUsdPerToken),
        pricingComplete: 1,
      }).where(eq(requestLogsTable.id, String(row.id))).run();
      updated += 1;
    }
  });
  return updated;
}

export function getSubscriptionCalibrationCost(input: { subscriptionId: string; tenantId: string; credentialId: string; startedAt: string; endedAt: string }) {
  const row = logGet(
    `SELECT COALESCE(SUM(CAST(cost_nano_usd AS INTEGER)), 0) AS cost, COUNT(*) AS requests
       FROM request_logs
      WHERE cost_nano_usd IS NOT NULL AND started_at >= ? AND started_at < ?
        AND (subscription_id = ? OR (subscription_id IS NULL AND tenant_id = ? AND credential_id = ?))`,
    [input.startedAt, input.endedAt, input.subscriptionId, input.tenantId, input.credentialId],
  );
  return { costNanoUsd: BigInt(String(row?.cost || 0)), requestCount: numberValue(row?.requests) };
}

function insertRequestLog(
  id: string,
  input: RequestLogInput,
  usage: UsageSnapshot,
  completedAt: string,
) {
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
      subscriptionId: input.subscriptionId || null,
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
      cacheWriteTokens: usage.cacheWriteTokens,
      reasoningTokens: usage.reasoningTokens,
      costNanoUsd: usage.costNanoUsd || null,
      priceModel: usage.priceModel || null,
      priceVersion: usage.priceVersion || null,
      inputNanoUsdPerToken: usage.inputNanoUsdPerToken || null,
      outputNanoUsdPerToken: usage.outputNanoUsdPerToken || null,
      cachedInputNanoUsdPerToken: usage.cachedInputNanoUsdPerToken || null,
      cacheWriteNanoUsdPerToken: usage.cacheWriteNanoUsdPerToken || null,
      reasoningNanoUsdPerToken: usage.reasoningNanoUsdPerToken || null,
      pricingComplete: usage.pricingComplete ? 1 : 0,
      errorCode: input.errorCode || null,
      errorMessage: input.errorMessage || null,
    })
    .run();

}

export function appendRequestLogDetail(
  requestLogId: string,
  input: RequestLogDetailInput,
) {
  requestLogWriteQueue.enqueue(() =>
    appendRequestLogDetailSync(requestLogId, input),
  );
}

function appendRequestLogDetailSync(
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
  requestLogWriteQueue.enqueue(() => appendUsageRecordSync(input));
}

function appendUsageRecordSync(input: {
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

  invalidateLogAnalyticsCache();
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

  invalidateLogAnalyticsCache();
  return {
    requestLogs: migratedRequestLogs,
    usageRecords: migratedUsageRecords,
    usageDailyBuckets: migratedUsageDailyBuckets,
  };
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

function normalizeUsageSnapshot(usage?: UsageSnapshot): UsageSnapshot {
  return {
    promptTokens: Math.max(0, Math.floor(numberValue(usage?.promptTokens))),
    completionTokens: Math.max(
      0,
      Math.floor(numberValue(usage?.completionTokens)),
    ),
    totalTokens: Math.max(0, Math.floor(numberValue(usage?.totalTokens))),
    cachedTokens: Math.max(0, Math.floor(numberValue(usage?.cachedTokens))),
    cacheWriteTokens: Math.max(
      0,
      Math.floor(numberValue(usage?.cacheWriteTokens)),
    ),
    reasoningTokens: Math.max(
      0,
      Math.floor(numberValue(usage?.reasoningTokens)),
    ),
    costNanoUsd: usage?.costNanoUsd || null,
    priceModel: usage?.priceModel || null,
    priceVersion: usage?.priceVersion || null,
    inputNanoUsdPerToken: usage?.inputNanoUsdPerToken || null,
    outputNanoUsdPerToken: usage?.outputNanoUsdPerToken || null,
    cachedInputNanoUsdPerToken: usage?.cachedInputNanoUsdPerToken || null,
    cacheWriteNanoUsdPerToken: usage?.cacheWriteNanoUsdPerToken || null,
    reasoningNanoUsdPerToken: usage?.reasoningNanoUsdPerToken || null,
    pricingComplete: Boolean(usage?.pricingComplete),
  };
}

function numberValue(value: unknown) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function priceSnapshot(row: Record<string, unknown>) {
  const input = nullableString(row.input_nano_usd_per_token);
  const output = nullableString(row.output_nano_usd_per_token);
  if (!input || !output) return null;
  return {
    inputNanoUsdPerToken: input,
    outputNanoUsdPerToken: output,
    cachedInputNanoUsdPerToken: nullableString(row.cached_input_nano_usd_per_token) || input,
    cacheWriteNanoUsdPerToken: nullableString(row.cache_write_nano_usd_per_token) || input,
    reasoningNanoUsdPerToken: nullableString(row.reasoning_nano_usd_per_token) || output,
  };
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


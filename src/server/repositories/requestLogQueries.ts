import "server-only";

import type { StageTimingEntry } from "@/src/server/http/stageTimer";
import { getLogClient, getMainClient } from "@/src/server/db/sqlite";
import { flushLogWriteBarrier } from "@/src/server/repositories/logWriteBarrier";

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
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_nano_usd: string | null;
  price_model: string | null;
  price_version: string | null;
  pricing: {
    inputNanoUsdPerToken: string;
    outputNanoUsdPerToken: string;
    cachedInputNanoUsdPerToken: string;
    cacheWriteNanoUsdPerToken: string;
    reasoningNanoUsdPerToken: string;
  } | null;
  pricing_complete: boolean;
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
  method?: string;
  model?: string;
  from?: string;
  to?: string;
  minLatencyMs?: number;
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
  flushLogWriteBarrier();
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
        cached_tokens, cache_write_tokens, reasoning_tokens, cost_nano_usd,
        price_model, price_version, input_nano_usd_per_token,
        output_nano_usd_per_token, cached_input_nano_usd_per_token,
        cache_write_nano_usd_per_token, reasoning_nano_usd_per_token,
        pricing_complete, error_code, error_message
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
  flushLogWriteBarrier();
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
        cached_tokens, cache_write_tokens, reasoning_tokens, cost_nano_usd,
        price_model, price_version, input_nano_usd_per_token,
        output_nano_usd_per_token, cached_input_nano_usd_per_token,
        cache_write_nano_usd_per_token, reasoning_nano_usd_per_token,
        pricing_complete, error_code
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
  if (input.method) {
    conditions.push("method = ?");
    params.push(input.method.toUpperCase());
  }
  if (input.model) {
    conditions.push("model = ?");
    params.push(input.model);
  }
  if (input.from) {
    conditions.push("started_at >= ?");
    params.push(input.from);
  }
  if (input.to) {
    conditions.push("started_at <= ?");
    params.push(input.to);
  }
  if (Number.isFinite(input.minLatencyMs) && Number(input.minLatencyMs) > 0) {
    conditions.push("latency_ms >= ?");
    params.push(String(Math.floor(Number(input.minLatencyMs))));
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


function logAll(query: string, params: unknown[] = []) {
  return getLogClient().prepare(query).all(...params) as Array<Record<string, unknown>>;
}

function logGet(query: string, params: unknown[] = []) {
  return getLogClient().prepare(query).get(...params) as Record<string, unknown> | undefined;
}

function mainAll(query: string, params: unknown[] = []) {
  return getMainClient().prepare(query).all(...params) as Array<Record<string, unknown>>;
}

function safeLatencyColumnName(name: string) {
  if (!/^[a-z_]+$/i.test(name)) throw new Error("Invalid latency column name");
  return name;
}

function numberValue(value: unknown) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cacheHitRate(cachedTokens: number, promptTokens: number) {
  return promptTokens > 0
    ? Math.round((cachedTokens / promptTokens) * 10_000) / 100
    : 0;
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

function toPublicRequestLogRow(row: Record<string, unknown>): PublicRequestLogRow {
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
    cache_write_tokens: Number(row.cache_write_tokens || 0),
    reasoning_tokens: Number(row.reasoning_tokens || 0),
    cost_nano_usd: nullableString(row.cost_nano_usd),
    price_model: nullableString(row.price_model),
    price_version: nullableString(row.price_version),
    pricing: priceSnapshot(row),
    pricing_complete: Boolean(row.pricing_complete),
    cache_hit_rate: cacheHitRate(Number(row.cached_tokens || 0), Number(row.prompt_tokens || 0)),
    error_code: nullableString(row.error_code),
  };
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

function attachApiKeyNames(rows: Array<Record<string, unknown>>) {
  const apiKeyIds = [...new Set(rows.map((row) => nullableString(row.api_key_id)).filter(Boolean))];
  if (apiKeyIds.length === 0) return rows;
  const placeholders = apiKeyIds.map(() => "?").join(", ");
  const apiKeyRows = mainAll(
    `SELECT id, name FROM api_keys WHERE id IN (${placeholders})`,
    apiKeyIds,
  ) as Array<{ id: string; name: string }>;
  const namesById = new Map(apiKeyRows.map((row) => [String(row.id), String(row.name || "")]));
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

function parseJsonObject(value: unknown): Record<string, string> | null {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([key, item]) => [key, String(item ?? "")]),
  );
}

function parseStageTimings(value: unknown): StageTimingEntry[] {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item): StageTimingEntry | null => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    return {
      name: String(row.name || ""),
      label: String(row.label || row.name || ""),
      kind: row.kind === "point" ? "point" : row.kind === "period" ? "period" : undefined,
      startedAtMs: numberValue(row.startedAtMs),
      endedAtMs: numberValue(row.endedAtMs),
      durationMs: numberValue(row.durationMs),
    };
  }).filter((item): item is StageTimingEntry => Boolean(item?.name));
}

function parseJsonValue(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

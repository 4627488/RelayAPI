import "server-only";

import { HttpError } from "@/src/server/http/errors";
import type { StageTimer } from "@/src/server/http/stageTimer";
import {
  appendRequestLog,
  appendRequestLogDetail,
  type RequestLogInput,
} from "@/src/server/repositories/logs";
import { maybeAutoPruneRequestLogs } from "@/src/server/services/logRetention";
import { getFullRequestLoggingSetting } from "@/src/server/services/settings";
import type {
  ChannelRecord,
  RelayApiKeyContext,
  UsageSnapshot,
} from "@/src/shared/types/entities";

type SecondaryUsage = { model: string; usage: UsageSnapshot };
const DETAIL_TEXT_LIMIT = 512 * 1024;
const SENSITIVE_HEADER_NAMES = new Set([
  "api-key",
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "openai-api-key",
  "proxy-authorization",
]);

export function appendSuccessLog(input: {
  request: Request;
  startedAt: string;
  start: number;
  apiKey: RelayApiKeyContext;
  channel: ChannelRecord;
  credentialEmail?: string;
  subscriptionId?: string | null;
  requestType: string;
  stream: boolean;
  model: string;
  statusCode: number;
  usage: UsageSnapshot;
  imageGeneration?: SecondaryUsage | null;
  errorCode?: string;
  errorMessage?: string;
  requestBody?: unknown;
  forwardedBody?: unknown;
  upstreamHeaders?: Headers;
  upstreamBody?: unknown;
  error?: unknown;
  timing?: StageTimer;
}) {
  const logPayload = {
    startedAt: input.startedAt,
    method: input.request.method,
    path: new URL(input.request.url).pathname,
    requestType: input.requestType,
    stream: input.stream,
    model: input.model,
    statusCode: input.statusCode,
    latencyMs: Date.now() - input.start,
    tenantId: input.apiKey.tenantId,
    tenantName: input.apiKey.tenant?.name,
    subscriptionId: input.subscriptionId,
    apiKeyId: input.apiKey.id,
    apiKeyPrefix: input.apiKey.prefix,
    apiKeyName: input.apiKey.name,
    channelId: input.channel.id,
    channelName: input.channel.name,
    credentialId: input.channel.credentialId,
    credentialEmail: input.credentialEmail || "",
    usage: input.usage,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
  };
  const logId = input.timing
    ? input.timing.time("append_summary_log", "写入概要日志", () =>
        appendRequestLogWithAutoPrune(logPayload),
      )
    : appendRequestLogWithAutoPrune(logPayload);
  if (input.imageGeneration) {
    appendRequestLogWithAutoPrune({
      ...logPayload,
      requestType: `${input.requestType}.image_generation.billing`,
      model: input.imageGeneration.model,
      usage: input.imageGeneration.usage,
    });
  }
  appendOptionalRequestDetail(logId, {
    request: input.request,
    full: getFullRequestLoggingSetting(),
    requestBody: input.requestBody,
    forwardedBody: input.forwardedBody,
    upstreamStatusCode: input.statusCode,
    upstreamHeaders: input.upstreamHeaders,
    upstreamBody: input.upstreamBody,
    error: input.error,
    forceError: Boolean(input.errorCode || input.statusCode >= 400),
    timing: input.timing,
  });
  return logId;
}

export function appendErrorLog(
  request: Request,
  startedAt: string,
  start: number,
  requestType: string,
  error: unknown,
  apiKey?: RelayApiKeyContext | null,
  channel?: ChannelRecord | null,
  requestBody?: unknown,
  timing?: StageTimer,
) {
  const statusCode = error instanceof HttpError ? error.status : 500;
  const logPayload = {
    startedAt,
    method: request.method,
    path: new URL(request.url).pathname,
    requestType,
    stream: false,
    statusCode,
    latencyMs: Date.now() - start,
    tenantId: apiKey?.tenantId,
    tenantName: apiKey?.tenant?.name,
    apiKeyId: apiKey?.id,
    apiKeyPrefix: apiKey?.prefix,
    apiKeyName: apiKey?.name,
    channelId: channel?.id,
    channelName: channel?.name,
    credentialId: channel?.credentialId,
    errorCode: error instanceof HttpError ? error.code : "internal_error",
    errorMessage: error instanceof Error ? error.message : String(error),
  };
  const logId = timing
    ? timing.time("append_summary_log", "写入概要日志", () =>
        appendRequestLogWithAutoPrune(logPayload),
      )
    : appendRequestLogWithAutoPrune(logPayload);
  appendOptionalRequestDetail(logId, {
    request,
    full: getFullRequestLoggingSetting(),
    requestBody,
    error,
    forceError: true,
    timing,
  });
  return logId;
}

export function appendRequestLogWithAutoPrune(input: RequestLogInput) {
  const logId = appendRequestLog(input);
  maybeAutoPruneRequestLogs();
  return logId;
}

export function appendOptionalRequestDetail(
  logId: string,
  input: {
    request: Request;
    full: boolean;
    requestBody?: unknown;
    forwardedBody?: unknown;
    upstreamStatusCode?: number | null;
    upstreamHeaders?: Headers;
    upstreamBody?: unknown;
    error?: unknown;
    forceError?: boolean;
    timing?: StageTimer;
  },
) {
  const shouldWrite =
    input.full || input.forceError || input.error || Boolean(input.timing);
  if (!shouldWrite) {
    return;
  }
  const requestBody = input.full
    ? serializeDetailText(input.requestBody)
    : emptySerializedText();
  const forwardedBody = input.full
    ? serializeDetailText(input.forwardedBody)
    : emptySerializedText();
  const upstreamBody =
    input.full || input.forceError
      ? serializeDetailText(input.upstreamBody)
      : emptySerializedText();
  const errorDetail = input.error ? errorLogDetail(input.error) : null;
  appendRequestLogDetail(logId, {
    requestHeaders: sanitizeHeaders(input.request.headers),
    requestBodyText: requestBody.text,
    requestBodyTruncated: requestBody.truncated,
    requestBodyBytes: requestBody.bytes,
    forwardedBodyText: forwardedBody.text,
    forwardedBodyTruncated: forwardedBody.truncated,
    forwardedBodyBytes: forwardedBody.bytes,
    upstreamStatusCode: input.upstreamStatusCode ?? null,
    upstreamHeaders: input.upstreamHeaders
      ? sanitizeHeaders(input.upstreamHeaders)
      : null,
    upstreamBodyText: upstreamBody.text,
    upstreamBodyTruncated: upstreamBody.truncated,
    upstreamBodyBytes: upstreamBody.bytes,
    errorName: errorDetail?.name,
    errorMessage: errorDetail?.message,
    errorStack: errorDetail?.stack,
    errorCause: errorDetail?.cause,
    detail: errorDetail?.detail,
    stageTimings: input.timing?.snapshot(),
  });
}

function serializeDetailText(value: unknown) {
  if (value === undefined || value === null) {
    return emptySerializedText();
  }
  const text = typeof value === "string" ? value : safeJsonStringify(value);
  const bytes = new TextEncoder().encode(text).byteLength;
  if (text.length <= DETAIL_TEXT_LIMIT) {
    return { text, truncated: false, bytes };
  }
  return {
    text: `${text.slice(0, DETAIL_TEXT_LIMIT)}\n...[truncated]`,
    truncated: true,
    bytes,
  };
}

function emptySerializedText() {
  return { text: null as string | null, truncated: false, bytes: 0 };
}

function sanitizeHeaders(headers: Headers) {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = SENSITIVE_HEADER_NAMES.has(key.toLowerCase())
      ? "[REDACTED]"
      : value;
  });
  return result;
}

function errorLogDetail(error: unknown) {
  if (error instanceof Error) {
    const withCause = error as Error & { cause?: unknown; details?: unknown };
    return {
      name: error.name,
      message: error.message,
      stack: error.stack || null,
      cause: withCause.cause,
      detail:
        error instanceof HttpError
          ? { status: error.status, code: error.code, details: error.details }
          : withCause.details,
    };
  }
  return {
    name: typeof error,
    message: String(error),
    stack: null,
    cause: null,
    detail: error,
  };
}

function safeJsonStringify(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}



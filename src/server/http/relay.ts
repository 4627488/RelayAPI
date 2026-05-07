import "server-only";

import { createModelsResponse } from "@/src/server/codex/models";
import {
  chatCompletionsToCodex,
  codexFetch,
  codexJson,
  codexResponseToChatCompletion,
  copyUpstreamHeaders,
  extractUsageFromCodexResponse,
  normalizeCompactPayload,
  normalizeResponsesPayload,
  parseCodexSseResponse,
} from "@/src/server/codex/client";
import { createOpenAIChatSseStream } from "@/src/server/codex/chatStream";
import { serverConfig } from "@/src/server/config/env";
import { HttpError, errorToResponse } from "@/src/server/http/errors";
import {
  createStageTimer,
  type StageTimer,
} from "@/src/server/http/stageTimer";
import {
  appendRequestLog,
  appendRequestLogDetail,
} from "@/src/server/repositories/logs";
import { authenticateRelayRequest } from "@/src/server/services/apiKeys";
import {
  recordChannelFailure,
  recordChannelSuccess,
  selectChannel,
} from "@/src/server/services/channels";
import { listPublicCodexCredentials } from "@/src/server/services/codexCredentials";
import { getFullRequestLoggingSetting } from "@/src/server/services/settings";
import type {
  ChannelRecord,
  RelayApiKeyContext,
  UsageSnapshot,
} from "@/src/shared/types/entities";

const DETAIL_TEXT_LIMIT = 5 * 1024 * 1024;
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "openai-api-key",
  "proxy-authorization",
]);

export async function handleModels(request: Request) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const timing = createStageTimer();
  try {
    const apiKey = timing.time("authenticate", "认证 API Key", () =>
      authenticateRelayRequest(request),
    );
    const credentials = await timing.timeAsync(
      "list_credentials",
      "读取凭据列表",
      () => listPublicCodexCredentials(),
    );
    const planType =
      new URL(request.url).searchParams.get("plan") ||
      credentials[0]?.planType ||
      "";
    const payload = await timing.timeAsync(
      "create_models",
      "生成模型列表",
      () =>
        createModelsResponse({
          planType,
          openAICompatible: true,
          modelAllowlist: apiKey.modelAllowlist,
        }),
    );
    const logId = appendRequestLog({
      startedAt,
      method: request.method,
      path: new URL(request.url).pathname,
      requestType: "models",
      stream: false,
      statusCode: 200,
      latencyMs: Date.now() - start,
      apiKeyId: apiKey.id,
      apiKeyPrefix: apiKey.prefix,
      apiKeyName: apiKey.name,
    });
    appendOptionalRequestDetail(logId, {
      request,
      full: getFullRequestLoggingSetting(),
      upstreamStatusCode: 200,
      upstreamBody: payload,
      timing,
    });
    return Response.json(payload);
  } catch (error) {
    appendErrorLog(
      request,
      startedAt,
      start,
      "models",
      error,
      null,
      null,
      null,
      timing,
    );
    return errorToResponse(error);
  }
}

export async function handleOpenAIResponses(request: Request) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const timing = createStageTimer();
  let apiKey: RelayApiKeyContext | null = null;
  let channel: ChannelRecord | null = null;
  let input: Record<string, unknown> | null = null;
  try {
    apiKey = timing.time("authenticate", "认证 API Key", () =>
      authenticateRelayRequest(request),
    );
    input = await timing.timeAsync("read_request_body", "读取请求 Body", () =>
      readJsonObject(request),
    );
    const stream = input.stream !== false;
    const payload = timing.time("normalize_payload", "规范化请求 Payload", () =>
      normalizeResponsesPayload(input!, { stream: true }),
    );
    const model = stringValue(payload.model) || serverConfig.codexDefaultModel;
    const selected = timing.time("select_channel", "选择通道", () =>
      selectChannel({ model, apiKey: apiKey! }),
    );
    channel = selected.channel;

    if (stream) {
      return await forwardCodexStream({
        request,
        startedAt,
        start,
        apiKey,
        channel,
        payload,
        upstreamPath: "/responses",
        requestType: "responses",
        fallbackContentType: "text/event-stream; charset=utf-8",
        requestBody: input,
        forwardedBody: payload,
        timing,
      });
    }

    const result = await codexJson("/responses", payload, {
      stream: true,
      sourceHeaders: request.headers,
      channel,
      timing,
    });
    const raw = timing.time(
      "parse_upstream_response",
      "解析上游响应",
      () =>
        parseCodexSseResponse(result.text) ||
        result.json || { raw: result.text },
    );
    const usage = timing.time("extract_usage", "提取 Token 用量", () =>
      extractUsageFromCodexResponse(raw),
    );
    if (result.response.ok) {
      recordChannelSuccess(channel);
    } else {
      recordChannelFailure(channel, {
        statusCode: result.response.status,
        message: result.text.slice(0, 500),
      });
    }
    appendSuccessLog({
      request,
      startedAt,
      start,
      apiKey,
      channel,
      credentialEmail: result.credential.email,
      requestType: "responses",
      stream: false,
      model,
      statusCode: result.response.status,
      usage,
      requestBody: input,
      forwardedBody: result.upstreamPayload,
      upstreamHeaders: result.response.headers,
      upstreamBody: result.text,
      timing,
    });
    return Response.json(raw, { status: result.response.status });
  } catch (error) {
    if (channel) {
      recordChannelFailure(channel, {
        message: error instanceof Error ? error.message : "request failed",
      });
    }
    appendErrorLog(
      request,
      startedAt,
      start,
      "responses",
      error,
      apiKey,
      channel,
      input,
      timing,
    );
    return errorToResponse(error);
  }
}

export async function handleOpenAIResponsesCompact(request: Request) {
  return handleRawCodexProxy(request, {
    upstreamPath: "/responses/compact",
    requestType: "responses.compact",
    streamFromPayload: false,
    normalizePayload: normalizeCompactPayload,
  });
}

export async function handleRawCodexResponses(request: Request) {
  return handleRawCodexProxy(request, {
    upstreamPath: "/responses",
    requestType: "codex.responses.raw",
    streamFromPayload: true,
    normalizePayload: (payload) => payload,
  });
}

export async function handleRawCodexCompact(request: Request) {
  return handleRawCodexProxy(request, {
    upstreamPath: "/responses/compact",
    requestType: "codex.responses.compact.raw",
    streamFromPayload: false,
    normalizePayload: (payload) => payload,
  });
}

export async function handleChatCompletions(request: Request) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const timing = createStageTimer();
  let apiKey: RelayApiKeyContext | null = null;
  let channel: ChannelRecord | null = null;
  let input: Record<string, unknown> | null = null;
  try {
    apiKey = timing.time("authenticate", "认证 API Key", () =>
      authenticateRelayRequest(request),
    );
    input = await timing.timeAsync("read_request_body", "读取请求 Body", () =>
      readJsonObject(request),
    );
    const stream = Boolean(input.stream);
    const { payload, toolNameMaps } = timing.time(
      "normalize_payload",
      "Chat 转换为 Codex Payload",
      () => chatCompletionsToCodex(input!, { stream: true }),
    );
    const model = stringValue(payload.model) || serverConfig.codexDefaultModel;
    const selected = timing.time("select_channel", "选择通道", () =>
      selectChannel({ model, apiKey: apiKey! }),
    );
    channel = selected.channel;

    if (stream) {
      const { response, credential, upstreamPayload } = await codexFetch(
        "/responses",
        payload,
        {
          stream: true,
          sourceHeaders: request.headers,
          channel,
          timing,
        },
      );
      if (!response.ok) {
        const errorText = await timing.timeAsync(
          "read_upstream_error_body",
          "读取上游错误响应 Body",
          () => response.text(),
        );
        recordChannelFailure(channel, {
          statusCode: response.status,
          message: errorText.slice(0, 500) || response.statusText,
        });
        appendSuccessLog({
          request,
          startedAt,
          start,
          apiKey,
          channel,
          credentialEmail: credential.email,
          requestType: "chat.completions",
          stream: true,
          model,
          statusCode: response.status,
          usage: emptyUsage(),
          errorCode: "upstream_error",
          errorMessage: (errorText || response.statusText).slice(0, 500),
          requestBody: input,
          forwardedBody: upstreamPayload,
          upstreamHeaders: response.headers,
          upstreamBody: errorText,
          timing,
        });
        const headers = copyUpstreamHeaders(response.headers);
        return new Response(errorText, {
          status: response.status,
          headers,
        });
      }
      const headers = new Headers({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const fullLog = getFullRequestLoggingSetting();
      const upstreamCapture = createTextCapture();
      const body = response.body
        ? createOpenAIChatSseStream(
            tapStream(response.body, fullLog ? upstreamCapture : null, timing),
            {
              fallbackModel: model,
              toolNameMaps,
              onCompleted: (usage) => {
                recordChannelSuccess(channel!);
                appendSuccessLog({
                  request,
                  startedAt,
                  start,
                  apiKey: apiKey!,
                  channel: channel!,
                  credentialEmail: credential.email,
                  requestType: "chat.completions",
                  stream: true,
                  model,
                  statusCode: 200,
                  usage,
                  requestBody: input,
                  forwardedBody: upstreamPayload,
                  upstreamHeaders: response.headers,
                  upstreamBody: upstreamCapture.text,
                  timing,
                });
              },
              onError: (error, usage) => {
                const message =
                  error instanceof Error ? error.message : String(error);
                recordChannelFailure(channel!, {
                  statusCode: 502,
                  message,
                });
                appendSuccessLog({
                  request,
                  startedAt,
                  start,
                  apiKey: apiKey!,
                  channel: channel!,
                  credentialEmail: credential.email,
                  requestType: "chat.completions",
                  stream: true,
                  model,
                  statusCode: 502,
                  usage,
                  errorCode: "stream_error",
                  errorMessage: message.slice(0, 500),
                  requestBody: input,
                  forwardedBody: upstreamPayload,
                  upstreamHeaders: response.headers,
                  upstreamBody: upstreamCapture.text,
                  error,
                  timing,
                });
              },
            },
          )
        : null;
      return new Response(body, { status: 200, headers });
    }

    const result = await codexJson("/responses", payload, {
      stream: true,
      sourceHeaders: request.headers,
      channel,
      timing,
    });
    if (!result.response.ok) {
      recordChannelFailure(channel, {
        statusCode: result.response.status,
        message: result.text.slice(0, 500),
      });
      appendSuccessLog({
        request,
        startedAt,
        start,
        apiKey,
        channel,
        credentialEmail: result.credential.email,
        requestType: "chat.completions",
        stream: false,
        model,
        statusCode: result.response.status,
        usage: emptyUsage(),
        errorCode: "upstream_error",
        errorMessage: result.text.slice(0, 500),
        requestBody: input,
        forwardedBody: result.upstreamPayload,
        upstreamHeaders: result.response.headers,
        upstreamBody: result.text,
        timing,
      });
      return new Response(
        result.text || JSON.stringify({ error: { message: "Upstream error" } }),
        {
          status: result.response.status,
          headers: copyUpstreamHeaders(result.response.headers),
        },
      );
    }
    const raw = timing.time(
      "parse_upstream_response",
      "解析上游响应",
      () => parseCodexSseResponse(result.text) || result.json,
    );
    const usage = timing.time("extract_usage", "提取 Token 用量", () =>
      extractUsageFromCodexResponse(raw),
    );
    recordChannelSuccess(channel);
    appendSuccessLog({
      request,
      startedAt,
      start,
      apiKey,
      channel,
      credentialEmail: result.credential.email,
      requestType: "chat.completions",
      stream: false,
      model,
      statusCode: 200,
      usage,
      requestBody: input,
      forwardedBody: result.upstreamPayload,
      upstreamHeaders: result.response.headers,
      upstreamBody: result.text,
      timing,
    });
    const responsePayload = timing.time(
      "transform_response",
      "转换为 OpenAI Chat 响应",
      () => codexResponseToChatCompletion(raw, model, toolNameMaps),
    );
    return Response.json(responsePayload, { status: 200 });
  } catch (error) {
    if (channel) {
      recordChannelFailure(channel, {
        message: error instanceof Error ? error.message : "request failed",
      });
    }
    appendErrorLog(
      request,
      startedAt,
      start,
      "chat.completions",
      error,
      apiKey,
      channel,
      input,
      timing,
    );
    return errorToResponse(error);
  }
}

async function handleRawCodexProxy(
  request: Request,
  input: {
    upstreamPath: "/responses" | "/responses/compact";
    requestType: string;
    streamFromPayload: boolean;
    normalizePayload: (
      payload: Record<string, unknown>,
    ) => Record<string, unknown>;
  },
) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const timing = createStageTimer();
  let apiKey: RelayApiKeyContext | null = null;
  let channel: ChannelRecord | null = null;
  let rawPayload: Record<string, unknown> | null = null;
  try {
    apiKey = timing.time("authenticate", "认证 API Key", () =>
      authenticateRelayRequest(request),
    );
    rawPayload = await timing.timeAsync(
      "read_request_body",
      "读取请求 Body",
      () => readJsonObject(request),
    );
    const payload = timing.time("normalize_payload", "规范化请求 Payload", () =>
      input.normalizePayload(rawPayload!),
    );
    const stream = input.streamFromPayload ? payload.stream !== false : false;
    const model = stringValue(payload.model) || serverConfig.codexDefaultModel;
    const selected = timing.time("select_channel", "选择通道", () =>
      selectChannel({ model, apiKey: apiKey! }),
    );
    channel = selected.channel;
    if (stream) {
      return await forwardCodexStream({
        request,
        startedAt,
        start,
        apiKey,
        channel,
        payload,
        upstreamPath: input.upstreamPath,
        requestType: input.requestType,
        fallbackContentType: "text/event-stream; charset=utf-8",
        requestBody: rawPayload,
        forwardedBody: payload,
        timing,
      });
    }
    const result = await codexJson(input.upstreamPath, payload, {
      stream: false,
      sourceHeaders: request.headers,
      channel,
      timing,
    });
    const usage = timing.time("extract_usage", "提取 Token 用量", () =>
      extractUsageFromCodexResponse(result.json),
    );
    if (result.response.ok) {
      recordChannelSuccess(channel);
    } else {
      recordChannelFailure(channel, {
        statusCode: result.response.status,
        message: result.text.slice(0, 500),
      });
    }
    appendSuccessLog({
      request,
      startedAt,
      start,
      apiKey,
      channel,
      credentialEmail: result.credential.email,
      requestType: input.requestType,
      stream: false,
      model,
      statusCode: result.response.status,
      usage,
      ...(result.response.ok
        ? {}
        : {
            errorCode: "upstream_error",
            errorMessage: result.text.slice(0, 500),
          }),
      requestBody: rawPayload,
      forwardedBody: result.upstreamPayload,
      upstreamHeaders: result.response.headers,
      upstreamBody: result.text,
      timing,
    });
    return new Response(result.text, {
      status: result.response.status,
      headers: withDefaultContentType(
        copyUpstreamHeaders(result.response.headers),
        "application/json; charset=utf-8",
      ),
    });
  } catch (error) {
    if (channel) {
      recordChannelFailure(channel, {
        message: error instanceof Error ? error.message : "request failed",
      });
    }
    appendErrorLog(
      request,
      startedAt,
      start,
      input.requestType,
      error,
      apiKey,
      channel,
      rawPayload,
      timing,
    );
    return errorToResponse(error);
  }
}

async function forwardCodexStream(input: {
  request: Request;
  startedAt: string;
  start: number;
  apiKey: RelayApiKeyContext;
  channel: ChannelRecord;
  payload: Record<string, unknown>;
  upstreamPath: "/responses" | "/responses/compact";
  requestType: string;
  fallbackContentType: string;
  requestBody?: unknown;
  forwardedBody?: unknown;
  timing?: StageTimer;
}) {
  const model =
    stringValue(input.payload.model) || serverConfig.codexDefaultModel;
  const { response, credential, upstreamPayload } = await codexFetch(
    input.upstreamPath,
    input.payload,
    {
      stream: true,
      sourceHeaders: input.request.headers,
      channel: input.channel,
      timing: input.timing,
    },
  );
  const headers = withDefaultContentType(
    copyUpstreamHeaders(response.headers),
    input.fallbackContentType,
  );
  if (!response.ok) {
    const errorText = input.timing
      ? await input.timing.timeAsync(
          "read_upstream_error_body",
          "读取上游错误响应 Body",
          () => response.text(),
        )
      : await response.text();
    recordChannelFailure(input.channel, {
      statusCode: response.status,
      message: errorText.slice(0, 500) || response.statusText,
    });
    appendSuccessLog({
      request: input.request,
      startedAt: input.startedAt,
      start: input.start,
      apiKey: input.apiKey,
      channel: input.channel,
      credentialEmail: credential.email,
      requestType: input.requestType,
      stream: true,
      model,
      statusCode: response.status,
      usage: emptyUsage(),
      errorCode: "upstream_error",
      errorMessage: (errorText || response.statusText).slice(0, 500),
      requestBody: input.requestBody,
      forwardedBody: upstreamPayload,
      upstreamHeaders: response.headers,
      upstreamBody: errorText,
      timing: input.timing,
    });
    return new Response(errorText, { status: response.status, headers });
  }
  const fullLog = getFullRequestLoggingSetting();
  const upstreamCapture = createTextCapture();
  const body = response.body
    ? createCodexUsageMeterStream(
        tapStream(
          response.body,
          fullLog ? upstreamCapture : null,
          input.timing,
        ),
        (usage) => {
          recordChannelSuccess(input.channel);
          appendSuccessLog({
            request: input.request,
            startedAt: input.startedAt,
            start: input.start,
            apiKey: input.apiKey,
            channel: input.channel,
            credentialEmail: credential.email,
            requestType: input.requestType,
            stream: true,
            model,
            statusCode: response.status,
            usage,
            requestBody: input.requestBody,
            forwardedBody: upstreamPayload,
            upstreamHeaders: response.headers,
            upstreamBody: upstreamCapture.text,
            timing: input.timing,
          });
        },
      )
    : null;
  return new Response(body, { status: response.status, headers });
}

function createCodexUsageMeterStream(
  upstreamBody: ReadableStream<Uint8Array>,
  onCompleted: (usage: UsageSnapshot) => void,
) {
  const decoder = new TextDecoder();
  let buffer = "";
  let usage = emptyUsage();
  return upstreamBody.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        buffer = collectUsageFromSseText(
          buffer + decoder.decode(chunk, { stream: true }),
          (nextUsage) => {
            usage = nextUsage;
          },
        );
      },
      flush() {
        const tail = decoder.decode();
        if (tail) {
          buffer = collectUsageFromSseText(buffer + tail, (nextUsage) => {
            usage = nextUsage;
          });
        }
        onCompleted(usage);
      },
    }),
  );
}

function collectUsageFromSseText(
  text: string,
  onUsage: (usage: UsageSnapshot) => void,
) {
  const lines = text.split(/\r?\n/);
  const rest = lines.pop() || "";
  for (const line of lines) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      const event = JSON.parse(data) as Record<string, unknown>;
      if (event.type === "response.completed") {
        onUsage(extractUsageFromCodexResponse(event.response || event));
      }
    } catch {
      // Ignore non-JSON SSE lines.
    }
  }
  return rest;
}

function appendSuccessLog(input: {
  request: Request;
  startedAt: string;
  start: number;
  apiKey: RelayApiKeyContext;
  channel: ChannelRecord;
  credentialEmail?: string;
  requestType: string;
  stream: boolean;
  model: string;
  statusCode: number;
  usage: UsageSnapshot;
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
        appendRequestLog(logPayload),
      )
    : appendRequestLog(logPayload);
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

function appendErrorLog(
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
        appendRequestLog(logPayload),
      )
    : appendRequestLog(logPayload);
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

function appendOptionalRequestDetail(
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

function createTextCapture() {
  return {
    text: "",
    truncated: false,
    append(chunk: string) {
      if (this.truncated) {
        return;
      }
      if (this.text.length + chunk.length > DETAIL_TEXT_LIMIT) {
        this.text = `${this.text}${chunk}`.slice(0, DETAIL_TEXT_LIMIT);
        this.text += "\n...[truncated]";
        this.truncated = true;
        return;
      }
      this.text += chunk;
    },
  };
}

function tapStream(
  body: ReadableStream<Uint8Array>,
  capture: ReturnType<typeof createTextCapture> | null,
  timing?: StageTimer,
) {
  const decoder = new TextDecoder();
  const transfer = timing?.start("stream_transfer", "流式传输");
  let sawFirstChunk = false;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!sawFirstChunk) {
          sawFirstChunk = true;
          timing?.mark("stream_first_chunk", "收到上游首包");
        }
        capture?.append(decoder.decode(chunk, { stream: true }));
        controller.enqueue(chunk);
      },
      flush() {
        const tail = decoder.decode();
        if (tail) {
          capture?.append(tail);
        }
        transfer?.finish();
      },
    }),
  );
}

async function readJsonObject(request: Request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 25 * 1024 * 1024) {
    throw new HttpError(413, "body_too_large", "Request body is too large");
  }
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(
      400,
      "invalid_json_object",
      "Request body must be a JSON object",
    );
  }
  return parsed as Record<string, unknown>;
}

function withDefaultContentType(headers: Headers, contentType: string) {
  if (!headers.get("content-type")) {
    headers.set("Content-Type", contentType);
  }
  return headers;
}

function stringValue(value: unknown) {
  return typeof value === "string"
    ? value.trim()
    : typeof value === "number"
      ? String(value)
      : "";
}

function emptyUsage(): UsageSnapshot {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

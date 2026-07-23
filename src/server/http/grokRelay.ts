import "server-only";

import { grokFetch } from "@/src/server/grok/client";
import {
  chatCompletionsToCodex,
  codexResponseToChatCompletion,
  extractImageGenerationUsage,
  extractUsageFromCodexResponse,
  parseCodexSseResponse,
} from "@/src/server/codex/client";
import { createOpenAIChatSseStream } from "@/src/server/codex/chatStream";
import {
  admitRelayQuota,
  quotaResponseHeaders,
  releaseRelayQuota,
  settleRelayQuota,
} from "@/src/server/http/relayAccounting";
import { createResponsesUsageMeterStream } from "@/src/server/http/responsesUsageStream";
import {
  appendErrorLog,
  appendSuccessLog,
} from "@/src/server/http/relayRequestLogging";
import {
  createStageTimer,
  type StageTimer,
} from "@/src/server/http/stageTimer";
import {
  createTextCapture,
  copyUpstreamResponseHeaders,
  emptyUsage,
  isRecord,
  mergeHeaders,
  readJsonObject,
  tapStream,
  withDefaultContentType,
  withStreamingHeaders,
} from "@/src/server/http/relayHttpUtilities";
import { errorToResponse, HttpError } from "@/src/server/http/errors";
import { authenticateRelayRequest } from "@/src/server/services/apiKeys";
import { getFullRequestLoggingSetting } from "@/src/server/services/settings";
import {
  tenantQuotaHeaders,
  type TenantQuotaAdmission,
} from "@/src/server/services/tenantQuota";
import {
  selectGrokChannel,
  recordGrokChannelFailure,
  recordGrokChannelSuccess,
} from "@/src/server/services/grokRouting";
import {
  DEFAULT_PROVIDER_FAILOVER_ATTEMPTS,
  isRetryableProviderStatus,
  providerRetryAfterMs,
  providerUpstreamError,
  providerThrownError,
  runProviderFailover,
} from "@/src/server/services/providerFailover";
import type {
  ChannelRecord,
  RelayApiKeyContext,
} from "@/src/shared/types/entities";

type PreparedGrokRequest = { apiKey: RelayApiKeyContext };

export async function handleGrokResponses(
  request: Request,
  prepared?: PreparedGrokRequest,
) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const timing = createStageTimer();
  let apiKey: RelayApiKeyContext | null = null;
  let channel: ChannelRecord | null = null;
  let input: Record<string, unknown> | null = null;
  let admission: TenantQuotaAdmission | null = null;
  try {
    apiKey =
      prepared?.apiKey ||
      timing.time("authenticate", "认证 API Key", () =>
        authenticateRelayRequest(request),
      );
    input = await timing.timeAsync("read_request_body", "读取请求 Body", () =>
      readJsonObject(request),
    );
    const model = requiredModel(input.model);
    const stream = input.stream !== false;
    const result = await grokWithFailover(input, {
      model,
      apiKey,
      stream,
      timing,
    });
    channel = result.channel;
    admission = result.admission;
    if (!result.response.ok)
      return await logUpstreamFailure({
        request,
        startedAt,
        start,
        apiKey,
        channel,
        input,
        result,
        admission,
        requestType: "responses",
        stream,
        model,
        timing,
      });
    if (stream)
      return streamResponses({
        request,
        startedAt,
        start,
        apiKey,
        channel,
        input,
        result,
        admission,
        requestType: "responses",
        model,
        timing,
      });
    const text = await timing.timeAsync(
      "read_upstream_response_body",
      "读取上游响应 Body",
      () => result.response.text(),
    );
    const raw = timing.time("parse_upstream_response", "解析上游响应", () =>
      safeJson(text),
    );
    const usage = timing.time("extract_usage", "提取 Token 用量", () =>
      extractUsageFromCodexResponse(raw),
    );
    const imageGeneration = extractImageGenerationUsage(
      raw,
      result.upstreamPayload,
    );
    const quotaState = settleRelayQuota(
      admission,
      usage,
      result.credential.id,
      imageGeneration,
    );
    admission = null;
    recordGrokChannelSuccess(channel!);
    appendSuccessLog({
      request,
      subscriptionId: quotaState?.subscriptionId,
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
      imageGeneration,
      requestBody: input,
      forwardedBody: result.upstreamPayload,
      upstreamHeaders: result.response.headers,
      upstreamBody: text,
      timing,
    });
    return Response.json(raw, {
      status: result.response.status,
      headers: quotaResponseHeaders(quotaState),
    });
  } catch (error) {
    releaseRelayQuota(admission);
    if (channel)
      recordGrokChannelFailure(
        channel,
        502,
        error instanceof Error ? error.message : String(error),
      );
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

export async function handleGrokChatCompletions(
  request: Request,
  prepared?: PreparedGrokRequest,
) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const timing = createStageTimer();
  let apiKey: RelayApiKeyContext | null = null;
  let channel: ChannelRecord | null = null;
  let input: Record<string, unknown> | null = null;
  let admission: TenantQuotaAdmission | null = null;
  try {
    apiKey =
      prepared?.apiKey ||
      timing.time("authenticate", "认证 API Key", () =>
        authenticateRelayRequest(request),
      );
    input = await timing.timeAsync("read_request_body", "读取请求 Body", () =>
      readJsonObject(request),
    );
    const model = requiredModel(input.model);
    const stream = input.stream === true;
    const converted = timing.time(
      "normalize_payload",
      "Chat 转换为 Responses Payload",
      () =>
        chatCompletionsToCodex(input!, { stream: true, defaultModel: model }),
    );
    const result = await grokWithFailover(converted.payload, {
      model,
      apiKey,
      stream: true,
      timing,
    });
    channel = result.channel;
    admission = result.admission;
    if (!result.response.ok)
      return await logUpstreamFailure({
        request,
        startedAt,
        start,
        apiKey,
        channel,
        input,
        result,
        admission,
        requestType: "chat.completions",
        stream,
        model,
        timing,
      });
    if (stream) {
      const headers = streamingHeaders(result.response.headers, admission);
      const capture = createTextCapture();
      const full = getFullRequestLoggingSetting();
      const body = result.response.body
        ? createOpenAIChatSseStream(
            tapStream(result.response.body, full ? capture : null, timing),
            {
              fallbackModel: model,
              toolNameMaps: converted.toolNameMaps,
              includeUsage: Boolean(
                isRecord(input.stream_options) &&
                  input.stream_options.include_usage,
              ),
              onFirstToken: () =>
                timing.mark("stream_first_token", "收到首字输出"),
              onCompleted: (usage, responsePayload) => {
                const imageGeneration = extractImageGenerationUsage(
                  responsePayload,
                  result.upstreamPayload,
                );
                const quotaState = settleRelayQuota(
                  admission,
                  usage,
                  result.credential.id,
                  imageGeneration,
                );
                admission = null;
                recordGrokChannelSuccess(channel!);
                appendSuccessLog({
                  request,
                  subscriptionId: quotaState?.subscriptionId,
                  startedAt,
                  start,
                  apiKey: apiKey!,
                  channel: channel!,
                  credentialEmail: result.credential.email,
                  requestType: "chat.completions",
                  stream: true,
                  model,
                  statusCode: 200,
                  usage,
                  imageGeneration,
                  requestBody: input,
                  forwardedBody: result.upstreamPayload,
                  upstreamHeaders: result.response.headers,
                  upstreamBody: capture.text,
                  timing,
                });
              },
              onError: (error, usage) => {
                const subscriptionId = admission?.subscriptionId;
                if (usage.totalTokens > 0)
                  settleRelayQuota(admission, usage, result.credential.id);
                else releaseRelayQuota(admission);
                admission = null;
                const errorInfo = providerThrownError(error);
                recordGrokChannelFailure(
                  channel!,
                  errorInfo.statusCode,
                  errorInfo.message,
                  errorInfo.retryAfterMs,
                );
                appendSuccessLog({
                  request,
                  subscriptionId,
                  startedAt,
                  start,
                  apiKey: apiKey!,
                  channel: channel!,
                  credentialEmail: result.credential.email,
                  requestType: "chat.completions",
                  stream: true,
                  model,
                  statusCode: errorInfo.statusCode,
                  usage,
                  errorCode: errorInfo.code,
                  errorMessage: errorInfo.message.slice(0, 500),
                  requestBody: input,
                  forwardedBody: result.upstreamPayload,
                  upstreamHeaders: result.response.headers,
                  upstreamBody: capture.text,
                  error,
                  timing,
                });
              },
            },
          )
        : null;
      return new Response(body, { status: 200, headers });
    }
    const text = await timing.timeAsync(
      "read_upstream_response_body",
      "读取上游响应 Body",
      () => result.response.text(),
    );
    const raw = timing.time(
      "parse_upstream_response",
      "解析上游响应",
      () => parseCodexSseResponse(text) || safeJson(text),
    );
    const usage = timing.time("extract_usage", "提取 Token 用量", () =>
      extractUsageFromCodexResponse(raw),
    );
    const imageGeneration = extractImageGenerationUsage(
      raw,
      result.upstreamPayload,
    );
    const quotaState = settleRelayQuota(
      admission,
      usage,
      result.credential.id,
      imageGeneration,
    );
    admission = null;
    recordGrokChannelSuccess(channel!);
    appendSuccessLog({
      request,
      subscriptionId: quotaState?.subscriptionId,
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
      imageGeneration,
      requestBody: input,
      forwardedBody: result.upstreamPayload,
      upstreamHeaders: result.response.headers,
      upstreamBody: text,
      timing,
    });
    return Response.json(
      codexResponseToChatCompletion(raw, model, converted.toolNameMaps),
      { headers: quotaResponseHeaders(quotaState) },
    );
  } catch (error) {
    releaseRelayQuota(admission);
    if (channel)
      recordGrokChannelFailure(
        channel,
        502,
        error instanceof Error ? error.message : String(error),
      );
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

async function grokWithFailover(
  payload: Record<string, unknown>,
  input: {
    model: string;
    apiKey: RelayApiKeyContext;
    stream: boolean;
    timing: StageTimer;
  },
) {
  const initialSelection = input.timing.time(
    "select_channel",
    "选择 Grok 通道",
    () => selectGrokChannel({ model: input.model, apiKey: input.apiKey }),
  );
  const attempt = await runProviderFailover({
    initialContext: {
      channel: initialSelection.channel,
      credentialId: initialSelection.credential.id,
      admission: admitRelayQuota(
        input.apiKey,
        input.model,
        initialSelection.credential.id,
      ),
    },
    credentialId: (context) => context.credentialId,
    execute: (context) =>
      input.timing.timeAsync("upstream_request", "请求 Grok 上游", () =>
        grokFetch(payload, {
          channel: context.channel,
          tenant: input.apiKey.tenant,
          stream: input.stream,
        }),
      ),
    shouldRetry: (result) =>
      !result.response.ok &&
      isRetryableProviderStatus(result.response.status),
    prepareRetryResult: async (context, result) => {
      const text = await result.response.text();
      releaseRelayQuota(context.admission);
      context.admission = { ...context.admission, state: null };
      recordGrokChannelFailure(
        context.channel,
        result.response.status,
        text.slice(0, 500),
        providerRetryAfterMs(result.response.headers),
      );
      return {
        ...result,
        response: new Response(text, {
          status: result.response.status,
          headers: result.response.headers,
        }),
      };
    },
    handleAttemptError: (context, error) => {
      releaseRelayQuota(context.admission);
      context.admission = { ...context.admission, state: null };
      recordGrokChannelFailure(
        context.channel,
        502,
        error instanceof Error ? error.message : String(error),
      );
    },
    selectNext: (excludedCredentialIds) => {
      const selected = input.timing.time(
        "select_channel",
        "选择 Grok 备用通道",
        () =>
          selectGrokChannel({
            model: input.model,
            apiKey: input.apiKey,
            excludedCredentialIds: new Set(excludedCredentialIds),
          }),
      );
      return {
        channel: selected.channel,
        credentialId: selected.credential.id,
        admission: admitRelayQuota(
          input.apiKey,
          input.model,
          selected.credential.id,
        ),
      };
    },
    maxAttempts: DEFAULT_PROVIDER_FAILOVER_ATTEMPTS,
  });
  return {
    ...attempt.result,
    channel: attempt.context.channel,
    admission: attempt.context.admission,
  };
}

function requiredModel(value: unknown) {
  const model = typeof value === "string" ? value.trim() : "";
  if (!model)
    throw new HttpError(400, "model_required", "Request model is required");
  return model;
}

function streamResponses(input: {
  request: Request;
  startedAt: string;
  start: number;
  apiKey: RelayApiKeyContext;
  channel: ChannelRecord;
  input: Record<string, unknown>;
  result: Awaited<ReturnType<typeof grokFetch>>;
  admission: TenantQuotaAdmission;
  requestType: string;
  model: string;
  timing: StageTimer;
}) {
  const headers = streamingHeaders(
    input.result.response.headers,
    input.admission,
  );
  const capture = createTextCapture();
  const full = getFullRequestLoggingSetting();
  const body = input.result.response.body
    ? createResponsesUsageMeterStream(
        tapStream(
          input.result.response.body,
          full ? capture : null,
          input.timing,
        ),
        {
          onFirstToken: () =>
            input.timing.mark("stream_first_token", "收到首字输出"),
          onCompleted: (usage, responsePayload) => {
            const imageGeneration = extractImageGenerationUsage(
              responsePayload,
              input.result.upstreamPayload,
            );
            const quotaState = settleRelayQuota(
              input.admission,
              usage,
              input.result.credential.id,
              imageGeneration,
            );
            recordGrokChannelSuccess(input.channel);
            appendSuccessLog({
              request: input.request,
              subscriptionId: quotaState?.subscriptionId,
              startedAt: input.startedAt,
              start: input.start,
              apiKey: input.apiKey,
              channel: input.channel,
              credentialEmail: input.result.credential.email,
              requestType: input.requestType,
              stream: true,
              model: input.model,
              statusCode: input.result.response.status,
              usage,
              imageGeneration,
              requestBody: input.input,
              forwardedBody: input.result.upstreamPayload,
              upstreamHeaders: input.result.response.headers,
              upstreamBody: capture.text,
              timing: input.timing,
            });
          },
          onError: (error, usage) => {
            if (usage.totalTokens > 0)
              settleRelayQuota(
                input.admission,
                usage,
                input.result.credential.id,
              );
            else releaseRelayQuota(input.admission);
            const errorInfo = providerThrownError(error);
            recordGrokChannelFailure(
              input.channel,
              errorInfo.statusCode,
              errorInfo.message,
              errorInfo.retryAfterMs,
            );
            appendSuccessLog({
              request: input.request,
              subscriptionId: input.admission.subscriptionId,
              startedAt: input.startedAt,
              start: input.start,
              apiKey: input.apiKey,
              channel: input.channel,
              credentialEmail: input.result.credential.email,
              requestType: input.requestType,
              stream: true,
              model: input.model,
              statusCode: errorInfo.statusCode,
              usage,
              errorCode: errorInfo.code,
              errorMessage: errorInfo.message.slice(0, 500),
              requestBody: input.input,
              forwardedBody: input.result.upstreamPayload,
              upstreamHeaders: input.result.response.headers,
              upstreamBody: capture.text,
              error,
              timing: input.timing,
            });
          },
        },
      )
    : null;
  return new Response(body, { status: input.result.response.status, headers });
}

async function logUpstreamFailure(input: {
  request: Request;
  startedAt: string;
  start: number;
  apiKey: RelayApiKeyContext;
  channel: ChannelRecord;
  input: Record<string, unknown>;
  result: Awaited<ReturnType<typeof grokFetch>>;
  admission: TenantQuotaAdmission;
  requestType: string;
  stream: boolean;
  model: string;
  timing: StageTimer;
}) {
  releaseRelayQuota(input.admission);
  const text = await input.timing.timeAsync(
    "read_upstream_error_body",
    "读取上游错误响应 Body",
    () => input.result.response.text(),
  );
  const errorInfo = providerUpstreamError(
    text,
    input.result.response.statusText,
  );
  const message = errorInfo.message;
  recordGrokChannelFailure(
    input.channel,
    input.result.response.status,
    message,
    providerRetryAfterMs(input.result.response.headers),
  );
  appendSuccessLog({
    request: input.request,
    startedAt: input.startedAt,
    start: input.start,
    apiKey: input.apiKey,
    channel: input.channel,
    credentialEmail: input.result.credential.email,
    requestType: input.requestType,
    stream: input.stream,
    model: input.model,
    statusCode: input.result.response.status,
    usage: emptyUsage(),
    errorCode: errorInfo.code,
    errorMessage: message.slice(0, 500),
    requestBody: input.input,
    forwardedBody: input.result.upstreamPayload,
    upstreamHeaders: input.result.response.headers,
    upstreamBody: text,
    timing: input.timing,
  });
  return new Response(text, {
    status: input.result.response.status,
    headers: withDefaultContentType(
      copyUpstreamResponseHeaders(input.result.response.headers),
      "application/json; charset=utf-8",
    ),
  });
}

function streamingHeaders(source: Headers, admission: TenantQuotaAdmission) {
  const headers = withStreamingHeaders(
    withDefaultContentType(
      copyUpstreamResponseHeaders(source),
      "text/event-stream; charset=utf-8",
    ),
  );
  if (admission.state)
    mergeHeaders(headers, tenantQuotaHeaders(admission.state)).forEach(
      (value, key) => headers.set(key, value),
    );
  return headers;
}
function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return { object: "response", output: [], raw: text };
  }
}

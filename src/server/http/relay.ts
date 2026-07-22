import "server-only";

import { handleGrokChatCompletions, handleGrokResponses } from "@/src/server/http/grokRelay";
import {
  admitRelayQuota,
  quotaResponseHeaders,
  releaseRelayQuota,
  settleRelayQuota,
} from "@/src/server/http/relayAccounting";
import {
  appendErrorLog,
  appendOptionalRequestDetail,
  appendRequestLogWithAutoPrune,
  appendSuccessLog,
} from "@/src/server/http/relayRequestLogging";
import {
  assertContentLength,
  createTextCapture,
  emptyUsage,
  isFreeCodexPlan,
  isRecord,
  mergeHeaders,
  parseMaybeJson,
  readJsonObject,
  stringValue,
  tapStream,
  upstreamErrorResponse,
  withDefaultContentType,
  withStreamingHeaders,
} from "@/src/server/http/relayHttpUtilities";

import { createCodexModelsManifest, createModelsResponse } from "@/src/server/codex/models";
import {
  buildImagesApiResponseFromSseText,
  buildImagesEditsJsonRequest,
  buildImagesEditsMultipartRequest,
  buildImagesGenerationsRequest,
  createImagesSseStream,
  type CodexImagesRequest,
} from "@/src/server/codex/images";
import { createResponsesUsageMeterStream } from "@/src/server/http/responsesUsageStream";
import { codexCompactSseResponse, resolveCodexCompactionMode } from "@/src/server/codex/compaction";
import {
  chatCompletionsToCodex,
  chatCompletionsPromptCacheKey,
  codexFetch,
  codexJson,
  codexResponseToChatCompletion,
  copyUpstreamHeaders,
  extractUsageFromCodexResponse,
  extractImageGenerationUsage,
  normalizeCompactPayload,
  normalizeRawCodexCompactPayload,
  normalizeRawCodexResponsesPayload,
  normalizeResponsesPayload,
  parseCodexSseResponse,
} from "@/src/server/codex/client";
import { createOpenAIChatSseStream } from "@/src/server/codex/chatStream";
import {
  classifyCodexUpstreamError,
  type CodexUpstreamErrorInfo,
} from "@/src/server/codex/errors";
import {
  captureCodexReasoningReplay,
  clearCodexReasoningReplay,
  getCodexReplaySessionKey,
} from "@/src/server/codex/reasoningReplay";
import { serverConfig } from "@/src/server/config/env";
import { HttpError, errorToResponse } from "@/src/server/http/errors";
import {
  createStageTimer,
  type StageTimer,
} from "@/src/server/http/stageTimer";
import { authenticateRelayRequest } from "@/src/server/services/apiKeys";
import {
  recordChannelFailure,
  recordChannelSuccess,
  selectChannel,
} from "@/src/server/services/channels";
import { listPublicCodexCredentials } from "@/src/server/services/codexCredentials";
import { listRoutableModelsForApiKey, selectProviderForModel } from "@/src/server/services/relayRouting";
import { getFullRequestLoggingSetting } from "@/src/server/services/settings";
import {
  tenantQuotaHeaders,
  type TenantQuotaAdmission,
} from "@/src/server/services/tenantQuota";
import type {
  ChannelRecord,
  RelayApiKeyContext,
} from "@/src/shared/types/entities";

const MULTIPART_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

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
    const routableModels = timing.time("list_routable_models", "聚合已授权通道模型", () =>
      listRoutableModelsForApiKey(apiKey),
    );
    let payload = routableModels.length > 0 ? await timing.timeAsync(
      "create_models",
      "生成模型列表",
      () =>
        createModelsResponse({
          planType,
          openAICompatible: true,
          modelAllowlist: routableModels,
        }),
    ) : { object: "list", data: [] };
    const knownModels = new Set(payload.data.map((entry) => entry.id));
    payload = {
      ...payload,
      data: [
        ...payload.data,
        ...routableModels
          .filter((id) => !knownModels.has(id))
          .map((id) => ({ id, object: "model", owned_by: "relay" })),
      ],
    };
    const logId = appendRequestLogWithAutoPrune({
      startedAt,
      method: request.method,
      path: new URL(request.url).pathname,
      requestType: "models",
      stream: false,
      statusCode: 200,
      latencyMs: Date.now() - start,
      tenantId: apiKey.tenantId,
      tenantName: apiKey.tenant?.name,
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

export async function handleCodexModels(request: Request) {
  try {
    const apiKey = authenticateRelayRequest(request);
    const payload = await createCodexModelsManifest({
      modelAllowlist: listRoutableModelsForApiKey(apiKey),
    });
    return Response.json(payload, { headers: { "Cache-Control": "private, max-age=60" } });
  } catch (error) {
    return errorToResponse(error);
  }
}

export async function handleOpenAIResponses(request: Request) {
  const probe = await request.clone().json().catch(() => null) as Record<string, unknown> | null;
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const timing = createStageTimer();
  let apiKey: RelayApiKeyContext | null = null;
  let channel: ChannelRecord | null = null;
  let input: Record<string, unknown> | null = null;
  let quotaAdmission: TenantQuotaAdmission | null = null;
  try {
    apiKey = timing.time("authenticate", "认证 API Key", () =>
      authenticateRelayRequest(request),
    );
    const requestedModel = stringValue(probe?.model) || serverConfig.codexDefaultModel;
    const provider = timing.time("select_provider", "按通道模型声明选择上游", () =>
      selectProviderForModel({ model: requestedModel, apiKey: apiKey! }),
    );
    if (provider === "grok") {
      return handleGrokResponses(request, { apiKey });
    }
    input = await timing.timeAsync("read_request_body", "读取请求 Body", () =>
      readJsonObject(request),
    );
    const compaction = resolveCodexCompactionMode({ upstreamPath: "/responses", payload: input, headers: request.headers });
    const stream = !compaction.compact && input.stream !== false;
    const payload = timing.time("normalize_payload", "规范化请求 Payload", () =>
      compaction.compact
        ? normalizeCompactPayload(input!)
        : normalizeResponsesPayload(input!, { stream: true }),
    );
    const model = stringValue(payload.model) || serverConfig.codexDefaultModel;
    const selected = timing.time("select_channel", "选择通道", () =>
      selectChannel({ model, apiKey: apiKey! }),
    );
    channel = selected.channel;
    quotaAdmission = admitRelayQuota(apiKey, model, selected.credential.id);

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
        quotaAdmission,
      });
    }

    const result = await codexJson(compaction.upstreamPath, payload, {
      stream: true,
      sourceHeaders: request.headers,
      channel,
      tenant: apiKey.tenant,
      promptCacheKey: null,
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
    const imageGeneration = extractImageGenerationUsage(raw, result.upstreamPayload);
    const quotaState = result.response.ok
      ? settleRelayQuota(quotaAdmission, usage, result.credential.id, imageGeneration)
      : releaseRelayQuota(quotaAdmission);
    quotaAdmission = null;
    let responseErrorInfo: CodexUpstreamErrorInfo | null = null;
    if (result.response.ok && compaction.compact) {
      clearReplayAfterCompaction({ model, request, payload: result.upstreamPayload });
      recordChannelSuccess(channel);
    } else if (result.response.ok) {
      captureReplayForResponse({
        model,
        request,
        payload: result.upstreamPayload,
        response: raw,
      });
      recordChannelSuccess(channel);
    } else {
      responseErrorInfo = classifyCodexFailure({
        statusCode: result.response.status,
        bodyText: result.text,
      });
      clearReplayForRequest({
        model,
        request,
        payload: result.upstreamPayload,
        info: responseErrorInfo,
      });
      recordChannelFailure(channel, {
        statusCode: result.response.status,
        message: responseErrorInfo.message || result.text.slice(0, 500),
        retryAfterMs: responseErrorInfo.retryAfterMs,
      });
    }
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
      ...(responseErrorInfo
        ? {
            errorCode: responseErrorInfo.code,
            errorMessage: responseErrorInfo.message.slice(0, 500),
          }
        : {}),
      requestBody: input,
      forwardedBody: result.upstreamPayload,
      upstreamHeaders: result.response.headers,
      upstreamBody: result.text,
      timing,
    });
    if (!result.response.ok) {
      return upstreamErrorResponse(result.response.status);
    }
    if (compaction.clientWantsStream) {
      return new Response(codexCompactSseResponse(raw), {
        status: result.response.status,
        headers: withStreamingHeaders(new Headers({ "Content-Type": "text/event-stream; charset=utf-8" })),
      });
    }
    return Response.json(raw, {
      status: result.response.status,
      headers: quotaResponseHeaders(quotaState),
    });
  } catch (error) {
    releaseRelayQuota(quotaAdmission);
    quotaAdmission = null;
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
    exposeUpstreamErrors: false,
    normalizePayload: normalizeCompactPayload,
  });
}

export async function handleRawCodexResponses(request: Request) {
  return handleRawCodexProxy(request, {
    upstreamPath: "/responses",
    requestType: "codex.responses.raw",
    streamFromPayload: true,
    exposeUpstreamErrors: true,
    normalizePayload: normalizeRawCodexResponsesPayload,
    compactNormalizePayload: normalizeRawCodexCompactPayload,
  });
}

export async function handleRawCodexCompact(request: Request) {
  return handleRawCodexProxy(request, {
    upstreamPath: "/responses/compact",
    requestType: "codex.responses.compact.raw",
    streamFromPayload: false,
    exposeUpstreamErrors: true,
    normalizePayload: normalizeRawCodexCompactPayload,
  });
}

export async function handleImagesGenerations(request: Request) {
  return handleImagesProxy(request, {
    requestType: "images.generations",
    buildRequest: async (timing) => {
      const input = await timing.timeAsync(
        "read_request_body",
        "读取图片请求 Body",
        () => readJsonObject(request),
      );
      return timing.time("normalize_payload", "构造图片生成 Payload", () =>
        buildImagesGenerationsRequest(input),
      );
    },
  });
}

export async function handleImagesEdits(request: Request) {
  return handleImagesProxy(request, {
    requestType: "images.edits",
    buildRequest: async (timing) => {
      const contentType = request.headers.get("content-type") || "";
      if (contentType.toLowerCase().startsWith("application/json")) {
        const input = await timing.timeAsync(
          "read_request_body",
          "读取图片编辑 JSON Body",
          () => readJsonObject(request),
        );
        return timing.time("normalize_payload", "构造图片编辑 Payload", () =>
          buildImagesEditsJsonRequest(input),
        );
      }
      const formData = await timing.timeAsync(
        "read_request_body",
        "读取图片编辑 Multipart Body",
        async () => {
          try {
            assertContentLength(request, MULTIPART_BODY_LIMIT_BYTES, {
              requireKnownLength: true,
            });
            return await request.formData();
          } catch (error) {
            if (error instanceof HttpError) {
              throw error;
            }
            throw new HttpError(
              400,
              "invalid_multipart_form",
              "Request body must be valid multipart/form-data or JSON",
            );
          }
        },
      );
      return await timing.timeAsync(
        "normalize_payload",
        "构造图片编辑 Payload",
        () => buildImagesEditsMultipartRequest(formData),
      );
    },
  });
}

async function handleImagesProxy(
  request: Request,
  input: {
    requestType: string;
    buildRequest: (timing: StageTimer) => Promise<CodexImagesRequest>;
  },
) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const timing = createStageTimer();
  let apiKey: RelayApiKeyContext | null = null;
  let channel: ChannelRecord | null = null;
  let imageRequest: CodexImagesRequest | null = null;
  let quotaAdmission: TenantQuotaAdmission | null = null;
  try {
    apiKey = timing.time("authenticate", "认证 API Key", () =>
      authenticateRelayRequest(request),
    );
    imageRequest = await input.buildRequest(timing);
    const selected = timing.time("select_channel", "选择通道", () =>
      selectChannel({ model: imageRequest!.model, apiKey: apiKey! }),
    );
    channel = selected.channel;

    if (isFreeCodexPlan(selected.credential.planType)) {
      throw new HttpError(
        403,
        "image_generation_not_available",
        "Image generation is not available for Free Codex credentials",
      );
    }
    quotaAdmission = admitRelayQuota(
      apiKey,
      stringValue(imageRequest.payload.model) || imageRequest.model,
      selected.credential.id,
    );

    if (imageRequest.stream) {
      return await forwardImagesStream({
        request,
        startedAt,
        start,
        apiKey,
        channel,
        imageRequest,
        requestType: input.requestType,
        timing,
        quotaAdmission,
      });
    }

    const result = await codexJson("/responses", imageRequest.payload, {
      stream: true,
      sourceHeaders: request.headers,
      channel,
      tenant: apiKey.tenant,
      promptCacheKey: null,
      transport: "websocket",
      timing,
    });
    if (!result.response.ok) {
      const errorInfo = classifyCodexFailure({
        statusCode: result.response.status,
        bodyText: result.text,
      });
      clearReplayForRequest({
        model: stringValue(imageRequest.payload.model) || imageRequest.model,
        request,
        payload: result.upstreamPayload,
        info: errorInfo,
      });
      recordChannelFailure(channel, {
        statusCode: result.response.status,
        message: errorInfo.message || result.text.slice(0, 500),
        retryAfterMs: errorInfo.retryAfterMs,
      });
      appendSuccessLog({
        request,
        startedAt,
        start,
        apiKey,
        channel,
        credentialEmail: result.credential.email,
        requestType: input.requestType,
        stream: false,
        model: stringValue(imageRequest.payload.model) || imageRequest.model,
        statusCode: result.response.status,
        usage: emptyUsage(),
        errorCode: errorInfo.code || "upstream_error",
        errorMessage: (errorInfo.message || result.text).slice(0, 500),
        requestBody: imageRequest.requestBody,
        forwardedBody: result.upstreamPayload,
        upstreamHeaders: result.response.headers,
        upstreamBody: result.text,
        timing,
      });
      return upstreamErrorResponse(result.response.status);
    }

    const usage = extractUsageFromCodexResponse(
      parseCodexSseResponse(result.text) || result.json,
    );
    const imageGeneration = extractImageGenerationUsage(
      parseCodexSseResponse(result.text) || result.json,
      result.upstreamPayload,
    );
    const quotaState = settleRelayQuota(
      quotaAdmission,
      usage,
      result.credential.id,
      imageGeneration,
    );
    quotaAdmission = null;
    let responsePayload: Record<string, unknown>;
    try {
      responsePayload = timing.time("transform_response", "转换图片响应", () =>
        buildImagesApiResponseFromSseText(
          result.text,
          imageRequest!.responseFormat,
        ),
      );
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.status : 502;
      const errorCode =
        error instanceof HttpError ? error.code : "image_response_error";
      const message = error instanceof Error ? error.message : String(error);
      recordChannelFailure(channel, {
        statusCode,
        message,
      });
      appendSuccessLog({
        request,
        startedAt,
        start,
        apiKey,
        channel,
        credentialEmail: result.credential.email,
        requestType: input.requestType,
        stream: false,
        model: imageRequest.model,
        statusCode,
        usage,
        imageGeneration,
        errorCode,
        errorMessage: message.slice(0, 500),
        requestBody: imageRequest.requestBody,
        forwardedBody: result.upstreamPayload,
        upstreamHeaders: result.response.headers,
        upstreamBody: result.text,
        error,
        timing,
      });
      return errorToResponse(error);
    }
    recordChannelSuccess(channel);
    appendSuccessLog({
      request,
      subscriptionId: quotaState?.subscriptionId,
      startedAt,
      start,
      apiKey,
      channel,
      credentialEmail: result.credential.email,
      requestType: input.requestType,
      stream: false,
      model: stringValue(imageRequest.payload.model) || imageRequest.model,
      statusCode: 200,
      usage,
      imageGeneration,
      requestBody: imageRequest.requestBody,
      forwardedBody: result.upstreamPayload,
      upstreamHeaders: result.response.headers,
      upstreamBody: result.text,
      timing,
    });
    return Response.json(responsePayload, {
      status: 200,
      headers: quotaResponseHeaders(quotaState),
    });
  } catch (error) {
    releaseRelayQuota(quotaAdmission);
    quotaAdmission = null;
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
      imageRequest?.requestBody,
      timing,
    );
    return errorToResponse(error);
  }
}

async function forwardImagesStream(input: {
  request: Request;
  startedAt: string;
  start: number;
  apiKey: RelayApiKeyContext;
  channel: ChannelRecord;
  imageRequest: CodexImagesRequest;
  requestType: string;
  timing?: StageTimer;
  quotaAdmission?: TenantQuotaAdmission | null;
}) {
  const { response, credential, upstreamPayload } = await codexFetch(
    "/responses",
    input.imageRequest.payload,
    {
      stream: true,
      sourceHeaders: input.request.headers,
      channel: input.channel,
      tenant: input.apiKey.tenant,
      promptCacheKey: null,
      transport: "websocket",
      timing: input.timing,
    },
  );
  const headers = withStreamingHeaders(
    withDefaultContentType(
      copyUpstreamHeaders(response.headers),
      "text/event-stream; charset=utf-8",
    ),
  );
  if (input.quotaAdmission?.state) {
    mergeHeaders(
      headers,
      tenantQuotaHeaders(input.quotaAdmission.state),
    ).forEach((value, key) => headers.set(key, value));
  }
  if (!response.ok) {
    releaseRelayQuota(input.quotaAdmission);
    const errorText = input.timing
      ? await input.timing.timeAsync(
          "read_upstream_error_body",
          "读取上游错误响应 Body",
          () => response.text(),
        )
      : await response.text();
    const errorInfo = classifyCodexFailure({
      statusCode: response.status,
      bodyText: errorText,
    });
    clearReplayForRequest({
      model: stringValue(input.imageRequest.payload.model) || input.imageRequest.model,
      request: input.request,
      payload: upstreamPayload,
      info: errorInfo,
    });
    recordChannelFailure(input.channel, {
      statusCode: response.status,
      message: errorInfo.message || errorText.slice(0, 500) || response.statusText,
      retryAfterMs: errorInfo.retryAfterMs,
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
      model: input.imageRequest.model,
      statusCode: response.status,
      usage: emptyUsage(),
      errorCode: errorInfo.code || "upstream_error",
      errorMessage: (errorInfo.message || errorText || response.statusText).slice(0, 500),
      requestBody: input.imageRequest.requestBody,
      forwardedBody: upstreamPayload,
      upstreamHeaders: response.headers,
      upstreamBody: errorText,
      timing: input.timing,
    });
    return upstreamErrorResponse(response.status);
  }

  const fullLog = getFullRequestLoggingSetting();
  const upstreamCapture = createTextCapture();
  const body = response.body
    ? createImagesSseStream(
        tapStream(
          response.body,
          fullLog ? upstreamCapture : null,
          input.timing,
        ),
        {
          responseFormat: input.imageRequest.responseFormat,
          streamPrefix: input.imageRequest.streamPrefix,
          onFirstEvent: () => {
            input.timing?.mark("stream_first_token", "收到图片流首个事件");
          },
          onCompleted: (responsePayload) => {
            const usage = extractUsageFromCodexResponse(responsePayload);
            const imageGeneration = extractImageGenerationUsage(responsePayload, upstreamPayload);
            settleRelayQuota(input.quotaAdmission, usage, credential.id, imageGeneration);
            recordChannelSuccess(input.channel);
            appendSuccessLog({
              request: input.request,
              subscriptionId: input.quotaAdmission?.subscriptionId,
              startedAt: input.startedAt,
              start: input.start,
              apiKey: input.apiKey,
              channel: input.channel,
              credentialEmail: credential.email,
              requestType: input.requestType,
              stream: true,
              model: stringValue(input.imageRequest.payload.model) || input.imageRequest.model,
              statusCode: response.status,
              usage,
              imageGeneration,
              requestBody: input.imageRequest.requestBody,
              forwardedBody: upstreamPayload,
              upstreamHeaders: response.headers,
              upstreamBody: upstreamCapture.text,
              timing: input.timing,
            });
          },
          onError: (error) => {
            releaseRelayQuota(input.quotaAdmission);
            const message =
              error instanceof Error ? error.message : String(error);
            recordChannelFailure(input.channel, {
              statusCode: 502,
              message,
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
              model: stringValue(input.imageRequest.payload.model) || input.imageRequest.model,
              statusCode: 502,
              usage: emptyUsage(),
              errorCode: "stream_error",
              errorMessage: message.slice(0, 500),
              requestBody: input.imageRequest.requestBody,
              forwardedBody: upstreamPayload,
              upstreamHeaders: response.headers,
              upstreamBody: upstreamCapture.text,
              error,
              timing: input.timing,
            });
          },
        },
      )
    : null;
  return new Response(body, { status: response.status, headers });
}

export async function handleChatCompletions(request: Request) {
  const probe = await request.clone().json().catch(() => null) as Record<string, unknown> | null;
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const timing = createStageTimer();
  let apiKey: RelayApiKeyContext | null = null;
  let channel: ChannelRecord | null = null;
  let input: Record<string, unknown> | null = null;
  let quotaAdmission: TenantQuotaAdmission | null = null;
  try {
    apiKey = timing.time("authenticate", "认证 API Key", () =>
      authenticateRelayRequest(request),
    );
    const requestedModel = stringValue(probe?.model) || serverConfig.codexDefaultModel;
    const provider = timing.time("select_provider", "按通道模型声明选择上游", () =>
      selectProviderForModel({ model: requestedModel, apiKey: apiKey! }),
    );
    if (provider === "grok") {
      return handleGrokChatCompletions(request, { apiKey });
    }
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

    quotaAdmission = admitRelayQuota(apiKey, model, selected.credential.id);

    if (stream) {
      const { response, credential, upstreamPayload } = await codexFetch(
        "/responses",
        payload,
        {
          stream: true,
          sourceHeaders: request.headers,
          channel,
          tenant: apiKey.tenant,
          promptCacheKey: chatCompletionsPromptCacheKey(input),
          transport: "websocket",
          timing,
        },
      );
      if (!response.ok) {
        releaseRelayQuota(quotaAdmission);
        quotaAdmission = null;
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
        return upstreamErrorResponse(response.status);
      }
      const headers = new Headers({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      if (quotaAdmission?.state) {
        mergeHeaders(
          headers,
          tenantQuotaHeaders(quotaAdmission.state),
        ).forEach((value, key) => headers.set(key, value));
      }
      const fullLog = getFullRequestLoggingSetting();
      const upstreamCapture = createTextCapture();
      const body = response.body
        ? createOpenAIChatSseStream(
            tapStream(response.body, fullLog ? upstreamCapture : null, timing),
            {
              fallbackModel: model,
              toolNameMaps,
              includeUsage: Boolean(
                isRecord(input.stream_options) &&
                  input.stream_options.include_usage,
              ),
              onFirstToken: () => {
                timing.mark("stream_first_token", "收到首字输出");
              },
              onCompleted: (usage, responsePayload) => {
                const subscriptionId = quotaAdmission?.subscriptionId;
                const imageGeneration = extractImageGenerationUsage(responsePayload, upstreamPayload);
                settleRelayQuota(quotaAdmission, usage, credential.id, imageGeneration);
                quotaAdmission = null;
                recordChannelSuccess(channel!);
                appendSuccessLog({
                  request,
                  subscriptionId,
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
                  imageGeneration,
                  requestBody: input,
                  forwardedBody: upstreamPayload,
                  upstreamHeaders: response.headers,
                  upstreamBody: upstreamCapture.text,
                  timing,
                });
              },
              onError: (error, usage) => {
                const subscriptionId = quotaAdmission?.subscriptionId;
                if (usage.totalTokens > 0) {
                  settleRelayQuota(quotaAdmission, usage, credential.id);
                } else {
                  releaseRelayQuota(quotaAdmission);
                }
                quotaAdmission = null;
                const message =
                  error instanceof Error ? error.message : String(error);
                recordChannelFailure(channel!, {
                  statusCode: 502,
                  message,
                });
                appendSuccessLog({
                  request,
                  subscriptionId,
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
      tenant: apiKey.tenant,
      promptCacheKey: chatCompletionsPromptCacheKey(input),
      timing,
    });
    if (!result.response.ok) {
      releaseRelayQuota(quotaAdmission);
      quotaAdmission = null;
      releaseRelayQuota(quotaAdmission);
      quotaAdmission = null;
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
      return upstreamErrorResponse(result.response.status);
    }
    const raw = timing.time(
      "parse_upstream_response",
      "解析上游响应",
      () => parseCodexSseResponse(result.text) || result.json,
    );
    const usage = timing.time("extract_usage", "提取 Token 用量", () =>
      extractUsageFromCodexResponse(raw),
    );
    const imageGeneration = extractImageGenerationUsage(raw, result.upstreamPayload);
    const quotaState = settleRelayQuota(
      quotaAdmission,
      usage,
      result.credential.id,
      imageGeneration,
    );
    quotaAdmission = null;
    captureReplayForResponse({
      model,
      request,
      payload: result.upstreamPayload,
      response: raw,
    });
    recordChannelSuccess(channel);
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
      upstreamBody: result.text,
      timing,
    });
    const responsePayload = timing.time(
      "transform_response",
      "转换为 OpenAI Chat 响应",
      () => codexResponseToChatCompletion(raw, model, toolNameMaps),
    );
    return Response.json(responsePayload, {
      status: 200,
      headers: quotaResponseHeaders(quotaState),
    });
  } catch (error) {
    releaseRelayQuota(quotaAdmission);
    quotaAdmission = null;
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
    exposeUpstreamErrors: boolean;
    normalizePayload: (
      payload: Record<string, unknown>,
    ) => Record<string, unknown>;
    compactNormalizePayload?: (payload: Record<string, unknown>) => Record<string, unknown>;
  },
) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const timing = createStageTimer();
  let apiKey: RelayApiKeyContext | null = null;
  let channel: ChannelRecord | null = null;
  let rawPayload: Record<string, unknown> | null = null;
  let quotaAdmission: TenantQuotaAdmission | null = null;
  try {
    apiKey = timing.time("authenticate", "认证 API Key", () =>
      authenticateRelayRequest(request),
    );
    rawPayload = await timing.timeAsync(
      "read_request_body",
      "读取请求 Body",
      () => readJsonObject(request),
    );
    const compaction = resolveCodexCompactionMode({ upstreamPath: input.upstreamPath, payload: rawPayload, headers: request.headers });
    const payload = timing.time("normalize_payload", "规范化请求 Payload", () =>
      compaction.promoted && input.compactNormalizePayload
        ? input.compactNormalizePayload(rawPayload!)
        : input.normalizePayload(rawPayload!),
    );
    const stream = !compaction.compact && input.streamFromPayload ? payload.stream !== false : false;
    const model = stringValue(payload.model) || serverConfig.codexDefaultModel;
    const selected = timing.time("select_channel", "选择通道", () =>
      selectChannel({ model, apiKey: apiKey! }),
    );
    channel = selected.channel;
    quotaAdmission = admitRelayQuota(apiKey, model, selected.credential.id);
    if (stream) {
      return await forwardCodexStream({
        request,
        startedAt,
        start,
        apiKey,
        channel,
        payload,
        upstreamPath: compaction.upstreamPath,
        requestType: input.requestType,
        fallbackContentType: "text/event-stream; charset=utf-8",
        requestBody: rawPayload,
        forwardedBody: payload,
        exposeUpstreamErrors: input.exposeUpstreamErrors,
        timing,
        quotaAdmission,
      });
    }
    const result = await codexJson(compaction.upstreamPath, payload, {
      stream: false,
      sourceHeaders: request.headers,
      channel,
      tenant: apiKey.tenant,
      promptCacheKey: null,
      timing,
    });
    const usage = timing.time("extract_usage", "提取 Token 用量", () =>
      extractUsageFromCodexResponse(result.json),
    );
    const imageGeneration = extractImageGenerationUsage(result.json, result.upstreamPayload);
    const quotaState = result.response.ok
      ? settleRelayQuota(quotaAdmission, usage, result.credential.id, imageGeneration)
      : releaseRelayQuota(quotaAdmission);
    quotaAdmission = null;
    let responseErrorInfo: CodexUpstreamErrorInfo | null = null;
    if (result.response.ok && compaction.compact) {
      clearReplayAfterCompaction({ model, request, payload: result.upstreamPayload });
      recordChannelSuccess(channel);
    } else if (result.response.ok) {
      captureReplayForResponse({
        model,
        request,
        payload: result.upstreamPayload,
        response: result.json,
      });
      recordChannelSuccess(channel);
    } else {
      responseErrorInfo = classifyCodexFailure({
        statusCode: result.response.status,
        bodyText: result.text,
      });
      clearReplayForRequest({
        model,
        request,
        payload: result.upstreamPayload,
        info: responseErrorInfo,
      });
      recordChannelFailure(channel, {
        statusCode: result.response.status,
        message: responseErrorInfo.message || result.text.slice(0, 500),
        retryAfterMs: responseErrorInfo.retryAfterMs,
      });
    }
    appendSuccessLog({
      request,
      subscriptionId: quotaState?.subscriptionId,
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
      imageGeneration,
      ...(responseErrorInfo
        ? {
            errorCode: responseErrorInfo.code,
            errorMessage: responseErrorInfo.message.slice(0, 500),
          }
        : {}),
      requestBody: rawPayload,
      forwardedBody: result.upstreamPayload,
      upstreamHeaders: result.response.headers,
      upstreamBody: result.text,
      timing,
    });
    if (!result.response.ok && !input.exposeUpstreamErrors) {
      return upstreamErrorResponse(result.response.status);
    }
    if (compaction.clientWantsStream) {
      return new Response(codexCompactSseResponse(result.json), {
        status: result.response.status,
        headers: withStreamingHeaders(new Headers({ "Content-Type": "text/event-stream; charset=utf-8" })),
      });
    }
    return new Response(result.text, {
      status: result.response.status,
      headers: mergeHeaders(
        withDefaultContentType(
          copyUpstreamHeaders(result.response.headers),
          "application/json; charset=utf-8",
        ),
        quotaResponseHeaders(quotaState),
      ),
    });
  } catch (error) {
    releaseRelayQuota(quotaAdmission);
    quotaAdmission = null;
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
  exposeUpstreamErrors?: boolean;
  promptCacheKey?: string | null;
  timing?: StageTimer;
  quotaAdmission?: TenantQuotaAdmission | null;
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
      tenant: input.apiKey.tenant,
      promptCacheKey: input.promptCacheKey,
      transport: input.upstreamPath === "/responses" ? "websocket" : "http",
      timing: input.timing,
    },
  );
  const headers = withStreamingHeaders(
    withDefaultContentType(
      copyUpstreamHeaders(response.headers),
      input.fallbackContentType,
    ),
  );
  if (input.quotaAdmission?.state) {
    mergeHeaders(
      headers,
      tenantQuotaHeaders(input.quotaAdmission.state),
    ).forEach((value, key) => headers.set(key, value));
  }
  if (!response.ok) {
    releaseRelayQuota(input.quotaAdmission);
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
    if (input.exposeUpstreamErrors) {
      return new Response(errorText, { status: response.status, headers });
    }
    return upstreamErrorResponse(response.status);
  }
  const fullLog = getFullRequestLoggingSetting();
  const upstreamCapture = createTextCapture();
  const body = response.body
    ? createResponsesUsageMeterStream(
        tapStream(
          response.body,
          fullLog ? upstreamCapture : null,
          input.timing,
        ),
        {
          onCompleted: (usage, responsePayload) => {
            const imageGeneration = extractImageGenerationUsage(responsePayload, upstreamPayload);
            const quotaState = settleRelayQuota(
              input.quotaAdmission,
              usage,
              credential.id,
              imageGeneration,
            );
            if (quotaState) {
              mergeHeaders(
                headers,
                quotaResponseHeaders(quotaState),
              ).forEach((value, key) => headers.set(key, value));
            }
            captureReplayForResponse({
              model,
              request: input.request,
              payload: upstreamPayload,
              response: responsePayload,
            });
            recordChannelSuccess(input.channel);
            appendSuccessLog({
              request: input.request,
              subscriptionId: quotaState?.subscriptionId,
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
              imageGeneration,
              requestBody: input.requestBody,
              forwardedBody: upstreamPayload,
              upstreamHeaders: response.headers,
              upstreamBody: upstreamCapture.text,
              timing: input.timing,
            });
          },
          onError: (error, usage) => {
            if (usage.totalTokens > 0) {
              settleRelayQuota(input.quotaAdmission, usage, credential.id);
            } else {
              releaseRelayQuota(input.quotaAdmission);
            }
            const errorInfo = codexErrorInfoFromError(error);
            const message =
              errorInfo?.message ||
              (error instanceof Error ? error.message : String(error));
            clearReplayForRequest({
              model,
              request: input.request,
              payload: upstreamPayload,
              info: errorInfo,
            });
            recordChannelFailure(input.channel, {
              statusCode: errorInfo?.statusCode || 502,
              message,
              retryAfterMs: errorInfo?.retryAfterMs,
            });
            appendSuccessLog({
              request: input.request,
              subscriptionId: input.quotaAdmission?.subscriptionId,
              startedAt: input.startedAt,
              start: input.start,
              apiKey: input.apiKey,
              channel: input.channel,
              credentialEmail: credential.email,
              requestType: input.requestType,
              stream: true,
              model,
              statusCode: errorInfo?.statusCode || 502,
              usage,
              errorCode: errorInfo?.code || "stream_error",
              errorMessage: message.slice(0, 500),
              requestBody: input.requestBody,
              forwardedBody: upstreamPayload,
              upstreamHeaders: response.headers,
              upstreamBody: upstreamCapture.text,
              error,
              timing: input.timing,
            });
          },
          onFirstToken: () => {
            input.timing?.mark("stream_first_token", "收到首字输出");
          },
        },
      )
    : null;
  return new Response(body, { status: response.status, headers });
}

function captureReplayForResponse(input: {
  model: string;
  request: Request;
  payload: unknown;
  response: unknown;
}) {
  const sessionKey = getCodexReplaySessionKey({
    payload: input.payload,
    headers: input.request.headers,
  });
  if (!sessionKey) {
    return;
  }
  captureCodexReasoningReplay({
    model: input.model,
    sessionKey,
    response: input.response,
  });
}

function classifyCodexFailure(input: {
  statusCode: number;
  bodyText?: string | null;
  body?: unknown;
}) {
  const body =
    input.body !== undefined
      ? input.body
      : parseMaybeJson<unknown>(input.bodyText || "") || input.bodyText || "";
  return classifyCodexUpstreamError({
    statusCode: input.statusCode,
    body,
  });
}

function clearReplayForRequest(input: {
  model: string;
  request: Request;
  payload: unknown;
  info: CodexUpstreamErrorInfo | null | undefined;
}) {
  if (!input.info?.clearReplay) {
    return;
  }
  const sessionKey = getCodexReplaySessionKey({
    payload: input.payload,
    headers: input.request.headers,
  });
  if (!sessionKey) {
    return;
  }
  clearCodexReasoningReplay({ model: input.model, sessionKey });
}

function clearReplayAfterCompaction(input: {
  model: string;
  request: Request;
  payload: unknown;
}) {
  const sessionKey = getCodexReplaySessionKey({ payload: input.payload, headers: input.request.headers });
  if (sessionKey) clearCodexReasoningReplay({ model: input.model, sessionKey });
}

function codexErrorInfoFromError(error: unknown) {
  if (!error || typeof error !== "object") {
    return null;
  }
  const withInfo = error as { codexErrorInfo?: CodexUpstreamErrorInfo | null };
  return withInfo.codexErrorInfo || null;
}


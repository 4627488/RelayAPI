import "server-only";
import { proxiedFetch } from "@/src/server/net/proxy";
import {
  ensureFreshGrokCredential,
  forceRefreshGrokCredential,
} from "@/src/server/services/grokCredentials";
import { resolveProviderCredentialProxy } from "@/src/server/services/providerProxy";
import {
  prepareGrokPayload,
  restoreNamespaceCalls,
  type NamespaceTool,
} from "@/src/server/grok/compat";
import { codexWebSocketResponse } from "@/src/server/codex/websocket";
import type {
  ChannelRecord,
  TenantRuntimeContext,
} from "@/src/shared/types/entities";
import { providerCredentialDefaultBaseUrl } from "@/src/shared/providerCapabilities";

const CLIENT_VERSION = "0.2.93";
export async function grokFetch(
  payload: Record<string, unknown>,
  input: {
    channel: ChannelRecord;
    tenant?: TenantRuntimeContext | null;
    stream: boolean;
  },
) {
  let credential = await ensureFreshGrokCredential(input.channel.credentialId);
  const oauth = credential.authType === "oauth";
  const token = oauth
    ? credential.tokens.access_token
    : credential.tokens.api_key;
  const base = (
    credential.grokBaseUrl ||
    input.channel.baseUrl ||
    providerCredentialDefaultBaseUrl(credential, "")
  ).replace(/\/+$/, "");
  const proxy = resolveProviderCredentialProxy({
    proxy: credential.proxy,
    proxyPoolId: credential.proxyPoolId,
    useGlobalProxy: input.tenant ? true : credential.useGlobalProxy,
    tenantProxy: input.tenant?.proxy || null,
  });
  let headers = buildHeaders(
    token,
    oauth,
    input.stream,
    credential.metadata.grok_headers,
  );
  const useWebSocket = input.stream && credential.upstreamTransport !== "http";
  const requestedModel = text(payload.model);
  const upstreamModel =
    credential.grokModelAliases[requestedModel] || requestedModel;
  const mappedPayload = upstreamModel
    ? { ...payload, model: upstreamModel }
    : payload;
  const prepared = prepareGrokPayload(
    { ...mappedPayload, stream: input.stream },
    {
      nativeXSearch: credential.metadata.grok_native_x_search !== false,
      clientToolCache: credential.metadata.grok_client_tool_cache !== false,
      websocket: useWebSocket,
    },
  );
  const httpExecute = () =>
    proxiedFetch(
      `${base}/responses`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(
          prepareGrokPayload(
            { ...mappedPayload, stream: input.stream },
            {
              nativeXSearch: credential.grokNativeXSearch,
              clientToolCache: credential.grokClientToolCache,
            },
          ).payload,
        ),
        signal: AbortSignal.timeout(input.stream ? 1_800_000 : 300_000),
      },
      proxy,
    );
  const wsExecute = () =>
    codexWebSocketResponse({
      httpUrl: `${base}/responses`,
      headers,
      payload: prepared.payload,
      proxy,
      includeBetaHeader: false,
    });
  let response: Response;
  try {
    response = useWebSocket ? await wsExecute() : await httpExecute();
  } catch (error) {
    if (credential.upstreamTransport === "websocket") throw error;
    response = await httpExecute();
  }
  if (!response.ok && useWebSocket && credential.upstreamTransport === "auto") {
    await response.body?.cancel().catch(() => undefined);
    response = await httpExecute();
  }
  if (response.status === 401 && oauth && credential.tokens.refresh_token) {
    await response.body?.cancel().catch(() => undefined);
    credential = await forceRefreshGrokCredential(credential.id);
    headers = buildHeaders(
      credential.tokens.access_token,
      true,
      input.stream,
      credential.metadata.grok_headers,
    );
    response = useWebSocket ? await wsExecute() : await httpExecute();
  }
  if (
    response.ok &&
    (prepared.namespaceTools.size > 0 || requestedModel !== upstreamModel)
  )
    response = restoreGrokResponse(
      response,
      prepared.namespaceTools,
      input.stream,
      upstreamModel,
      requestedModel,
    );
  return { response, credential, upstreamPayload: prepared.payload };
}

function restoreGrokResponse(
  response: Response,
  refs: Map<string, NamespaceTool>,
  stream: boolean,
  upstreamModel: string,
  requestedModel: string,
) {
  if (!response.body) return response;
  const body = stream
    ? response.body.pipeThrough(
        namespaceSseTransform(refs, upstreamModel, requestedModel),
      )
    : response.body.pipeThrough(
        namespaceJsonTransform(refs, upstreamModel, requestedModel),
      );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
function namespaceSseTransform(
  refs: Map<string, NamespaceTool>,
  upstreamModel: string,
  requestedModel: string,
) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const rewrite = (source: string) =>
    source
      .split("\n")
      .map((line) => {
        if (!line.startsWith("data:")) return line;
        const json = line.slice(5).trimStart();
        if (!json || json === "[DONE]") return line;
        try {
          return `data: ${JSON.stringify(restoreModel(restoreNamespaceCalls(JSON.parse(json), refs), upstreamModel, requestedModel))}`;
        } catch {
          return line;
        }
      })
      .join("\n");
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const boundary = pending.lastIndexOf("\n");
      if (boundary < 0) return;
      controller.enqueue(
        encoder.encode(rewrite(pending.slice(0, boundary + 1))),
      );
      pending = pending.slice(boundary + 1);
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending) controller.enqueue(encoder.encode(rewrite(pending)));
    },
  });
}
function namespaceJsonTransform(
  refs: Map<string, NamespaceTool>,
  upstreamModel: string,
  requestedModel: string,
) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let body = "";
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk) {
      body += decoder.decode(chunk, { stream: true });
    },
    flush(controller) {
      body += decoder.decode();
      try {
        controller.enqueue(
          encoder.encode(
            JSON.stringify(
              restoreModel(
                restoreNamespaceCalls(JSON.parse(body), refs),
                upstreamModel,
                requestedModel,
              ),
            ),
          ),
        );
      } catch {
        controller.enqueue(encoder.encode(body));
      }
    },
  });
}
function restoreModel(
  value: unknown,
  upstreamModel: string,
  requestedModel: string,
): unknown {
  if (!upstreamModel || !requestedModel || upstreamModel === requestedModel)
    return value;
  if (Array.isArray(value))
    return value.map((item) =>
      restoreModel(item, upstreamModel, requestedModel),
    );
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === "model" && child === upstreamModel
        ? requestedModel
        : restoreModel(child, upstreamModel, requestedModel),
    ]),
  );
}
function buildHeaders(
  token: string,
  oauth: boolean,
  stream: boolean,
  custom: unknown,
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    ...(oauth
      ? {
          "X-XAI-Token-Auth": "xai-grok-cli",
          "X-Grok-Client-Version": CLIENT_VERSION,
        }
      : {}),
  };
  const values =
    custom && typeof custom === "object" && !Array.isArray(custom)
      ? (custom as Record<string, unknown>)
      : {};
  for (const [name, value] of Object.entries(values))
    if (safeHeader(name) && typeof value === "string") headers[name] = value;
  return headers;
}
function safeHeader(name: string) {
  return ![
    "authorization",
    "content-type",
    "accept",
    "host",
    "content-length",
    "x-xai-token-auth",
  ].includes(name.trim().toLowerCase());
}
function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export {
  prepareGrokPayload,
  restoreNamespaceCalls,
} from "@/src/server/grok/compat";

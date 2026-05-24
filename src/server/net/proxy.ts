import "server-only";

import nodeFetch, {
  type RequestInit as NodeFetchRequestInit,
} from "node-fetch";
import { HttpError } from "@/src/server/http/errors";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { CredentialProxyConfig } from "@/src/shared/types/entities";

type CachedProxyAgent = {
  agent: SocksProxyAgent;
  lastUsedAt: number;
};

const proxyAgents = new Map<string, CachedProxyAgent>();
const PROXY_AGENT_IDLE_TTL_MS = 10 * 60 * 1000;
const PROXY_AGENT_RETRYABLE_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const UPSTREAM_FETCH_RETRY_DELAYS_MS = [250, 1_000];

export async function proxiedFetch(
  url: string,
  init: RequestInit = {},
  proxy: CredentialProxyConfig | null | undefined,
): Promise<Response> {
  if (!proxy?.enabled) {
    return retryUpstreamFetch(url, init, () => fetch(url, init));
  }

  const proxyKey = proxyUrl(proxy);
  cleanupIdleProxyAgents();

  try {
    return await doProxyFetch(url, init, proxyKey);
  } catch (error) {
    if (!isRetryableProxyError(error)) {
      throw wrapProxyError(proxy, error);
    }

    destroyProxyAgent(proxyKey);
    try {
      return await doProxyFetch(url, init, proxyKey);
    } catch (retryError) {
      throw wrapProxyError(proxy, retryError);
    }
  }
}

async function doProxyFetch(
  url: string,
  init: RequestInit,
  proxyKey: string,
): Promise<Response> {
  const agent = getProxyAgent(proxyKey);
  const response = await nodeFetch(url, {
    method: init.method,
    headers: init.headers as NodeFetchRequestInit["headers"],
    body: init.body as NodeFetchRequestInit["body"],
    signal: init.signal as NodeFetchRequestInit["signal"],
    redirect: init.redirect as NodeFetchRequestInit["redirect"],
    agent,
  });

  const headers = new Headers();
  response.headers.forEach((value, name) => headers.append(name, value));
  const body = response.body
    ? wrapProxyBodyStream(
        response.body as unknown as NodeReadableBody,
        proxyKey,
      )
    : null;

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function retryUpstreamFetch(
  url: string,
  init: RequestInit,
  fetchOnce: () => Promise<Response>,
) {
  let lastError: unknown;
  for (
    let attempt = 0;
    attempt <= UPSTREAM_FETCH_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    try {
      return await fetchOnce();
    } catch (error) {
      lastError = error;
      if (
        attempt >= UPSTREAM_FETCH_RETRY_DELAYS_MS.length ||
        init.signal?.aborted ||
        !isRetryableProxyError(error)
      ) {
        throw upstreamNetworkError(url, error);
      }
      await abortableDelay(UPSTREAM_FETCH_RETRY_DELAYS_MS[attempt], init.signal);
    }
  }
  throw upstreamNetworkError(url, lastError);
}

function abortableDelay(ms: number, signal?: AbortSignal | null) {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

type NodeReadableBody = {
  on(event: "data", listener: (chunk: unknown) => void): NodeReadableBody;
  once(event: "end" | "close", listener: () => void): NodeReadableBody;
  once(event: "error", listener: (error: unknown) => void): NodeReadableBody;
  off?(event: string, listener: (...args: never[]) => void): NodeReadableBody;
  destroy?(error?: Error): void;
  resume?(): void;
};

function wrapProxyBodyStream(
  body: NodeReadableBody,
  proxyKey: string,
): ReadableStream<Uint8Array> {
  let ended = false;
  let canceled = false;
  let cleaned = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  function cleanup() {
    if (cleaned) {
      return;
    }
    cleaned = true;
    body.off?.("data", onData as (...args: never[]) => void);
    body.off?.("end", onEnd as (...args: never[]) => void);
    body.off?.("close", onClose as (...args: never[]) => void);
    body.off?.("error", onError as (...args: never[]) => void);
  }

  function onData(chunk: unknown) {
    try {
      controllerRef?.enqueue(toUint8Array(chunk));
    } catch {
      canceled = true;
      cleanup();
      body.destroy?.();
    }
  }

  function onEnd() {
    ended = true;
    cleanup();
    try {
      controllerRef?.close();
    } catch {
      // The downstream response may already be closed by the client.
    }
  }

  function onClose() {
    if (ended || canceled) {
      cleanup();
      return;
    }
    const error = new Error(
      "Proxy response body closed before upstream stream completed",
    );
    cleanup();
    destroyProxyAgent(proxyKey);
    controllerRef?.error(error);
  }

  function onError(error: unknown) {
    cleanup();
    if (isRetryableProxyError(error)) {
      destroyProxyAgent(proxyKey);
    }
    controllerRef?.error(error);
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      body.on("data", onData);
      body.once("end", onEnd);
      body.once("close", onClose);
      body.once("error", onError);
      body.resume?.();
    },
    cancel(reason) {
      canceled = true;
      cleanup();
      body.destroy?.(
        reason instanceof Error ? reason : new Error("Proxy response canceled"),
      );
    },
  });
}

function toUint8Array(value: unknown) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  return new Uint8Array();
}

function getProxyAgent(proxyKey: string) {
  const existing = proxyAgents.get(proxyKey);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing.agent;
  }

  const agent = new SocksProxyAgent(proxyKey, {
    // SOCKS tunnels for long-lived SSE streams are more stable when sockets
    // are not reused after GOST/NAT/upstream half-closes an idle connection.
    keepAlive: false,
    maxSockets: 64,
    timeout: 120_000,
  });
  proxyAgents.set(proxyKey, { agent, lastUsedAt: Date.now() });
  return agent;
}

function destroyProxyAgent(proxyKey: string) {
  const cached = proxyAgents.get(proxyKey);
  if (!cached) {
    return;
  }
  proxyAgents.delete(proxyKey);
  cached.agent.destroy();
}

function cleanupIdleProxyAgents() {
  const now = Date.now();
  for (const [proxyKey, cached] of proxyAgents.entries()) {
    if (now - cached.lastUsedAt < PROXY_AGENT_IDLE_TTL_MS) {
      continue;
    }
    proxyAgents.delete(proxyKey);
    cached.agent.destroy();
  }
}

function isRetryableProxyError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const current = error as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };

  const code = String(current.code || "").toUpperCase();
  if (code && PROXY_AGENT_RETRYABLE_ERROR_CODES.has(code)) {
    return true;
  }

  const message = String(current.message || "").toLowerCase();
  if (
    message.includes("premature close") ||
    message.includes("premature socket close") ||
    message.includes("socket hang up") ||
    message.includes("other side closed") ||
    message.includes("socket") ||
    message.includes("timed out") ||
    message.includes("getaddrinfo") ||
    message.includes("econnreset") ||
    message.includes("eai_again") ||
    message.includes("aborted") ||
    message.includes("network")
  ) {
    return true;
  }

  if (current.cause && current.cause !== error) {
    return isRetryableProxyError(current.cause);
  }

  return false;
}

function proxyUrl(proxy: CredentialProxyConfig) {
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
    : "";
  return `${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
}

function publicProxyLabel(proxy: CredentialProxyConfig) {
  return `${proxy.type}://${proxy.host}:${proxy.port}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "request failed";
}

function upstreamHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function upstreamNetworkError(url: string, error: unknown) {
  if (error instanceof HttpError) {
    return error;
  }
  return new HttpError(
    502,
    "upstream_network_error",
    `Upstream network request failed for ${upstreamHost(url)}: ${errorMessage(error)}`,
    { cause: error },
  );
}

function wrapProxyError(proxy: CredentialProxyConfig, error: unknown) {
  if (error instanceof HttpError) {
    return error;
  }
  return new HttpError(
    502,
    "upstream_network_error",
    `Proxy request failed via ${publicProxyLabel(proxy)}: ${errorMessage(error)}`,
    { proxy: publicProxyLabel(proxy), cause: error },
  );
}

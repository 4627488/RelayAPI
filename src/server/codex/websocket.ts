import "server-only";

import type { IncomingMessage } from "node:http";
import { SocksProxyAgent } from "socks-proxy-agent";
import WebSocket, { type RawData } from "ws";
import type { CredentialProxyConfig } from "@/src/shared/types/entities";

const CODEX_RESPONSES_WEBSOCKET_BETA = "responses_websockets=2026-02-06";
const CODEX_RESPONSES_WEBSOCKET_HANDSHAKE_MS = 30_000;

export async function codexWebSocketResponse(input: {
  httpUrl: string;
  headers: HeadersInit;
  payload: Record<string, unknown>;
  proxy?: CredentialProxyConfig | null;
  timeoutMs?: number;
}) {
  const wsUrl = codexWebSocketUrl(input.httpUrl);
  const headers = codexWebSocketHeaders(input.headers);
  const agent = input.proxy?.enabled
    ? new SocksProxyAgent(proxyUrl(input.proxy))
    : undefined;
  const ws = new WebSocket(wsUrl, {
    headers,
    agent,
    handshakeTimeout: input.timeoutMs ?? CODEX_RESPONSES_WEBSOCKET_HANDSHAKE_MS,
    perMessageDeflate: true,
  });
  const payload = JSON.stringify(codexWebSocketRequestPayload(input.payload));
  const encoder = new TextEncoder();

  let opened: true | Response;
  try {
    opened = await waitForOpenOrRejection(ws, input.timeoutMs);
  } catch (error) {
    agent?.destroy();
    ws.terminate();
    throw error;
  }
  if (opened instanceof Response) {
    agent?.destroy();
    return opened;
  }

  let closed = false;
  let cleaned = false;
  function cleanup() {
    if (cleaned) {
      return;
    }
    cleaned = true;
    agent?.destroy();
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      ws.on("message", (data) => {
        if (closed) {
          return;
        }
        const text = webSocketDataToText(data).trim();
        if (!text) {
          return;
        }
        const normalized = normalizeCodexWebSocketEvent(text);
        controller.enqueue(encoder.encode(`data: ${normalized}\n\n`));
        const type = eventType(normalized);
        if (type === "response.completed" || type === "error") {
          closed = true;
          controller.close();
          cleanup();
          ws.close();
        }
      });
      ws.on("error", (error) => {
        if (closed) {
          return;
        }
        closed = true;
        cleanup();
        controller.error(error);
      });
      ws.on("close", () => {
        cleanup();
        if (closed) {
          return;
        }
        closed = true;
        controller.close();
      });
      ws.send(payload, (error) => {
        if (!error || closed) {
          return;
        }
        closed = true;
        cleanup();
        controller.error(error);
        ws.terminate();
      });
    },
    cancel() {
      closed = true;
      cleanup();
      ws.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function waitForOpenOrRejection(
  ws: WebSocket,
  timeoutMs = CODEX_RESPONSES_WEBSOCKET_HANDSHAKE_MS,
) {
  return new Promise<true | Response>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("Codex websocket handshake timed out"));
    }, timeoutMs);
    let settled = false;

    function settle(value: true | Response) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }

    ws.on("open", () => settle(true));
    ws.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    ws.on("unexpected-response", async (_request, response) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        const body = await incomingMessageText(response);
        resolve(
          new Response(body, {
            status: response.statusCode || 502,
            statusText: response.statusMessage,
            headers: incomingMessageHeaders(response),
          }),
        );
      } catch (error) {
        reject(error);
      }
    });
  });
}

function codexWebSocketUrl(httpUrl: string) {
  const url = new URL(httpUrl);
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else {
    throw new Error(`Unsupported Codex websocket URL scheme: ${url.protocol}`);
  }
  return url.toString();
}

function codexWebSocketHeaders(headers: HeadersInit) {
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    if (key.toLowerCase() === "content-type") {
      return;
    }
    out[key] = value;
  });
  out["OpenAI-Beta"] = betaHeaderWithResponsesWebSockets(out["OpenAI-Beta"]);
  return out;
}

function betaHeaderWithResponsesWebSockets(value: string | undefined) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return CODEX_RESPONSES_WEBSOCKET_BETA;
  }
  if (trimmed.includes("responses_websockets=")) {
    return trimmed;
  }
  return `${trimmed},${CODEX_RESPONSES_WEBSOCKET_BETA}`;
}

function codexWebSocketRequestPayload(payload: Record<string, unknown>) {
  return {
    ...structuredClone(payload),
    type: "response.create",
  };
}

function normalizeCodexWebSocketEvent(text: string) {
  try {
    const event = JSON.parse(text) as Record<string, unknown>;
    if (event.type === "response.done") {
      event.type = "response.completed";
      return JSON.stringify(event);
    }
  } catch {
    return text;
  }
  return text;
}

function eventType(text: string) {
  try {
    const event = JSON.parse(text) as { type?: unknown };
    return typeof event.type === "string" ? event.type : "";
  } catch {
    return "";
  }
}

function webSocketDataToText(data: RawData) {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return "";
}

function incomingMessageHeaders(response: IncomingMessage) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else if (value !== undefined) {
      headers.set(key, String(value));
    }
  }
  return headers;
}

function incomingMessageText(response: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    response.once("error", reject);
  });
}

function proxyUrl(proxy: CredentialProxyConfig) {
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
    : "";
  return `${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
}

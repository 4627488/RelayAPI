import "server-only";

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
  if (input.proxy?.enabled) {
    throw new Error("Bun native WebSocket does not support SOCKS proxy");
  }
  const wsUrl = codexWebSocketUrl(input.httpUrl);
  const headers = codexWebSocketHeaders(input.headers);
  const BunWebSocket = globalThis.WebSocket as unknown as new (
    url: string,
    options?: { headers?: Record<string, string> },
  ) => WebSocket;
  const ws = new BunWebSocket(wsUrl, { headers });
  const payload = JSON.stringify(codexWebSocketRequestPayload(input.payload));
  const encoder = new TextEncoder();

  try {
    await waitForBunWebSocketOpen(ws, input.timeoutMs);
  } catch (error) {
    ws.close();
    throw error;
  }

  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      ws.addEventListener("message", (event: MessageEvent) => {
        if (closed) {
          return;
        }
        const text = webSocketDataToText(event.data).trim();
        if (!text) {
          return;
        }
        const normalized = normalizeCodexWebSocketEvent(text);
        controller.enqueue(encoder.encode(`data: ${normalized}\n\n`));
        const type = eventType(normalized);
        if (type === "response.completed" || type === "error") {
          closed = true;
          controller.close();
          ws.close();
        }
      });
      ws.addEventListener("error", () => {
        if (closed) {
          return;
        }
        closed = true;
        controller.error(new Error("Codex websocket failed"));
      });
      ws.addEventListener("close", () => {
        if (closed) {
          return;
        }
        closed = true;
        controller.close();
      });
      ws.send(payload);
    },
    cancel() {
      closed = true;
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

function waitForBunWebSocketOpen(
  ws: WebSocket,
  timeoutMs = CODEX_RESPONSES_WEBSOCKET_HANDSHAKE_MS,
) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Codex websocket handshake timed out"));
    }, timeoutMs);
    let settled = false;

    function settle(error?: Error) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    }

    ws.addEventListener("open", () => settle(), { once: true });
    ws.addEventListener(
      "error",
      () => settle(new Error("Codex websocket handshake failed")),
      { once: true },
    );
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

function webSocketDataToText(data: unknown) {
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
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  }
  return "";
}

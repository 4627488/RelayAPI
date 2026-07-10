import "server-only";

import type { IncomingMessage } from "node:http";
import { SocksProxyAgent } from "socks-proxy-agent";
import WebSocket, { type RawData } from "ws";
import type { CredentialProxyConfig } from "@/src/shared/types/entities";

const CODEX_RESPONSES_WEBSOCKET_BETA = "responses_websockets=2026-02-06";
const CODEX_RESPONSES_WEBSOCKET_HANDSHAKE_MS = 30_000;
const CODEX_RESPONSES_WEBSOCKET_IDLE_MS = 5 * 60_000;
const CODEX_RESPONSES_WEBSOCKET_KEEPALIVE_MS = 30_000;

type WebSocketEventName =
  | "open"
  | "message"
  | "error"
  | "close"
  | "pong"
  | "unexpected-response";

interface CodexWebSocketLike {
  send(data: string, callback?: (error?: Error) => void): void;
  ping?(callback?: (error?: Error) => void): void;
  close(): void;
  terminate(): void;
  on(event: WebSocketEventName, handler: (...args: unknown[]) => void): this;
  off(event: WebSocketEventName, handler: (...args: unknown[]) => void): this;
}

interface CodexWebSocketFactoryResult {
  socket: CodexWebSocketLike;
  cleanup?: () => void;
}

type CodexWebSocketFactory = (input: {
  httpUrl: string;
  headers: HeadersInit;
  proxy?: CredentialProxyConfig | null;
  timeoutMs?: number;
}) => CodexWebSocketFactoryResult;

interface CodexWebSocketSession {
  key: string;
  socket: CodexWebSocketLike;
  cleanup?: () => void;
  inFlight: Promise<void>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  awaitingPong: boolean;
  detachSessionListeners: () => void;
}

class RetryableWebSocketSendError extends Error {
  readonly retryableBeforeFirstEvent = true;

  constructor(error: Error) {
    super(error.message, { cause: error });
    this.name = "RetryableWebSocketSendError";
  }
}

export async function codexWebSocketResponse(input: {
  httpUrl: string;
  headers: HeadersInit;
  payload: Record<string, unknown>;
  proxy?: CredentialProxyConfig | null;
  timeoutMs?: number;
  sessionKey?: string | null;
}) {
  const sessionKey = stringValue(input.sessionKey).trim();
  if (sessionKey) {
    return codexWebSocketSessions.request({ ...input, sessionKey });
  }
  return singleUseCodexWebSocketResponse(input);
}

async function singleUseCodexWebSocketResponse(input: {
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

export class CodexWebSocketSessionManager {
  private readonly sessions = new Map<string, CodexWebSocketSession>();
  private readonly factory: CodexWebSocketFactory;
  private readonly idleTimeoutMs: number;
  private readonly keepAliveIntervalMs: number;

  constructor(input?: {
    factory?: CodexWebSocketFactory;
    idleTimeoutMs?: number;
    keepAliveIntervalMs?: number;
  }) {
    this.factory = input?.factory || createCodexWebSocketConnection;
    this.idleTimeoutMs =
      input?.idleTimeoutMs ?? CODEX_RESPONSES_WEBSOCKET_IDLE_MS;
    this.keepAliveIntervalMs =
      input?.keepAliveIntervalMs ?? CODEX_RESPONSES_WEBSOCKET_KEEPALIVE_MS;
  }

  async request(input: {
    sessionKey: string;
    httpUrl: string;
    headers: HeadersInit;
    payload: Record<string, unknown>;
    proxy?: CredentialProxyConfig | null;
    timeoutMs?: number;
  }) {
    let lastError: unknown;
    for (let attemptNumber = 0; attemptNumber < 2; attemptNumber += 1) {
      const sessionOrResponse = await this.getOrCreateSession(input);
      if (sessionOrResponse instanceof Response) {
        return sessionOrResponse;
      }

      const session = sessionOrResponse;
      await session.inFlight.catch(() => undefined);
      this.clearIdleTimer(session);
      session.awaitingPong = false;

      const attempt = this.responseFromSession(session, input.payload);
      session.inFlight = attempt.done.then(
        () => this.scheduleIdleCheck(session),
        () => undefined,
      );
      try {
        await attempt.ready;
        return attempt.response;
      } catch (error) {
        lastError = error;
        if (
          attemptNumber > 0 ||
          !(error instanceof RetryableWebSocketSendError)
        ) {
          throw error instanceof RetryableWebSocketSendError && error.cause
            ? error.cause
            : error;
        }
      }
    }
    throw lastError;
  }

  closeAll() {
    for (const session of [...this.sessions.values()]) {
      this.invalidate(session.key, "close");
    }
  }

  private async getOrCreateSession(input: {
    sessionKey: string;
    httpUrl: string;
    headers: HeadersInit;
    proxy?: CredentialProxyConfig | null;
    timeoutMs?: number;
  }): Promise<CodexWebSocketSession | Response> {
    const existing = this.sessions.get(input.sessionKey);
    if (existing) {
      return existing;
    }

    const created = this.factory(input);
    const session: CodexWebSocketSession = {
      key: input.sessionKey,
      socket: created.socket,
      cleanup: created.cleanup,
      inFlight: Promise.resolve(),
      idleTimer: null,
      awaitingPong: false,
      detachSessionListeners: () => undefined,
    };

    const onClose = () => this.invalidate(session.key, "none");
    const onError = () => this.invalidate(session.key, "terminate");
    const onPong = () => {
      session.awaitingPong = false;
    };
    session.detachSessionListeners = () => {
      session.socket.off("close", onClose);
      session.socket.off("error", onError);
      session.socket.off("pong", onPong);
    };
    session.socket.on("close", onClose);
    session.socket.on("error", onError);
    session.socket.on("pong", onPong);

    try {
      const opened = await waitForOpenOrRejection(
        session.socket,
        input.timeoutMs,
      );
      if (opened instanceof Response) {
        session.detachSessionListeners();
        session.cleanup?.();
        return opened;
      }
    } catch (error) {
      session.detachSessionListeners();
      session.cleanup?.();
      session.socket.terminate();
      throw error;
    }

    this.sessions.set(input.sessionKey, session);
    return session;
  }

  private responseFromSession(
    session: CodexWebSocketSession,
    payload: Record<string, unknown>,
  ) {
    const encoder = new TextEncoder();
    const payloadText = JSON.stringify(codexWebSocketRequestPayload(payload));
    let settled = false;
    let receivedEvent = false;
    let readySettled = false;
    let resolveDone: () => void;
    let rejectDone: (error: unknown) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    let resolveReady: () => void;
    let rejectReady: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const markReady = () => {
      if (readySettled) {
        return;
      }
      readySettled = true;
      resolveReady();
    };
    const markRetryable = (error: Error) => {
      if (readySettled) {
        return;
      }
      readySettled = true;
      rejectReady(new RetryableWebSocketSendError(error));
    };

    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const cleanupListeners = () => {
          session.socket.off("message", onMessage);
          session.socket.off("error", onError);
          session.socket.off("close", onClose);
        };
        const finish = (invalidate: boolean) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanupListeners();
          if (invalidate) {
            this.invalidate(session.key, "close");
          }
          controller.close();
          resolveDone();
        };
        const fail = (error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanupListeners();
          this.invalidate(session.key, "terminate");
          controller.error(error);
          rejectDone(error);
        };
        const onMessage = (data: unknown) => {
          const text = webSocketDataToText(data as RawData).trim();
          if (!text) {
            return;
          }
          receivedEvent = true;
          markReady();
          const normalized = normalizeCodexWebSocketEvent(text);
          controller.enqueue(encoder.encode(`data: ${normalized}\n\n`));
          const type = eventType(normalized);
          if (type === "response.completed" || type === "response.failed") {
            finish(false);
          } else if (type === "error") {
            finish(true);
          }
        };
        const onError = (error: unknown) => {
          markReady();
          fail(error);
        };
        const onClose = () => {
          markReady();
          finish(true);
        };

        session.socket.on("message", onMessage);
        session.socket.on("error", onError);
        session.socket.on("close", onClose);
        session.socket.send(payloadText, (error) => {
          if (!error || settled) {
            markReady();
            return;
          }
          const retryable = !receivedEvent;
          fail(error);
          if (retryable) {
            markRetryable(error);
          } else {
            markReady();
          }
        });
      },
      cancel: () => {
        settled = true;
        markReady();
        this.invalidate(session.key, "close");
        resolveDone();
      },
    });

    return {
      done,
      ready,
      response: new Response(body, {
        status: 200,
        headers: codexStreamResponseHeaders(),
      }),
    };
  }

  private scheduleIdleCheck(session: CodexWebSocketSession) {
    if (!this.sessions.has(session.key)) {
      return;
    }
    if (!session.socket.ping) {
      session.idleTimer = setTimeout(() => {
        this.invalidate(session.key, "close");
      }, this.idleTimeoutMs);
      return;
    }
    session.idleTimer = setTimeout(() => {
      if (!this.sessions.has(session.key)) {
        return;
      }
      if (session.awaitingPong) {
        this.invalidate(session.key, "terminate");
        return;
      }
      session.awaitingPong = true;
      session.socket.ping?.((error) => {
        if (error) {
          this.invalidate(session.key, "terminate");
        }
      });
      this.scheduleIdleCheck(session);
    }, this.keepAliveIntervalMs);
  }

  private clearIdleTimer(session: CodexWebSocketSession) {
    if (!session.idleTimer) {
      return;
    }
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  private invalidate(key: string, mode: "none" | "close" | "terminate") {
    const session = this.sessions.get(key);
    if (!session) {
      return;
    }
    this.sessions.delete(key);
    this.clearIdleTimer(session);
    session.detachSessionListeners();
    session.cleanup?.();
    if (mode === "close") {
      session.socket.close();
    } else if (mode === "terminate") {
      session.socket.terminate();
    }
  }
}

function waitForOpenOrRejection(
  ws: CodexWebSocketLike,
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
      const upstreamResponse = response as IncomingMessage;
      try {
        const body = await incomingMessageText(upstreamResponse);
        resolve(
          new Response(body, {
            status: upstreamResponse.statusCode || 502,
            statusText: upstreamResponse.statusMessage,
            headers: incomingMessageHeaders(upstreamResponse),
          }),
        );
      } catch (error) {
        reject(error);
      }
    });
  });
}

function createCodexWebSocketConnection(input: {
  httpUrl: string;
  headers: HeadersInit;
  proxy?: CredentialProxyConfig | null;
  timeoutMs?: number;
}) {
  const wsUrl = codexWebSocketUrl(input.httpUrl);
  const headers = codexWebSocketHeaders(input.headers);
  const agent = input.proxy?.enabled
    ? new SocksProxyAgent(proxyUrl(input.proxy))
    : undefined;
  return {
    cleanup: () => agent?.destroy(),
    socket: new WebSocket(wsUrl, {
      headers,
      agent,
      handshakeTimeout: input.timeoutMs ?? CODEX_RESPONSES_WEBSOCKET_HANDSHAKE_MS,
      perMessageDeflate: true,
    }),
  };
}

const codexWebSocketSessions = new CodexWebSocketSessionManager();

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

function codexStreamResponseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
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

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
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

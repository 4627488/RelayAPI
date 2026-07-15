import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexWebSocketSessionManager,
  codexWebSocketHeaders,
} from "@/src/server/codex/websocket";

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  pings = 0;
  closed = false;
  terminated = false;
  nextSendError: Error | undefined;
  deferSendCallback = false;
  private pendingSendCallback: ((error?: Error) => void) | undefined;

  send(data: string, callback?: (error?: Error) => void) {
    this.sent.push(data);
    if (this.deferSendCallback) {
      this.pendingSendCallback = callback;
      return;
    }
    const error = this.nextSendError;
    this.nextSendError = undefined;
    callback?.(error);
  }

  ping(callback?: (error?: Error) => void) {
    this.pings += 1;
    callback?.();
  }

  completePendingSend(error?: Error) {
    const callback = this.pendingSendCallback;
    this.pendingSendCallback = undefined;
    callback?.(error);
  }

  close() {
    this.closed = true;
    this.emit("close");
  }

  terminate() {
    this.terminated = true;
    this.emit("close");
  }
}

function nextMicrotask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function requestInput(value: string) {
  return {
    sessionKey: "credential-a:window-1",
    httpUrl: "https://chatgpt.com/backend-api/codex/responses",
    headers: {},
    payload: { model: "gpt-5-codex", input: value },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("codexWebSocketHeaders", () => {
  it("merges an existing OpenAI-Beta value without duplicate casing", () => {
    const headers = codexWebSocketHeaders({
      "Content-Type": "application/json",
      "OpenAI-Beta": "custom_beta=v1",
    });

    expect(headers).toEqual({
      "OpenAI-Beta": "custom_beta=v1,responses_websockets=2026-02-06",
    });
  });
});

describe("CodexWebSocketSessionManager", () => {
  it("reuses the upstream websocket for sequential requests with the same session key", async () => {
    const sockets: FakeSocket[] = [];
    const manager = new CodexWebSocketSessionManager({
      idleTimeoutMs: 60_000,
      factory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.emit("open"));
        return { socket };
      },
    });

    const first = await manager.request({
      sessionKey: "credential-a:window-1",
      httpUrl: "https://chatgpt.com/backend-api/codex/responses",
      headers: {},
      payload: { model: "gpt-5-codex", input: "one" },
    });
    queueMicrotask(() =>
      sockets[0].emit(
        "message",
        JSON.stringify({ type: "response.completed", response: { id: "r1" } }),
      ),
    );
    await expect(first.text()).resolves.toContain("response.completed");

    const second = await manager.request({
      sessionKey: "credential-a:window-1",
      httpUrl: "https://chatgpt.com/backend-api/codex/responses",
      headers: {},
      payload: { model: "gpt-5-codex", input: "two" },
    });
    queueMicrotask(() =>
      sockets[0].emit(
        "message",
        JSON.stringify({ type: "response.completed", response: { id: "r2" } }),
      ),
    );
    await expect(second.text()).resolves.toContain("response.completed");

    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent).toHaveLength(2);
    manager.closeAll();
  });

  it("finishes and reuses the session after response.incomplete", async () => {
    const sockets: FakeSocket[] = [];
    const manager = new CodexWebSocketSessionManager({
      idleTimeoutMs: 60_000,
      factory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.emit("open"));
        return { socket };
      },
    });

    const first = await manager.request(requestInput("one"));
    queueMicrotask(() =>
      sockets[0].emit(
        "message",
        JSON.stringify({
          type: "response.incomplete",
          response: { incomplete_details: { reason: "max_output_tokens" } },
        }),
      ),
    );
    await expect(first.text()).resolves.toContain("response.incomplete");

    const second = await manager.request(requestInput("two"));
    queueMicrotask(() =>
      sockets[0].emit("message", JSON.stringify({ type: "response.done" })),
    );
    await expect(second.text()).resolves.toContain("response.completed");
    expect(sockets).toHaveLength(1);
    manager.closeAll();
  });

  it("does not reuse a socket across credential-scoped session keys", async () => {
    const sockets: FakeSocket[] = [];
    const manager = new CodexWebSocketSessionManager({
      idleTimeoutMs: 60_000,
      factory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.emit("open"));
        return { socket };
      },
    });

    const first = await manager.request({
      sessionKey: "credential-a:window-1",
      httpUrl: "https://chatgpt.com/backend-api/codex/responses",
      headers: {},
      payload: { model: "gpt-5-codex", input: "one" },
    });
    queueMicrotask(() =>
      sockets[0].emit("message", JSON.stringify({ type: "response.completed" })),
    );
    await first.text();

    const second = await manager.request({
      sessionKey: "credential-b:window-1",
      httpUrl: "https://chatgpt.com/backend-api/codex/responses",
      headers: {},
      payload: { model: "gpt-5-codex", input: "two" },
    });
    queueMicrotask(() =>
      sockets[1].emit("message", JSON.stringify({ type: "response.completed" })),
    );
    await second.text();

    expect(sockets).toHaveLength(2);
    manager.closeAll();
  });

  it("reconnects after the reusable socket closes", async () => {
    const sockets: FakeSocket[] = [];
    const manager = new CodexWebSocketSessionManager({
      idleTimeoutMs: 60_000,
      factory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.emit("open"));
        return { socket };
      },
    });

    const first = await manager.request({
      sessionKey: "credential-a:window-1",
      httpUrl: "https://chatgpt.com/backend-api/codex/responses",
      headers: {},
      payload: { model: "gpt-5-codex", input: "one" },
    });
    queueMicrotask(() =>
      sockets[0].emit("message", JSON.stringify({ type: "response.completed" })),
    );
    await first.text();
    sockets[0].emit("close");
    await nextMicrotask();

    const second = await manager.request({
      sessionKey: "credential-a:window-1",
      httpUrl: "https://chatgpt.com/backend-api/codex/responses",
      headers: {},
      payload: { model: "gpt-5-codex", input: "two" },
    });
    queueMicrotask(() =>
      sockets[1].emit("message", JSON.stringify({ type: "response.completed" })),
    );
    await second.text();

    expect(sockets).toHaveLength(2);
    manager.closeAll();
  });

  it("keeps an idle session alive when pong follows ping", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const manager = new CodexWebSocketSessionManager({
      idleTimeoutMs: 60_000,
      keepAliveIntervalMs: 1_000,
      factory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.emit("open"));
        return { socket };
      },
    });

    const response = await manager.request(requestInput("one"));
    queueMicrotask(() =>
      sockets[0].emit("message", JSON.stringify({ type: "response.completed" })),
    );
    await response.text();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets[0].pings).toBe(1);

    sockets[0].emit("pong");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets[0].pings).toBe(2);
    expect(sockets[0].terminated).toBe(false);
    manager.closeAll();
  });

  it("terminates an idle session that misses its pong", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const manager = new CodexWebSocketSessionManager({
      idleTimeoutMs: 60_000,
      keepAliveIntervalMs: 1_000,
      factory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.emit("open"));
        return { socket };
      },
    });

    const response = await manager.request(requestInput("one"));
    queueMicrotask(() =>
      sockets[0].emit("message", JSON.stringify({ type: "response.completed" })),
    );
    await response.text();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(sockets[0].terminated).toBe(true);
    manager.closeAll();
  });

  it("reconnects and resends once when send fails before any event", async () => {
    const sockets: FakeSocket[] = [];
    const manager = new CodexWebSocketSessionManager({
      idleTimeoutMs: 60_000,
      factory: () => {
        const socket = new FakeSocket();
        if (sockets.length === 0) {
          socket.nextSendError = new Error("stale socket");
        }
        sockets.push(socket);
        queueMicrotask(() => socket.emit("open"));
        return { socket };
      },
    });

    const response = await manager.request(requestInput("one"));
    queueMicrotask(() =>
      (sockets[1] || sockets[0]).emit(
        "message",
        JSON.stringify({ type: "response.completed" }),
      ),
    );

    await expect(response.text()).resolves.toContain("response.completed");
    expect(sockets).toHaveLength(2);
    expect(sockets.map((socket) => socket.sent.length)).toEqual([1, 1]);
    manager.closeAll();
  });

  it("does not reconnect after the first upstream event", async () => {
    const sockets: FakeSocket[] = [];
    const manager = new CodexWebSocketSessionManager({
      idleTimeoutMs: 60_000,
      factory: () => {
        const socket = new FakeSocket();
        socket.deferSendCallback = true;
        sockets.push(socket);
        queueMicrotask(() => socket.emit("open"));
        return { socket };
      },
    });

    const responsePromise = manager.request(requestInput("one"));
    await nextMicrotask();
    sockets[0].emit(
      "message",
      JSON.stringify({ type: "response.output_text.delta", delta: "a" }),
    );
    sockets[0].completePendingSend(new Error("late send failure"));
    const response = await responsePromise;

    await expect(response.text()).rejects.toThrow("late send failure");
    expect(sockets).toHaveLength(1);
    manager.closeAll();
  });

  it("stops after the second pre-event send failure", async () => {
    const sockets: FakeSocket[] = [];
    const manager = new CodexWebSocketSessionManager({
      idleTimeoutMs: 60_000,
      factory: () => {
        const socket = new FakeSocket();
        socket.nextSendError = new Error("send failed");
        sockets.push(socket);
        queueMicrotask(() => socket.emit("open"));
        return { socket };
      },
    });

    await expect(manager.request(requestInput("one"))).rejects.toThrow(
      "send failed",
    );
    expect(sockets).toHaveLength(2);
    manager.closeAll();
  });

  it("classifies an oversized-message close as context scoped", async () => {
    const sockets: FakeSocket[] = [];
    const manager = new CodexWebSocketSessionManager({
      idleTimeoutMs: 60_000,
      factory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.emit("open"));
        return { socket };
      },
    });

    const response = await manager.request(requestInput("one"));
    sockets[0].emit("close", 1009, Buffer.from("message too big"));

    await expect(response.text()).rejects.toMatchObject({
      codexErrorInfo: {
        code: "context_too_large",
        requestScoped: true,
        credentialScoped: false,
      },
      details: { closeCode: 1009, closeReason: "message too big" },
    });
  });

  it("keeps unknown close metadata transport scoped", async () => {
    const sockets: FakeSocket[] = [];
    const manager = new CodexWebSocketSessionManager({
      idleTimeoutMs: 60_000,
      factory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.emit("open"));
        return { socket };
      },
    });

    const response = await manager.request(requestInput("one"));
    sockets[0].emit("close", 1011, Buffer.from("upstream restart"));

    await expect(response.text()).rejects.toMatchObject({
      codexErrorInfo: {
        code: "websocket_closed",
        requestScoped: false,
        credentialScoped: false,
        retryAfterMs: null,
      },
      details: { closeCode: 1011, closeReason: "upstream restart" },
    });
  });

  it("does not reconnect or classify caller cancellation", async () => {
    const sockets: FakeSocket[] = [];
    const manager = new CodexWebSocketSessionManager({
      idleTimeoutMs: 60_000,
      factory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.emit("open"));
        return { socket };
      },
    });

    const response = await manager.request(requestInput("one"));
    await response.body?.cancel();

    expect(sockets).toHaveLength(1);
    expect(sockets[0].closed).toBe(true);
    manager.closeAll();
  });
});

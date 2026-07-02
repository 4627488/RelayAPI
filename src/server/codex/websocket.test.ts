import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { CodexWebSocketSessionManager } from "@/src/server/codex/websocket";

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  closed = false;
  terminated = false;

  send(data: string, callback?: (error?: Error) => void) {
    this.sent.push(data);
    callback?.();
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
});

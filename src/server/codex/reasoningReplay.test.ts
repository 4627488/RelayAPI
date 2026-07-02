import { beforeEach, describe, expect, test } from "vitest";

import {
  applyCodexReasoningReplay,
  captureCodexReasoningReplay,
  clearCodexReasoningReplay,
  clearCodexReasoningReplayCache,
  getCodexReplaySessionKey,
} from "@/src/server/codex/reasoningReplay";

describe("getCodexReplaySessionKey", () => {
  test("prefers prompt_cache_key from payload", () => {
    const key = getCodexReplaySessionKey({
      payload: { prompt_cache_key: "prompt-1" },
      headers: new Headers({ Session_id: "session-1" }),
    });

    expect(key).toBe("prompt-cache:prompt-1");
  });

  test("uses x-codex-turn-metadata prompt cache key", () => {
    const key = getCodexReplaySessionKey({
      payload: {
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            prompt_cache_key: "turn-prompt",
          }),
        },
      },
    });

    expect(key).toBe("prompt-cache:turn-prompt");
  });

  test("uses session headers when payload has no key", () => {
    const key = getCodexReplaySessionKey({
      payload: {},
      headers: new Headers({ Conversation_id: "conversation-1" }),
    });

    expect(key).toBe("conversation:conversation-1");
  });
});

describe("Codex reasoning replay cache", () => {
  beforeEach(() => {
    clearCodexReasoningReplayCache();
  });

  test("injects cached reasoning before the next user input", () => {
    captureCodexReasoningReplay({
      model: "gpt-5.3-codex",
      sessionKey: "prompt-cache:abc",
      response: {
        output: [
          {
            type: "reasoning",
            encrypted_content: "encrypted-content",
            summary: [],
          },
        ],
      },
    });

    const payload = applyCodexReasoningReplay({
      model: "gpt-5.3-codex",
      sessionKey: "prompt-cache:abc",
      payload: {
        input: [{ type: "message", role: "user", content: [] }],
      },
    });

    expect(payload.input).toEqual([
      {
        type: "reasoning",
        encrypted_content: "encrypted-content",
        summary: [],
        content: null,
      },
      { type: "message", role: "user", content: [] },
    ]);
  });

  test("does not duplicate reasoning when request already carries it", () => {
    captureCodexReasoningReplay({
      model: "gpt-5.3-codex",
      sessionKey: "prompt-cache:abc",
      response: {
        output: [{ type: "reasoning", encrypted_content: "cached" }],
      },
    });

    const payload = applyCodexReasoningReplay({
      model: "gpt-5.3-codex",
      sessionKey: "prompt-cache:abc",
      payload: {
        input: [
          { type: "reasoning", encrypted_content: "client-provided" },
          { type: "message", role: "user", content: [] },
        ],
      },
    });

    expect(payload.input).toEqual([
      { type: "reasoning", encrypted_content: "client-provided" },
      { type: "message", role: "user", content: [] },
    ]);
  });

  test("replays cached function calls only when matching output exists", () => {
    captureCodexReasoningReplay({
      model: "gpt-5.3-codex",
      sessionKey: "prompt-cache:abc",
      response: {
        output: [
          {
            type: "function_call",
            call_id: "call-1",
            name: "shell",
            arguments: "{}",
          },
        ],
      },
    });

    const payload = applyCodexReasoningReplay({
      model: "gpt-5.3-codex",
      sessionKey: "prompt-cache:abc",
      payload: {
        input: [
          { type: "function_call_output", call_id: "call-1", output: "ok" },
          { type: "message", role: "user", content: [] },
        ],
      },
    });

    expect(payload.input).toEqual([
      {
        type: "function_call",
        call_id: "call-1",
        name: "shell",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call-1", output: "ok" },
      { type: "message", role: "user", content: [] },
    ]);
  });

  test("clear removes stale replay entries", () => {
    captureCodexReasoningReplay({
      model: "gpt-5.3-codex",
      sessionKey: "prompt-cache:abc",
      response: {
        output: [{ type: "reasoning", encrypted_content: "cached" }],
      },
    });
    clearCodexReasoningReplay({
      model: "gpt-5.3-codex",
      sessionKey: "prompt-cache:abc",
    });

    const payload = applyCodexReasoningReplay({
      model: "gpt-5.3-codex",
      sessionKey: "prompt-cache:abc",
      payload: {
        input: [{ type: "message", role: "user", content: [] }],
      },
    });

    expect(payload.input).toEqual([
      { type: "message", role: "user", content: [] },
    ]);
  });
});

import { beforeEach, describe, expect, test } from "vitest";

import {
  buildCodexHeaders,
  chatCompletionsToCodex,
  normalizeRawCodexResponsesPayload,
  normalizeResponsesPayload,
  prepareCodexPayloadForUpstream,
} from "@/src/server/codex/client";
import { parseCodexModelHeaderOverrides } from "@/src/server/codex/headerProfiles";
import { serverConfig } from "@/src/server/config/env";
import {
  captureCodexReasoningReplay,
  clearCodexReasoningReplayCache,
} from "@/src/server/codex/reasoningReplay";

describe("prepareCodexPayloadForUpstream", () => {
  beforeEach(() => {
    clearCodexReasoningReplayCache();
  });

  test("applies Codex reasoning replay when a replay session key is available", () => {
    captureCodexReasoningReplay({
      model: "gpt-5.3-codex",
      sessionKey: "prompt-cache:abc",
      response: {
        output: [{ type: "reasoning", encrypted_content: "encrypted" }],
      },
    });

    const payload = prepareCodexPayloadForUpstream(
      {
        model: "gpt-5.3-codex",
        input: [{ type: "message", role: "user", content: [] }],
      },
      {
        replaySessionKey: "prompt-cache:abc",
      },
    );

    expect(payload.input).toEqual([
      {
        type: "reasoning",
        encrypted_content: "encrypted",
        summary: [],
        content: null,
      },
      { type: "message", role: "user", content: [] },
    ]);
  });

  test("defaults parallel_tool_calls after injecting the image tool", () => {
    const payload = prepareCodexPayloadForUpstream({
      model: "gpt-5.3-codex",
      input: [],
    });

    expect(payload.tools).toEqual([
      { type: "image_generation", output_format: "png" },
    ]);
    expect(payload).toHaveProperty("parallel_tool_calls", true);
  });

  test("removes parallel_tool_calls for invalid-only tool arrays", () => {
    const payload = prepareCodexPayloadForUpstream({
      model: "gpt-5.3-codex-spark",
      input: [],
      parallel_tool_calls: true,
      tools: [null, {}, { type: "" }, { type: 42 }],
    });

    expect(payload).not.toHaveProperty("parallel_tool_calls");
    expect(payload.tools).toEqual([null, {}, { type: "" }, { type: 42 }]);
  });
});

describe("parallel_tool_calls normalization", () => {
  test.each([
    ["missing", undefined],
    ["empty", []],
  ])("removes parallel_tool_calls when tools are %s", (_label, tools) => {
    const input = {
      model: "gpt-5.3-codex",
      input: [],
      parallel_tool_calls: true,
      ...(tools === undefined ? {} : { tools }),
    };

    expect(normalizeResponsesPayload(input)).not.toHaveProperty(
      "parallel_tool_calls",
    );
    expect(normalizeRawCodexResponsesPayload(input)).not.toHaveProperty(
      "parallel_tool_calls",
    );
  });

  test("defaults to true with tools and preserves an explicit false", () => {
    const tool = { type: "function", name: "lookup", parameters: {} };
    expect(
      normalizeResponsesPayload({ input: [], tools: [tool] }),
    ).toHaveProperty("parallel_tool_calls", true);
    expect(
      normalizeResponsesPayload({
        input: [],
        tools: [tool],
        parallel_tool_calls: false,
      }),
    ).toHaveProperty("parallel_tool_calls", false);
  });

  test("defaults and preserves raw Responses parallel_tool_calls", () => {
    const tool = { type: "function", name: "lookup", parameters: {} };
    expect(
      normalizeRawCodexResponsesPayload({ tools: [tool] }),
    ).toHaveProperty("parallel_tool_calls", true);
    expect(
      normalizeRawCodexResponsesPayload({
        tools: [tool],
        parallel_tool_calls: false,
      }),
    ).toHaveProperty("parallel_tool_calls", false);
  });

  test("applies the same rule after Chat Completions tool conversion", () => {
    expect(chatCompletionsToCodex({ messages: [] }).payload).not.toHaveProperty(
      "parallel_tool_calls",
    );
    expect(
      chatCompletionsToCodex({
        messages: [],
        parallel_tool_calls: false,
        tools: [
          {
            type: "function",
            function: { name: "lookup", parameters: { type: "object" } },
          },
        ],
      }).payload,
    ).toHaveProperty("parallel_tool_calls", false);
  });
});

describe("buildCodexHeaders", () => {
  test("applies exact model headers before deriving a Mac session id", () => {
    const previousOverrides = serverConfig.codexModelHeaderOverrides;
    serverConfig.codexModelHeaderOverrides = parseCodexModelHeaderOverrides(
      JSON.stringify({
        "*": { "x-codex-beta-features": "wildcard-beta" },
        "gpt-5.3-codex": {
          "User-Agent": "codex_cli_rs/test (Mac OS 26.3; arm64)",
          Originator: "profile-originator",
        },
      }),
    );

    try {
      const headers = buildCodexHeaders(
        {
          accountId: "",
          userAgent: "base-agent",
          tokens: { access_token: "token" },
        } as never,
        {
          model: "gpt-5.3-codex",
          stream: false,
          sourceHeaders: new Headers(),
        },
      );

      expect(headers).toMatchObject({
        "User-Agent": "codex_cli_rs/test (Mac OS 26.3; arm64)",
        Originator: "profile-originator",
        "X-Codex-Beta-Features": "wildcard-beta",
      });
      expect(headers.Session_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      serverConfig.codexModelHeaderOverrides = previousOverrides;
    }
  });
});

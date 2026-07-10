import { beforeEach, describe, expect, test } from "vitest";

import {
  buildCodexHeaders,
  chatCompletionsToCodex,
  chatCompletionsPromptCacheKey,
  codexResponseToChatCompletion,
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

  test("does not inject an undeclared image generation tool", () => {
    const payload = prepareCodexPayloadForUpstream({
      model: "gpt-5.3-codex",
      input: [],
    });

    expect(payload).not.toHaveProperty("tools");
    expect(payload).not.toHaveProperty("parallel_tool_calls");
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

describe("Chat Completions request compatibility", () => {
  test("does not create shared continuity from an API key fallback", () => {
    expect(chatCompletionsPromptCacheKey({ messages: [] })).toBe("");
    expect(
      chatCompletionsPromptCacheKey({
        messages: [],
        prompt_cache_key: "conversation-123",
      }),
    ).toBe("conversation-123");
  });

  test("converts legacy functions and function_call", () => {
    const { payload } = chatCompletionsToCodex({
      messages: [{ role: "user", content: "hello" }],
      functions: [
        {
          name: "lookup",
          description: "Look something up",
          parameters: { type: "object", properties: {} },
        },
      ],
      function_call: { name: "lookup" },
    });

    expect(payload.tools).toEqual([
      {
        type: "function",
        name: "lookup",
        description: "Look something up",
        parameters: { type: "object", properties: {} },
      },
    ]);
    expect(payload.tool_choice).toEqual({ type: "function", name: "lookup" });
  });

  test("preserves assistant reasoning history and legacy function output", () => {
    const { payload } = chatCompletionsToCodex({
      messages: [
        {
          role: "assistant",
          content: "answer",
          reasoning_content: "private summary",
        },
        { role: "function", name: "lookup", content: "result" },
      ],
    });

    expect(payload.input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "<thinking>private summary</thinking>\nanswer",
          },
        ],
      },
      {
        type: "function_call_output",
        call_id: "lookup",
        output: "result",
      },
    ]);
  });

  test("converts input_audio and json_object response format", () => {
    const { payload } = chatCompletionsToCodex({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: { data: "base64-audio", format: "wav" },
            },
          ],
        },
      ],
      response_format: { type: "json_object" },
    });

    expect(payload.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_audio", data: "base64-audio", format: "wav" },
        ],
      },
    ]);
    expect(payload.text).toEqual({ format: { type: "json_object" } });
  });
});

describe("Chat Completions non-stream response compatibility", () => {
  test("preserves text, reasoning, tool calls, and detailed usage together", () => {
    const response = codexResponseToChatCompletion(
      {
        id: "resp_1",
        model: "gpt-5.3-codex",
        status: "completed",
        output: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "reasoning summary" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I will call a tool." }],
          },
          {
            type: "function_call",
            call_id: "call_1",
            name: "lookup",
            arguments: "{\"q\":\"x\"}",
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 6,
          total_tokens: 16,
          output_tokens_details: { reasoning_tokens: 4 },
        },
      },
      "fallback",
      null,
    );

    expect(response.choices[0].message).toMatchObject({
      role: "assistant",
      content: "I will call a tool.",
      reasoning_content: "reasoning summary",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: "{\"q\":\"x\"}" },
        },
      ],
    });
    expect(response.choices[0].finish_reason).toBe("tool_calls");
    expect(response.usage.completion_tokens_details).toEqual({
      reasoning_tokens: 4,
    });
  });

  test("maps max-output incompletion to length", () => {
    const response = codexResponseToChatCompletion(
      {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
      },
      "gpt-5.3-codex",
      null,
    );

    expect(response.choices[0].finish_reason).toBe("length");
  });

  test("preserves custom tool calls and generated images", () => {
    const response = codexResponseToChatCompletion(
      {
        status: "completed",
        output: [
          {
            type: "custom_tool_call",
            call_id: "call_patch",
            name: "apply_patch",
            input: "*** Begin Patch",
          },
          {
            type: "image_generation_call",
            id: "image_1",
            output_format: "png",
            result: "base64-image",
          },
        ],
      },
      "gpt-5.3-codex",
      null,
    );

    expect(response.choices[0].message).toMatchObject({
      tool_calls: [
        {
          id: "call_patch",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: "*** Begin Patch",
          },
        },
      ],
      images: [
        {
          index: 0,
          type: "image_url",
          image_url: { url: "data:image/png;base64,base64-image" },
        },
      ],
    });
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

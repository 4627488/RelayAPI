import { describe, expect, test } from "vitest";
import { prepareGrokPayload, restoreNamespaceCalls } from "@/src/server/grok/client";

describe("Grok payload compatibility", () => {
  test("flattens namespace tools for the xAI Responses API", () => {
    const payload = prepareGrokPayload({
      model: "grok-4.5",
      tools: [
        { type: "namespace", name: "collaboration", tools: [{ type: "function", name: "send_message", parameters: { type: "object" } }] },
        { type: "function", name: "lookup", parameters: { type: "object" } },
      ],
      tool_choice: { type: "allowed_tools", tools: [{ type: "function", name: "send_message", namespace: "collaboration" }] },
    }, { nativeXSearch: false, clientToolCache: true }).payload;

    expect(payload.tools).toEqual([
      expect.objectContaining({ type: "function", name: "collaboration__send_message" }),
      expect.objectContaining({ type: "function", name: "lookup" }),
    ]);
    expect(payload.tool_choice).toEqual({
      type: "allowed_tools",
      tools: [{ type: "function", name: "collaboration__send_message" }],
    });
  });

  test("drops namespace containers without child tools and orphaned choices", () => {
    expect(prepareGrokPayload({ tools: [{ type: "namespace", name: "empty" }], tool_choice: "required", parallel_tool_calls: true }, { nativeXSearch: false, clientToolCache: true }).payload).toEqual({});
  });

  test("removes unsupported xAI fields and tools", () => {
    const result = prepareGrokPayload({
      previous_response_id: "resp_old",
      safety_identifier: "client",
      prompt_cache_retention: "24h",
      stream_options: { include_usage: true },
      tools: [
        { type: "web_search", external_web_access: true },
        { type: "tool_search" },
        { type: "image_generation" },
        { type: "custom", name: "apply_patch" },
        { type: "custom", name: "shell", format: { type: "text" } },
      ],
    }, { nativeXSearch: false, clientToolCache: false }).payload;
    expect(result).not.toHaveProperty("previous_response_id");
    expect(result).not.toHaveProperty("safety_identifier");
    expect(result.tools).toEqual([
      { type: "web_search" },
      expect.objectContaining({ type: "function", name: "shell", parameters: expect.any(Object) }),
    ]);
  });

  test("normalizes historical custom calls, additional tools, and image refs", () => {
    const result = prepareGrokPayload({
      input: [
        { type: "custom_tool_call", call_id: "call_1", name: "shell", input: "pwd" },
        { type: "custom_tool_call_output", call_id: "call_1", output: { ok: true } },
        { type: "additional_tools", tools: [{ type: "function", name: "lookup" }] },
      ],
      image: { image_url: { url: "https://example.com/a.png" } },
    }, { nativeXSearch: true, clientToolCache: true }).payload;
    expect(result.input).toEqual(expect.arrayContaining([
      { type: "function_call", call_id: "call_1", name: "shell", arguments: '{"input":"pwd"}' },
      { type: "function_call_output", call_id: "call_1", output: '{"ok":true}' },
    ]));
    expect(result.input).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "additional_tools" })]));
    expect(result.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "lookup" }), { type: "x_search" }]));
    expect(result.image).toEqual({ url: "https://example.com/a.png" });
  });

  test("restores namespace metadata on upstream function calls", () => {
    const refs = new Map([["collaboration__send_message", { namespace: "collaboration", name: "send_message" }]]);
    expect(restoreNamespaceCalls({ type: "response.output_item.added", item: { type: "function_call", name: "collaboration__send_message", arguments: "{}" } }, refs)).toEqual({
      type: "response.output_item.added",
      item: { type: "function_call", name: "send_message", namespace: "collaboration", arguments: "{}" },
    });
  });
});

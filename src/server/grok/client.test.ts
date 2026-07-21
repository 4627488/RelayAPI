import { describe, expect, test } from "vitest";
import { normalizeGrokPayload, restoreNamespaceCalls } from "@/src/server/grok/client";

describe("Grok payload compatibility", () => {
  test("flattens namespace tools for the xAI Responses API", () => {
    const payload = normalizeGrokPayload({
      model: "grok-4.5",
      tools: [
        { type: "namespace", name: "collaboration", tools: [{ type: "function", name: "send_message", parameters: { type: "object" } }] },
        { type: "function", name: "lookup", parameters: { type: "object" } },
      ],
      tool_choice: { type: "allowed_tools", tools: [{ type: "function", name: "send_message", namespace: "collaboration" }] },
    });

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
    expect(normalizeGrokPayload({ tools: [{ type: "namespace", name: "empty" }], tool_choice: "required", parallel_tool_calls: true })).toEqual({});
  });

  test("restores namespace metadata on upstream function calls", () => {
    const refs = new Map([["collaboration__send_message", { namespace: "collaboration", name: "send_message" }]]);
    expect(restoreNamespaceCalls({ type: "response.output_item.added", item: { type: "function_call", name: "collaboration__send_message", arguments: "{}" } }, refs)).toEqual({
      type: "response.output_item.added",
      item: { type: "function_call", name: "send_message", namespace: "collaboration", arguments: "{}" },
    });
  });
});

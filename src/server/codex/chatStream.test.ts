import { describe, expect, test } from "vitest";

import { createOpenAIChatSseStream } from "@/src/server/codex/chatStream";

function upstreamStream(events: Record<string, unknown>[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      }
      controller.close();
    },
  });
}

async function readSse(events: Record<string, unknown>[], includeUsage = false) {
  const stream = createOpenAIChatSseStream(upstreamStream(events), {
    fallbackModel: "gpt-5.3-codex",
    toolNameMaps: null,
    includeUsage,
  });
  return new Response(stream).text();
}

function jsonFrames(text: string) {
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => block.slice(6))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

describe("OpenAI Chat Completions stream compatibility", () => {
  test("maps raw reasoning deltas and an incomplete token limit", async () => {
    const text = await readSse([
      {
        type: "response.reasoning_text.delta",
        delta: "raw reasoning",
      },
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        },
      },
    ]);
    const frames = jsonFrames(text);

    expect(frames[0]).toMatchObject({
      choices: [{ delta: { reasoning_content: "raw reasoning" } }],
    });
    expect(frames.at(-1)).toMatchObject({
      choices: [{ finish_reason: "length" }],
    });
    expect(text).toContain("data: [DONE]");
    expect(frames.at(-1)).not.toHaveProperty("usage");
  });

  test("emits usage only when stream_options.include_usage is enabled", async () => {
    const text = await readSse(
      [
        {
          type: "response.completed",
          response: {
            status: "completed",
            usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
          },
        },
      ],
      true,
    );
    const frames = jsonFrames(text);

    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      choices: [{ finish_reason: "stop" }],
    });
    expect(frames[0]).not.toHaveProperty("usage");
    expect(frames[1]).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    });
  });

  test("maps custom tool calls and their input deltas", async () => {
    const text = await readSse([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "custom_tool_call",
          id: "item_1",
          call_id: "call_1",
          name: "apply_patch",
        },
      },
      {
        type: "response.custom_tool_call_input.delta",
        output_index: 0,
        delta: "*** Begin Patch",
      },
      {
        type: "response.completed",
        response: { status: "completed", usage: {} },
      },
    ]);
    const frames = jsonFrames(text);

    expect(frames[0]).toMatchObject({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: { name: "apply_patch", arguments: "" },
              },
            ],
          },
        },
      ],
    });
    expect(frames[1]).toMatchObject({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: "*** Begin Patch" } },
            ],
          },
        },
      ],
    });
    expect(frames.at(-1)).toMatchObject({
      choices: [{ finish_reason: "tool_calls" }],
    });
  });

  test("surfaces response.failed as a stream error instead of truncation", async () => {
    const text = await readSse([
      {
        type: "response.failed",
        response: {
          status: "failed",
          error: { message: "upstream rejected request", code: "bad_request" },
        },
      },
    ]);
    const frames = jsonFrames(text);

    expect(frames).toEqual([
      {
        error: {
          message: "upstream rejected request",
          type: "stream_error",
          code: "bad_request",
        },
      },
    ]);
    expect(text).toContain("data: [DONE]");
  });

  test("maps generated image events to Chat Completions images", async () => {
    const text = await readSse([
      {
        type: "response.image_generation_call.partial_image",
        item_id: "image_1",
        output_format: "webp",
        partial_image_b64: "base64-image",
      },
      {
        type: "response.completed",
        response: { status: "completed", usage: {} },
      },
    ]);
    const frames = jsonFrames(text);

    expect(frames[0]).toMatchObject({
      choices: [
        {
          delta: {
            images: [
              {
                index: 0,
                type: "image_url",
                image_url: {
                  url: "data:image/webp;base64,base64-image",
                },
              },
            ],
          },
        },
      ],
    });
  });
});

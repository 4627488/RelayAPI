import { beforeEach, describe, expect, test } from "vitest";

import {
  prepareCodexPayloadForUpstream,
} from "@/src/server/codex/client";
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
});

import { describe, expect, test } from "vitest";
import { codexCompactSseResponse, resolveCodexCompactionMode } from "@/src/server/codex/compaction";

describe("Codex compaction compatibility", () => {
  test("promotes a legacy streaming compaction trigger", () => {
    expect(resolveCodexCompactionMode({
      upstreamPath: "/responses",
      payload: { stream: true, input: [{ type: "compaction_trigger" }] },
      headers: new Headers(),
    })).toMatchObject({ upstreamPath: "/responses/compact", promoted: true, clientWantsStream: true });
  });

  test("keeps native remote_compaction_v2 on responses", () => {
    expect(resolveCodexCompactionMode({
      upstreamPath: "/responses",
      payload: { stream: true, input: [{ type: "compaction_trigger" }] },
      headers: new Headers({ "x-codex-beta-features": "responses_websockets_v2, remote_compaction_v2" }),
    })).toMatchObject({ upstreamPath: "/responses", promoted: false, compact: false });
  });

  test("does not promote unrelated requests or case-mismatched feature names", () => {
    expect(resolveCodexCompactionMode({
      upstreamPath: "/responses",
      payload: { stream: true, input: [{ type: "message" }] },
      headers: new Headers(),
    }).promoted).toBe(false);
    expect(resolveCodexCompactionMode({
      upstreamPath: "/responses",
      payload: { stream: true, input: [{ type: "compaction_trigger" }] },
      headers: new Headers({ "x-codex-beta-features": "REMOTE_COMPACTION_V2" }),
    }).promoted).toBe(true);
  });

  test("recognizes an explicit compact endpoint without marking it promoted", () => {
    expect(resolveCodexCompactionMode({
      upstreamPath: "/responses/compact",
      payload: { input: [] },
      headers: new Headers(),
    })).toMatchObject({ compact: true, promoted: false, clientWantsStream: false });
  });

  test("bridges unary compact JSON to terminal Responses SSE", () => {
    const text = codexCompactSseResponse({ output: [{ type: "compaction", encrypted_content: "x" }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } });
    expect(text).toContain("event: response.output_item.done");
    expect(text).toContain('"type":"compaction"');
    expect(text).toContain("event: response.completed");
  });
});

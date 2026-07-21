import "server-only";

import { extractUsageFromCodexResponse } from "@/src/server/codex/client";
import { classifyCodexStreamEvent, type CodexUpstreamErrorInfo } from "@/src/server/codex/errors";
import { CodexResponsesSseFramer } from "@/src/server/codex/sse";
import { emptyUsage, stringValue } from "@/src/server/http/relayHttpUtilities";
import type { UsageSnapshot } from "@/src/shared/types/entities";

export function createResponsesUsageMeterStream(
  upstreamBody: ReadableStream<Uint8Array>,
  handlers: {
    onCompleted: (usage: UsageSnapshot, response?: unknown) => void;
    onError: (error: unknown, usage: UsageSnapshot) => void;
    onFirstToken?: () => void;
  },
) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const framer = new CodexResponsesSseFramer();
  let usage = emptyUsage();
  let firstTokenReported = false;
  let upstreamCompleted = false;
  let upstreamErrored = false;
  let completionReported = false;
  let completedResponse: unknown;
  const firstToken = () => { if (!firstTokenReported) { firstTokenReported = true; handlers.onFirstToken?.(); } };
  const completed = () => { if (!completionReported) { completionReported = true; handlers.onCompleted(usage, completedResponse); } };
  const failed = (error: unknown) => { if (!completionReported) { completionReported = true; handlers.onError(error, usage); } };
  const process = (text: string) => {
    for (const frame of framer.push(text)) handleFrame(frame.event, (next, response) => { usage = next; completedResponse = response; }, firstToken, () => { upstreamCompleted = true; }, (error) => { upstreamErrored = true; failed(error); });
  };
  return upstreamBody.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { controller.enqueue(chunk); process(decoder.decode(chunk, { stream: true })); },
    flush(controller) {
      const tail = decoder.decode(); if (tail) process(tail);
      for (const frame of framer.flush()) handleFrame(frame.event, (next, response) => { usage = next; completedResponse = response; }, firstToken, () => { upstreamCompleted = true; }, (error) => { upstreamErrored = true; failed(error); });
      if (upstreamCompleted) return completed();
      if (upstreamErrored) return;
      const error = new Error("Upstream stream ended before response.completed; refusing to mark a truncated Responses stream as successful");
      failed(error); controller.enqueue(encoder.encode(streamErrorFrame(error)));
    },
  }));
}

function handleFrame(event: Record<string, unknown> | null, onUsage: (usage: UsageSnapshot, response?: unknown) => void, onFirstToken: () => void, onCompleted: () => void, onError: (error: unknown) => void) {
  if (!event) return;
  if ((event.type === "response.output_text.delta" || event.type === "response.reasoning_summary_text.delta") && typeof event.delta === "string" && event.delta.length > 0) onFirstToken();
  if (event.type === "response.completed" || event.type === "response.done" || event.type === "response.incomplete") { onUsage(extractUsageFromCodexResponse(event.response || event), event.response); onCompleted(); return; }
  if (event.type === "error" || event.type === "response.failed" || event.type === "response.cancelled" || event.type === "response.canceled") onError(upstreamStreamError(event));
}

function upstreamStreamError(event: Record<string, unknown>) {
  const info = classifyCodexStreamEvent(event, { statusCode: 400 });
  const body = event.error && typeof event.error === "object" && !Array.isArray(event.error) ? event.error as Record<string, unknown> : event;
  const error = new Error(info?.message || stringValue(body.message) || stringValue(body.code) || "Upstream Responses stream returned an error") as Error & { details?: unknown; codexErrorInfo?: CodexUpstreamErrorInfo | null };
  error.details = event; error.codexErrorInfo = info; return error;
}
function streamErrorFrame(error: unknown) { return `\nevent: error\ndata: ${JSON.stringify({ error: { message: error instanceof Error && error.message.includes("ended before response.completed") ? "Upstream stream ended before completion" : "Upstream stream error", type: "stream_error", code: "upstream_stream_incomplete" } })}\n\n`; }

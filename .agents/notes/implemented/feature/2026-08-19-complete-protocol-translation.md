# Agent Note: Complete Responses ↔ Chat translation

Status: implemented

## Problem

The native translator covered the happy path (text, one tool call, usage) but dropped the conversions Codex + Kimi actually need: consecutive `function_call` items became separate assistant messages (Kimi 400s), reasoning and `text.format` were ignored, non-stream `finish_reason` was always `stop`, and a Chat stream that ended on `[DONE]` without `finish_reason` never emitted `response.completed`. A second, incomplete SSE mapper (`translateSSELine`) sat unused.

## Decision

Finish the CPA/sub2api Responses ↔ Chat surface we actually host, and nothing else.

- Merge consecutive function/custom tool calls into one Chat assistant message; keep `call_id` paired on tool outputs; defer interleaved user messages until those outputs appear.
- Map reasoning items ↔ `reasoning_content` (request, non-stream, stream).
- Map `text.format` ↔ `response_format`; `original` image detail → `high`.
- Synthesize a `call_*` id only when upstream omits one. Set Chat `finish_reason` to `tool_calls` or `length`. Emit `response.incomplete` for length/content-filter.
- Finalize Chat→Responses streams on `[DONE]` even without `finish_reason`.
- Restore Kimi custom tools after the Chat round-trip with the same restorer xAI already uses.
- Delete `translateSSELine`. Do not add Claude, Gemini, `n>1`, logprobs, or WebSocket body translation.

## Alternatives considered

**Copy CPA’s 1000-line gjson/sjson translator.** We do not host Claude/Gemini or echo the original request into `response.completed`. The extra fields would rot.

**Leave parallel tools as one assistant message per call.** Strict Chat upstreams (Kimi) reject that transcript.

**Keep `translateSSELine` as a fallback.** Production modes never called it; the incomplete event set would look like a second protocol.

## Consequences

Codex talking to Kimi can replay multi-tool turns and reasoning. Chat clients talking to Codex/Bailian get a real `finish_reason` and an incomplete status when the upstream hits a token cap. Streams from thinking Chat models no longer hang waiting for `response.completed`.

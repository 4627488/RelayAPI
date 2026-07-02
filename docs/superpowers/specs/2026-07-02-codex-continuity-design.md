# Codex Continuity Design

## Goal

Improve Codex relay fidelity for long-running CLI sessions by preserving reasoning continuity, interpreting upstream failures accurately, and reusing WebSocket sessions when safe. The feature set is:

- Parse Codex `usage_limit_reached` reset hints and use the real reset time for cooldowns.
- Classify Codex HTTP, SSE, and WebSocket errors into stable internal error metadata.
- Enable reasoning replay cache by default for session-aware requests.
- Reuse upstream Codex WebSocket connections for compatible long-lived client sessions.

## Current Shape

RelayAPI already has Codex OAuth credentials, credential cooldowns, prompt cache keys, Responses payload cleanup, SSE framing, WebSocket transport, image support, and `response.output_item.done` output reconstruction. The missing layer is continuity: the relay does not yet preserve encrypted reasoning/tool-call replay across stateless turns, does not classify terminal stream errors deeply, and opens an upstream WebSocket per request.

## Architecture

Add focused Codex modules under `src/server/codex/`:

- `errors.ts` parses upstream status/body/event payloads and returns `CodexUpstreamErrorInfo`.
- `reasoningReplay.ts` owns a bounded in-memory replay cache and request/response transforms.
- `websocketSession.ts` owns optional upstream WebSocket session reuse.

The existing relay remains the orchestrator. `codexFetch` prepares payloads and transport. `relay.ts` records request outcomes, streams responses, and updates cooldown/log state. New modules must be pure or injectable where possible so behavior can be tested without a running Next server.

## Error Handling

`errors.ts` will recognize:

- `usage_limit_reached`: credential-scoped, retryable after `error.resets_at` or `error.resets_in_seconds`.
- Context length: request-scoped, no credential cooldown.
- Model capacity: model/upstream-scoped, short cooldown candidate.
- `invalid_encrypted_content` and thinking signature invalid: request/session-scoped, clear reasoning replay.
- WebSocket connection limit: retryable with immediate/fallback behavior.
- Generic 401/403/429/5xx: preserve existing cooldown behavior.

Cooldown writes continue through `recordChannelFailure`, but the function accepts optional `retryAfterMs` so it can use upstream reset timing instead of fixed defaults.

## Reasoning Replay

Replay is enabled by default. It only runs when a session key can be derived from one of:

- `prompt_cache_key`
- `client_metadata.x-codex-window-id`
- `client_metadata.x-codex-turn-metadata.prompt_cache_key`
- `client_metadata.x-codex-turn-metadata.window_id`
- `Session_id`, `Session-Id`, `session_id`
- `Conversation_id`

The cache key is `model + sessionKey`, deliberately independent of the selected credential so channel/credential failover can preserve reasoning continuity. Cached items are normalized to minimal accepted Responses input shapes:

- `reasoning` with valid `encrypted_content`
- `function_call`
- `custom_tool_call`

Request injection filters duplicates and only replays tool calls when matching tool outputs exist in the next request. On `invalid_encrypted_content` or thinking signature errors, the relay clears that replay entry.

The first implementation is process-local with TTL and max entry bounds. Cross-instance persistence is out of scope.

## WebSocket Session Reuse

`websocketSession.ts` will reuse upstream WebSocket connections by a stable execution session key. A connection is scoped by `sessionKey + credentialId + upstream URL`, so credential changes or route changes do not reuse the wrong socket.

Behavior:

- If no session key exists, use existing one-request WebSocket behavior.
- If reuse is enabled and a live matching socket exists, send the request through it.
- Serialize sends per session.
- On send failure, reconnect once and resend.
- On handshake rejection, unexpected response, unsupported endpoint, or repeated failure, fall back to existing HTTP/WebSocket path.
- Close sessions on credential deletion/disable where possible, and expire idle sessions.

## Testing

Add Vitest for focused unit tests. Test before implementation:

- Reset time parsing and classified error metadata.
- Reasoning replay session-key extraction, injection, output capture, TTL/clear behavior.
- Stream terminal error classification.
- WebSocket session store reuse, credential isolation, and stale-session invalidation using injectable fake sockets.
- `recordChannelFailure` using supplied `retryAfterMs`.

`pnpm lint` and the targeted Vitest suite must pass before completion.


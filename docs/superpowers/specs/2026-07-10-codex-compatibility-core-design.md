# Codex Compatibility Core Design

## Goal

Improve Codex request fidelity and long-lived WebSocket reliability without changing channel selection, credential fairness, or public API contracts. The compatibility core contains three independently testable changes:

- Send `parallel_tool_calls` only when the request contains at least one valid tool.
- Support model-specific upstream header overrides through server configuration.
- Harden reusable Codex WebSocket sessions with transport keepalive, one reconnect-and-resend attempt, and structured close/error classification.

Session-affinity routing, identity remapping, and a public downstream Responses WebSocket endpoint are explicitly out of scope.

## Payload Normalization

Introduce one shared payload helper that determines whether a normalized Responses request has a non-empty `tools` array. All Codex request conversion paths use it after tool normalization:

- When tools are present, preserve a caller-supplied boolean `parallel_tool_calls`; default it to `true` when omitted.
- When tools are absent or normalize to an empty array, remove `parallel_tool_calls`.
- Compact requests continue to remove both tool-parallelism and streaming-only fields.

This rule applies to native Responses payloads, raw Codex Responses payloads, and Chat Completions-to-Codex conversion. Image request behavior remains unchanged unless it uses the same Responses normalization path.

## Model Header Profiles

Add `CODEX_MODEL_HEADER_OVERRIDES` as a JSON object keyed by model name. Each value is an object of header names to string values. An optional `*` entry supplies defaults for every model. Exact model entries override wildcard entries.

Example:

```json
{
  "*": { "x-codex-beta-features": "responses_websockets=2026-07-10" },
  "gpt-5.3-codex": { "User-Agent": "codex_cli_rs/...", "Originator": "codex_cli_rs" }
}
```

Configuration is parsed and validated at server startup. Invalid JSON, non-object entries, non-string values, control characters, or unsupported headers fail fast with a descriptive error. The initial allowlist is:

- `User-Agent`
- `Originator`
- `x-codex-beta-features`
- `OpenAI-Beta`

Header precedence, from lowest to highest, is existing global/tenant/credential resolution, wildcard model profile, then exact model profile. Authentication, account, host, content length, connection, session, and tracing headers cannot be overridden. Existing `Session_id` generation runs after header profiles so a Mac-style User-Agent still receives a session identifier.

The feature is environment-only in this iteration. It does not add database schema, settings UI, or tenant-editable arbitrary headers.

## WebSocket Session Hardening

Keep the current reusable-session key and serialization rules. Extend the session manager in three focused areas.

### Keepalive

Track liveness from WebSocket `pong` events. While an idle reusable socket is retained, send protocol `ping` frames at a bounded interval. If the previous ping has not received a pong before the next check, invalidate and terminate the socket. Active response streams are not interrupted solely by the idle keepalive timer.

The WebSocket abstraction exposes optional `ping` support so existing tests and alternate factories remain injectable. Sockets without `ping` support retain current idle-expiry behavior.

### Reconnect and Resend

If the initial `send` callback fails before any response event is received, invalidate the stale session, establish a fresh socket with the same scoped key, and resend exactly once. Do not retry after any upstream response event, after a terminal Codex event, on caller cancellation, or after the second send failure. The retry remains inside the session manager and is invisible to downstream clients.

### Error Classification

Convert WebSocket error envelopes and close metadata into errors consumable by the existing Codex classifier. Preserve upstream error code, message, retry metadata, close code, and close reason.

Treat a close reason indicating an oversized message as a context-length/request-scoped failure. Connection-limit and usage-limit envelopes continue through the existing credential cooldown logic. Unknown closes remain retryable transport failures and do not invent quota metadata.

## Data Flow

1. Normalize the request and conditionally set tool parallelism.
2. Resolve the effective model.
3. Build existing Codex headers, then apply wildcard and exact model header profiles.
4. Send through HTTP or the reusable WebSocket session manager.
5. For WebSocket send failure before first response, reconnect and resend once.
6. Feed terminal HTTP, SSE, WebSocket event, or WebSocket close errors into the existing Codex error classifier and cooldown handling.

## Testing

Use Vitest with tests written before implementation.

- Payload tests cover missing tools, empty tools, valid tools, caller-provided `false`, native Responses, raw Responses, and Chat Completions conversion.
- Header tests cover wildcard/exact precedence, case-insensitive allowlisting, forbidden headers, malformed configuration, model isolation, and Session ID behavior.
- WebSocket tests cover pong liveness, dead idle socket invalidation, single resend before first event, no resend after an event, retry exhaustion, cancellation, oversized-message close mapping, and preserved quota metadata.
- Existing Codex, relay, lint, and production build checks must remain green.

## Rollout And Observability

All changes preserve existing behavior when `CODEX_MODEL_HEADER_OVERRIDES` is unset and when upstream WebSocket transport is unused. Do not log configured header values because User-Agent profiles and beta flags may identify deployment behavior. Existing request logs record the final error category and retry timing, which is sufficient to evaluate the WebSocket changes.

Each subsystem is isolated so payload normalization, header profiles, or WebSocket hardening can be reverted independently if upstream behavior changes.

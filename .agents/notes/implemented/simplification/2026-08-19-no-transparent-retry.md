# Agent Note: Return the first error; no transparent retry

Status: implemented

## Problem

The native runtime retried connection failures and HTTP 408/429/502/503/504 with exponential backoff (`RequestRetry`, `RetryMaxBackoff`). Relay then rewrote the eventual 4xx/5xx into a user-facing envelope via `classifyUpstreamError`. Clients saw a delayed, translated failure instead of the first upstream or Relay error, and the request log stored the rewritten code.

## Decision

One provider attempt per request. Proactive OAuth refresh still runs before the call; a 401 refreshes the stored token for later requests but is returned as written. `runtimeWriter` forwards status and body to the client and the log capture. Logs record `observedError` (provider or runtime `code`/`message`, else `upstream_http_error` plus the payload text). WebSocket dial failures do the same. Settings and the admin UI no longer expose retry knobs. Credential isolation on 401/403/transient statuses stays.

## Alternatives considered

**Keep one 401 refresh-and-replay.** That is still a transparent retry of the user request. Proactive refresh covers typical expiry; the 401 itself is now visible.

**Keep `classifyUpstreamError` so tenants never see provider 401 text.** The requested contract is to return the observed error. Relay-owned failures (invalid key, Admit, model policy) still use `userFacingError`.

## Consequences

Clients can receive provider 401/429/503 bodies and statuses. Admission `Retry-After` on local overload is unchanged. Stored `request_retry` / `retry_max_backoff_ms` fields in runtime settings JSON are ignored.

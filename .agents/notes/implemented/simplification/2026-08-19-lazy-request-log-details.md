# Agent Note: Build request log details only when retained

Status: implemented

## Problem

The proxy copied the client body, sanitized headers, and later copied the upstream body into `LogDetailInput` on every request. `writeRequestLog` then dropped `Detail` for successful traffic because `REQUEST_LOG_SUCCESS_SAMPLE_PPM` defaults to 0. Large chat/SSE payloads were copied only to be discarded.

## Decision

Track byte counts on the summary without allocating detail. Copy request/forwarded bodies only after the upstream status is known and `shouldRetainRequestDetail` is true (errors, or an explicit success sample). Copy upstream headers/bodies only on that same retain path. Rejections still build detail immediately because they are always retained.

Late stream-copy errors after the client body is released may retain error metadata without the original request body.

## Alternatives considered

**Always keep `originalBody` until the response finishes.** That reintroduces the SSE retention chain the proxy already breaks after `Do`.

**Sample or store all success details.** Changes the default retention policy.

## Consequences

Successful unsampled requests no longer allocate sanitized header JSON or body strings for `request_log_details`. Error and sampled-success diagnostics stay complete. Summary `request_body_bytes` / `forwarded_body_bytes` / `response_body_bytes` are unchanged.

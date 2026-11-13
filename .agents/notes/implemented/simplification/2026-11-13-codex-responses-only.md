# Agent Note: Keep only native Codex Responses execution

Status: implemented

## Decision

The user explicitly narrowed the product to Codex and then chose Responses alone, with all protocol conversion performed by local Magpie. Remove the embedded CPA module, handler adapter, loopback client, other provider registration, Chat conversion, image execution, Realtime credentials and Cursor image runtime. Preserve Responses HTTP/compact/WebSocket, model discovery, encrypted account storage, parent/child admission and Magpie metering.

## Boundary and migration

Runtime loading and credential creation accept Codex only. Old non-Codex database rows and historical accounting remain intact. Magpie import advertises only Responses. Stored removed runtime settings are ignored by JSON loading; active configuration and the UI omit them. No fee backfill occurs. The existing offline CPA credential importer is a data-format migration utility, not an execution dependency.

## Consequences

Other clients must configure local Magpie or use a native Responses client. Native Codex website field normalization and SSE collection remain necessary even without cross-protocol conversion. Admission-pinned credentials cannot switch accounts during execution. Only definitive 401 authentication failures permit a same-account retry after refresh; other errors return directly.

## Validation

Exercise rejected protocols/providers, opaque tool payloads, stream usage, compact passthrough, token refresh, pinned model ownership, cooldown recovery, WebSocket multi-turn settlement and PostgreSQL cancellation/ledger boundaries. Preserve unrelated launcher edits already present in the checkout. Deployment requires the normal release checks; implementation does not mutate production.

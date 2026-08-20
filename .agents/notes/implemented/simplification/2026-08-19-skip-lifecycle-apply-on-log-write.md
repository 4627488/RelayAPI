# Agent Note: Skip pending CPA lifecycle apply on every log write

Status: implemented

## Problem

`writeLogTx` called `applyPendingCPALifecycleEvents`, which `SELECT`s leftover lifecycle rows for the request id on every HTTP and WebSocket log write. After de-CPA, `RecordUpstreamLifecycleEvent` had no production callers.

## Decision

Stop applying pending lifecycle rows from `writeLogTx`. Later the write/apply helpers in `internal/store/lifecycle.go` were deleted entirely. Keep the `upstream_lifecycle_events` table, model, and retention cleanup for upgrade leftovers. A later note can `DROP` the table after a release.

## Alternatives considered

**Drop the table now.** Upgrade leftovers could still exist for 24h–7d. Retention already deletes them.

**Keep the per-write SELECT "just in case".** New traffic never inserts pending rows, so the query is pure write-path tax.

## Consequences

New request logs are not enriched by leftover pending events. There is no longer an API to insert lifecycle events.

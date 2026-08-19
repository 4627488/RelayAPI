# Agent Note: Skip pending CPA lifecycle apply on every log write

Status: implemented

## Problem

`writeLogTx` called `applyPendingCPALifecycleEvents`, which `SELECT`s `cpa_lifecycle_events` for the request id on every HTTP and WebSocket log write. `RecordCPALifecycleEvent` has no production callers (tests only). [docs/retention.md](../../../../docs/retention.md) already says Bridge 0.6+ does not produce new lifecycle rows; the table remains for upgrade leftovers.

## Decision

Stop applying pending lifecycle rows from `writeLogTx`. Keep `RecordCPALifecycleEvent`, apply helpers, the table, and retention cleanup. If a test needs enrichment, write the request log first and then record the event — `RecordCPALifecycleEvent` still applies immediately when the log row exists.

## Alternatives considered

**Drop the table now.** Upgrade leftovers could still exist for 24h–7d. Retention already deletes them; a later note can drop the table after a release.

**Keep the per-write SELECT "just in case".** New traffic never inserts pending rows, so the query is pure write-path tax.

## Consequences

New request logs are not enriched by leftover pending events with the same id (those ids are old). Any future CPA event bus must call `RecordCPALifecycleEvent` after the log exists, or restore write-path apply explicitly.

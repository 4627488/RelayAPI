# Agent Note: Cheapen ResolveKey, TouchKey, and daily token limits

Status: implemented

## Problem

Every inference request still paid for three avoidable Postgres costs after the earlier log-query cleanup:

1. `ResolveKey` loaded the key, then the tenant, then aliases, then grants.
2. `TouchKey` updated `last_used_at` on every completed request.
3. Configured daily token limits scanned today's `request_logs` before admission.

Those are function-preserving costs. The product already keeps billing and quota on Postgres row locks; it does not need Redis or a second counter store.

## Decision

Join `api_keys` and `tenants` in `ResolveKey` and load aliases in one follow-up query. Debounce `TouchKey` to once per key per minute in process. Maintain `daily_tokens_used` / `daily_tokens_day` on tenant and key rows inside `writeLogTx`, including upsert deltas. `ResolveKey` returns today's counters so `enforceLimits` does not query logs.

The counters store the process-local civil day as a UTC date, matching the previous `started_at >= local midnight` window.

## Alternatives considered

**In-process ResolveKey cache.** Invalidation has to cover disable, allowlists, aliases, and subscription grants. A miss is an auth hole.

**Redis INCR for daily tokens.** A second source of truth next to settlement and log writes.

**Keep summing `request_logs`.** Correct, but the scan grows with today's traffic whenever a limit is set.

## Consequences

Admission with daily token limits reads the key/tenant row already fetched for auth. `last_used_at` can lag by up to a minute. Mid-day upgrade backfills today's log sums into the new columns. Websocket upserts apply a token delta, not a second full add.

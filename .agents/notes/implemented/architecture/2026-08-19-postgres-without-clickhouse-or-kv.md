# Agent Note: Keep request logs and hot-path state on Postgres; do not add ClickHouse or Redis

Status: implemented

## Problem

Request-log growth and per-request Postgres reads invite "add ClickHouse for logs" and "add Redis/KV to accelerate auth." Both would add a stateful component beside a bounded gateway whose money path already requires transactional row locks.

## Decision

Stay on a single Postgres for logs, usage rollups, reservations, and key lookup.

Logs already have three layers: sampled/error details, 30-day `request_logs` summaries, and `usage_daily_rollups` after compaction ([docs/retention.md](../../../../docs/retention.md)). Query cost is fixed in-process (one aggregate for `QueryLogs`, dashboard totals merge rollups) rather than by shipping events to an OLAP store.

Hot-path caches that matter already live in process: `pricing.Catalog` snapshot, per-minute `allowRate`, CPA admission/circuit. Session is an HMAC cookie. `AdmitRequest` stays on Postgres because it locks balance and child-quota windows in one transaction.

Revisit ClickHouse only if retained `request_logs` regularly exceed about 10–50 million rows *and* the workbench is still slow after the Postgres query fixes. Revisit a process-local `ResolveKey` cache (not Redis) only if `resolve_key` spans stay multi-millisecond or daily token-limit `SUM`s become the default path.

## Alternatives considered

**Add ClickHouse for summaries and keep Postgres for billing.** Dual-write, delayed workbench, and no join from CH rows to `request_reservations`. Does not help the default 8-in-flight Compose topology.

**Add Redis for API keys, daily tokens, or reservations.** Key cardinality is admin-scale; a stale cache after disable/allowlist change is an auth bug. Caching reservations or balances is how you double-spend. Daily token sums run only when a limit is configured.

**In-process `ResolveKey` TTL cache in this change.** Premature; invalidation must cover key, tenant, and subscription grant writes. Left out until traces show the lookup is expensive.

## Consequences

Operators keep one database. Agents must not treat "add CH/Redis" as a low-effort performance fix. The negative decision is the point of this note.

# Agent Note: Preserve CPA usage outcomes across settlement and charge logs

Status: implemented

## Problem

The CPA plugin already distinguishes `Generate=false` from incomplete token accounting. Relay discarded `not_generated`, causing a WebSocket prewarm to accrue its reservation estimate and poison the session completeness flag. The request log hid the estimate while child quota had already been debited. A separate connection probe appeared as a billing step, and a requested-tier fallback labelled the prewarm Fast while the actual generation returned default.

## Decision

[CPA usage adaptation](../../../../third_party/cpaexecutor/usage.go) retains non-generation identity and quality through [Relay adaptation](../../../../internal/app/cpa_usage.go). [Shared assessment](../../../../internal/billing/settlement.go) handles explicit non-generation, complete generation and conservative incomplete generation for HTTP and WebSocket. Zero usage alone does not imply prewarm. CPA's local synthetic prewarm emits no plugin callback; it requires explicit frame intent, CPA's dedicated synthetic response ID and a complete zero-usage acknowledgement. Frame intent resets on each follow-up. This small compatibility rule belongs at the runtime boundary and is covered separately from executed prewarm.

[Logs](../../../../internal/store/store.go) persist CPA usage quality and the amount actually accrued, with pricing completeness identifying estimates. Existing log units distinguish step, prewarm and connection without adding another event store. Lists show only settled positive charges, including estimates and child-quota charges, as requested by the user. Trace-only records remain addressable by ID; generation reports, latency samples, heatmaps and retention rollups exclude prewarm and connection. Requested Fast is visually distinct from upstream-confirmed Priority; actual tier controls pricing when returned.

[Automatic repricing](../../../../internal/store/pricing_backfill.go) only processes runtime-complete usage or positive legacy token evidence, never missing/inconsistent/ambiguous CPA usage or unknown zero-token records. Historical records without runtime proof are not reclassified as prewarm or refunded automatically.

## Alternatives considered

Hide zero-token rows without changing accounting: rejected because it leaves hidden child-quota debits. Treat every missing callback as zero: rejected because callback loss and executor retries must not make generation free. Infer prewarm from zero tokens: rejected because a legitimate zero-token generation is a different outcome. Patch CPA's provider executors or add a second event datastore: rejected because the public usage plugin and the existing PostgreSQL transaction already provide the necessary ownership and durable idempotency. Display all transport/prewarm events in the product list: the user explicitly requested only charges, so those events stay diagnostic.

## Consequences

No new CPA fork patch is required. Explicit prewarm costs zero and cannot poison aggregate pricing completeness. Terminal settlement stays synchronous and transactional before forwarding completion, with per-response replay deduplication. Incomplete usage still consumes the conservative estimate and is visible as such. The new usage_quality column has an empty legacy default and migrates through the existing AutoMigrate path; old records remain readable. The charge list intentionally excludes uncharged failures, zero-price generations and unsettled amounts; operational error statistics still cover real generation failures.

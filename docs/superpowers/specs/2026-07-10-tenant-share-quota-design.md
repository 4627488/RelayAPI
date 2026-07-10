# Tenant Share Quota and Cost Accounting Design

## Goal

Give every tenant independent Codex-style 5-hour and 7-day limits. An administrator assigns quota shares to a tenant. One Plus subscription represents one share and one Pro subscription represents twenty shares. The system infers the effective cost capacity of one share from observed upstream Codex quota movement and charges tenant requests using model-aware prices rather than raw token counts.

## Product semantics

- The tenant is the accounting principal. All users, sessions, and API keys in a tenant share the same two quota windows.
- A null tenant share disables share-based limits for that tenant. A positive decimal enables them.
- Each tenant has independent fixed 5-hour and 7-day windows. The first admitted request opens a window; it resets after its duration. Changing shares immediately changes the limit without erasing settled usage.
- A request is rejected before upstream dispatch if either window has no reservable capacity.
- Admitted requests may finish even if their final cost crosses a limit. Reservations based on recent same-model request costs reduce concurrent overshoot.
- Rejections use HTTP 429 with a Codex-compatible error object, `Retry-After`, the exhausted window, used/limit/remaining values, and reset time.
- Successful responses expose quota state in response headers. Administrative and tenant APIs expose the same state as structured data.

## Cost model and pricing

Every completed request stores raw usage and an immutable price snapshot. Cost is the sum of all available components:

```
input tokens * input price
+ output tokens * output price
+ cache-read tokens * cache-read price
+ cache-write tokens * cache-write price
+ reasoning tokens * reasoning price
```

Prices use integer nano-dollars internally so arithmetic is deterministic. Missing usage components contribute zero, but their absence is recorded for calibration health.

Price precedence is:

1. Administrator override.
2. Locally cached LiteLLM `model_prices_and_context_window.json` entry.
3. A bundled last-known-good snapshot.

The server refreshes the remote catalog on demand and on a scheduler, validates it, and atomically activates a new local version. Request handling never depends on a live network fetch. Unknown or incomplete models are reported as unpriced. They are excluded from calibration and, for tenants with enforced share quotas, rejected with a configuration error instead of being treated as free. Model aliases can map relay model names to catalog entries.

## Capacity calibration

The existing Codex quota refresh path supplies used percentages, reset times, plan type, and retrieval time for each upstream credential. Each refresh also captures the complete priced request cost attributed to that credential since the prior snapshot.

For each unchanged window:

```
credential capacity = observed priced cost / (used percent delta / 100)
one-share capacity = credential capacity / plan shares
```

Plan shares default to Plus = 1 and Pro = 20 and are configurable for future plan names. Five-hour and seven-day samples are independent.

A sample is accepted only when snapshots belong to the same reset interval, percentage usage increased by a configurable minimum, all intervening usage was priced, and counters are internally consistent. Resets, decreases, stale gaps, tiny percentage deltas, and incomplete pricing produce a rejected sample with a reason.

The active automatic baseline is a weighted median of recent accepted samples after median-absolute-deviation outlier filtering. Confidence reflects sample count, credential diversity, age, percentage span, and pricing completeness. Administrators can override either window baseline. The effective baseline is the override when present, otherwise the automatic value. If neither is healthy, enforced tenants fail closed with an actionable quota-configuration response.

## Storage boundaries

Synchronous accounting data lives in the main SQLite database:

- Tenant share configuration.
- Versioned model prices, aliases, catalog metadata, and overrides.
- Credential quota snapshots and accepted/rejected calibration samples.
- Effective per-window baselines and plan-share mappings.
- Tenant quota window counters.
- Request reservations with expiry and settlement state.

Window admission and reservation are one immediate transaction. Settlement atomically converts reserved cost to settled cost in both windows. Expired reservations are reclaimed lazily during admission and by periodic maintenance.

Analytical data lives in the log database. Request and usage records gain pricing version, component prices, component costs, total cost, pricing completeness, and reservation variance. The existing asynchronous log queue remains non-authoritative for enforcement.

## Request flow

1. Authentication resolves the tenant and API key as it does today.
2. Payload normalization resolves the effective model and its immutable price snapshot.
3. Accounting opens or rolls expired tenant windows and estimates a reservation from recent same-tenant/same-model cost history, with a safe global fallback.
4. A transaction checks both windows and creates one reservation covering both.
5. The relay calls upstream and continues collecting usage from response JSON or SSE events.
6. On completion, actual priced cost settles the reservation. Upstream failure before usable output releases it; partial streamed output is charged when usage is available.
7. The request log receives the same accounting result for reporting.

Normal response headers include effective shares plus 5-hour and 7-day limit, used, remaining, reset epoch, and baseline confidence. Values use stable cost-unit headers rather than pretending to be raw token counts.

## Error handling

Quota exhaustion returns a JSON error before an SSE stream is established:

```json
{
  "error": {
    "type": "rate_limit_error",
    "code": "tenant_quota_exceeded",
    "message": "Tenant 5-hour quota is exhausted.",
    "window": "5h",
    "limit": 0,
    "used": 0,
    "remaining": 0,
    "resets_at": "..."
  }
}
```

Unknown model prices and unavailable baselines use distinct configuration error codes. They must never masquerade as quota exhaustion. Reservation cleanup and duplicate settlement are idempotent. A request identifier is the idempotency key.

## APIs and interfaces

The administrator tenant editor gains quota shares, enabled state, current two-window usage, and reset actions. The operations area gains:

- Effective 5-hour and 7-day per-share baselines, confidence, overrides, and sample history.
- Pricing catalog version, refresh health, aliases, overrides, and missing-model alerts.
- Cost analysis by tenant, credential, model, token category, and time range.

The tenant workspace gains its own 5-hour and 7-day meters, reset countdowns, share count, estimated cost remaining, and model-level cost analysis. It cannot see upstream credential identities or other tenants.

Existing daily raw-token limits remain supported and are evaluated independently. A request must pass every enabled policy.

## Testing

- Unit tests cover price precedence, aliases, component arithmetic, integer rounding, reservations, window rollover, share changes, idempotent settlement, and 429 formatting.
- Calibration tests cover valid deltas, percentage rounding, reset boundaries, Plus/Pro normalization, incomplete prices, weighted medians, outliers, confidence, and overrides.
- Repository tests exercise migrations, atomic concurrent admission, expiry reclamation, and tenant isolation.
- Relay tests cover JSON and SSE usage extraction, success headers, early failures, partial streams, quota rejection before upstream dispatch, and existing daily-limit coexistence.
- API and component tests cover administrator editing, tenant visibility boundaries, pricing refresh/override, and cost breakdowns.
- Full typecheck, lint, unit tests, and production build are required before completion.

## Delivery boundaries

This feature does not attempt to reproduce undocumented upstream billing exactly. It builds an observable, confidence-scored estimate from local priced traffic and upstream percentage movement. Raw observations, rejection reasons, price versions, and overrides remain inspectable so operators can diagnose drift.

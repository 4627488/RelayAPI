# Agent Note: Separate personal shared subscriptions from model billing access

Status: implemented

## Problem

The personal subscription page mixed balance access grants with shared quotas and displayed parent names, potentially including immutable upstream email addresses. Its card hierarchy emphasized upstream accounts and repeated metadata while expiry, resets and remaining capacity competed for attention. Users could not inspect the full model pool and understand which subscription or balance paid for each model.

## Decision

Only observed/shared grants appear in My Subscriptions. Use flat rows, administrator-editable child names, independent expiry and reset displays, and 12px progress tracks. Use locally scoped green/orange/red data colors with dark equivalents as explicitly requested, without recoloring global components. Fold model details and reset history into an accessible disclosure. Keep expired and disabled subscriptions visible but visually inactive; distinguish pending activation, exhausted quota, unknown capacity and stale resets. Update relative times each minute. Never imply a quota reset extends subscription validity.

The tenant API omits upstream parent names and plan metadata and anonymizes legacy child names that copied credential names or contain email identities. Generic service messages replace parent/child implementation vocabulary. Preserve existing APIs and admission invariants for all other consumers. Administrator defaults for new child names derive from provider/product labels rather than account names.

Add a separate session-authenticated model catalog at `/api/models` and personal page `/app/models`. Build model entries from concrete runtime models, tenant permissions and active grants. Honor wildcard intersections and the balance-grant rule that ignores obsolete child restrictions. Merge balance options per model without exposing account identity. Display quota settlements using safe child names and ordinary section links to the personal subscription row. A claimed model has only its actual configured options; quota exhaustion does not manufacture a balance fallback. Include temporarily unavailable authorized models so users can inspect their associated subscription.

## Alternatives considered

Tabs separating balance accounts from shared accounts would retain upstream-centric organization and duplicated models. Hiding the email only in JSX would leave it readable in API responses. Inferring billing solely from the tenant allowlist would falsely offer balance fallback on claimed models, violating admission behavior. Removing balance-grant storage would change strict routing, so it stays internal.

## Consequences

No quota reservation or billing policy changes. The catalog is descriptive, not a settlement picker; API-key restrictions still apply. Runtime absence produces a retryable catalog error. New tests cover response privacy, legacy names, grant lifecycle and policies, balance deduplication, no fallback on exhaustion, responsive flat layout, dark-theme accessibility and subscription links. The reference projects were New API and Sub2API; no source code was copied.

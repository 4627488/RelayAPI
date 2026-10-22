# Agent Note: Observe Claude subscriptions independently from quota usage

Status: implemented

## Problem

The Claude probe read only OAuth usage percentages and credential plan hints. A plan change could remain stale indefinitely. Extra usage lost its monetary values, null utilization hid valid spend, and newer scoped-limit and independent dollar-pool schemas were ignored. Treating profile success as successful usage would also risk releasing expired quota generations without a new usage observation.

## Decision

Extend the existing [native probe](../../../../internal/gateway/quota_claude.go) and quota snapshot with independent subscription metadata. Read the fixed upstream profile endpoint through the same account client and proxy, with a bounded advisory timeout. Prefer the token's organization over personal flags. Keep plan and rate-limit tier separate so existing product naming and shared allocation conventions continue to work. Preserve the existing five-minute Claude cache and failure backoff.

Normalize extra-usage cents separately from dollar-denominated credit pools. Keep null amounts unknown and preserve disabled states. New scoped rows are observations rather than account-wide enforcement inputs. Explicit inference-only scope metadata skips unsupported account queries; old documents with absent scope metadata retain best-effort probing.

When usage fails, [quota synchronization](../../../../internal/app/quota_sync.go) merges only subscription metadata into the previous snapshot. The [store](../../../../internal/store/subscriptions.go) accepts a successful profile as authority for replacing or clearing a plan while preserving usage errors and observation clocks. See [capability coverage and references](../../../../docs/claude-upstream.md).

## Alternatives considered

Relying on credentials or token refresh for plan discovery loses changes between refreshes and CPA currently retains account identity rather than the full profile product metadata. Failing the entire probe when profile is unavailable would throw away valid quota. Returning a successful combined probe when only profile succeeds could incorrectly advance admission's idle-window evidence. Inferring total capacity from upstream dollars would conflate subscription allocation with independent spending pools. Adding a second cache, datastore or externally configurable endpoint duplicates existing lifecycle controls without improving correctness.

## Consequences

Management views show live plan tiers, stale profile status and amount-based windows using the existing components. Profile payloads and error bodies are not stored; only product fields and bounded status codes are retained. The existing usage 401 refresh policy remains unchanged. Profile-only authentication failures do not refresh a token that successfully queried usage. Tests cover both partial-success directions, persistence of usage clocks and frontend display. Live account compatibility remains a separate validation boundary; reset-credit redemption, automatic spending changes and model-scoped admission are outside this change.

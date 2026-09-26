# Agent Note: Remove the duplicate quota probe from the CPA wrapper

Status: implemented

## Problem

`internal/cpa` and `internal/gateway` each had a full provider quota parser. Production `internal/app/quota_sync.go` calls `gateway.ProbeQuota`; searches of `cmd/` and non-test `internal/` found no caller of `cpa.ProbeQuota` or its quota types. The unused copy inferred Grok plan names from monthly billing amounts, including `free` for zero, even though monthly billing is not an authoritative subscription tier.

## Decision

Remove the unused `internal/cpa` probe, its provider parsers, types, and tests. Retain `internal/gateway` for active quota probes because the embedded CPA exposes passive Codex quota signals but no normalized Grok subscription-window report for Relay's parent/child quota policy. The active Grok parser takes the display plan from upstream `/v1/settings` or an explicit billing `subscriptionTier` and never guesses a plan from `monthlyLimit`. Successful probes replace an old plan even when the upstream omits the tier.

## Alternatives considered

**Keep both implementations aligned.** The unused copy still adds a second source of provider-specific behavior and tests with no production consumer.

**Drop active provider probes and rely only on CPA status.** CPA status exposes scheduler cooldown and some passive Codex signals, but does not provide the complete window snapshots Relay needs for subscription calibration, particularly for Grok.

## Consequences

An old inferred Grok plan disappears on the next successful probe if the upstream supplies no tier. Quota windows continue to come from the active gateway probe; no provider request or billing policy changes.

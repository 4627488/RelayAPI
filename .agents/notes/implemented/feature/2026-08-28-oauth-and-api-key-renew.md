# Agent Note: Renew OAuth tokens and API keys before they go dark

Status: implemented

## Problem

OAuth access tokens last about an hour. CPA had `StartAutoRefresh`; native runtime only refreshed on inference and the 5-minute quota tick, and only for parents that were still marked available. Idle or probe-skipped accounts went stale, the UI never showed `last_refreshed_at`, and operators had to re-OAuth. Tenant API keys already had `expires_at` on the row and the public path rejected expired keys, but create/update never wrote the field and there was no renew action. The error text also said "无效或已停用", so every expired key looked like a bad secret.

## Decision

Native runtime now has `RefreshDueCredentials`. The one-minute maintenance loop renews every registered OAuth credential inside the 5-minute lead window, independently of quota sync. Successful refresh writes `LastRefreshedAt`. Admin `POST /api/admin/providers/accounts/{id}/refresh` force-renews one account. The account payload exposes `token_expires_at` from the document.

API key create/update accept optional `expires_at` (RFC3339, must be in the future; empty means never). `POST /api/keys/{id}/renew` and the admin twin extend a dated key by 90 days from `max(now, current expiry)`. Keys with no expiry stay unlimited. Expired keys return `api_key_expired`.

## Alternatives considered

**Keep relying on quota-tick refresh only.** That is what shipped after CPA was removed. It misses parents skipped as `UpstreamUnavailable` and gives operators no renew button when a token is already dead.

**Copy CPA's 15-minute `StartAutoRefresh` as a second scheduler.** A minute check that only calls the provider when `tokenNeedsRefresh` is enough and stays on the existing maintenance loop.

**Default new API keys to 90 days.** The complaint is keys dying too soon. Unlimited remains the default; expiry is opt-in.

## Consequences

Idle OAuth accounts stay usable without a new login while the refresh token is valid. Manual renew still cannot resurrect a revoked refresh token. API keys do not expire unless someone sets a date; renew is a no-op for unlimited keys.

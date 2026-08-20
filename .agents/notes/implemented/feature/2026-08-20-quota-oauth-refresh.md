# Agent Note: Refresh OAuth tokens before quota probe

Status: implemented

## Problem

Kimi (and the same OAuth parents) already refresh on the inference path:
`refresh_token` against `auth.kimi.com`, persist via `OnCredentialUpdated`.
Quota sync loaded the stored document and called `ProbeQuota` with that
access token. An expired token became HTTP 401, the 5h window stopped
rolling, and Admit failed with `subscription_unavailable` even though the
refresh token was still valid. Operators did not need to re-OAuth.

CPA keeps a background refresh loop and refreshes five minutes before
`expired`. Relay had no equivalent on the quota path.

## Decision

Expose `Runtime.RefreshCredential(id, force)` using the existing provider
refresh. Codex / Kimi / xAI all share this path. Quota sync:

- refreshes when the token is expired, inside a 5-minute lead, or missing
  `expired`
- persists the new document through the existing callback
- on probe HTTP 401 / `invalid_auth_token`, force-refresh once and retry
  the probe

Refresh itself now matches CPA for every OAuth parent:

- Codex: `scope=openid profile email`, default `auth.openai.com/oauth/token`,
  refresh `id_token` updates `account_id` / email
- Kimi: device headers, default `auth.kimi.com/api/oauth/token`
- xAI: default `auth.x.ai/oauth2/token` when the document has no
  `token_endpoint` (CPA would discover; Relay persists the default after
  the first refresh), `sub` / email from `id_token`
- Expiry from `expires_in`, else JWT `exp`, else one hour, written to
  `expired`

Inference still does not retry the user request after 401.

## Alternatives considered

**Tell operators to re-login.** Unnecessary when `refresh_token` works.

**Delete the stale 5h window.** Hides the observation failure; the next
successful probe should roll the window.

**Copy CPA's standalone refresh loop.** The 5-minute quota tick plus
refresh-before-probe covers idle parents; inference already refreshes on
expiry and 401.

## Consequences

A parent whose access token is stale but whose refresh token is valid
recovers on the next quota sync without a new OAuth login. Refresh
failure (revoked refresh token) still surfaces as a probe error.

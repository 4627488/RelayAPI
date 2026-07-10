# Account Operations and Actionable Metrics

## Goal

Replace low-value dashboard inventory metrics with actionable operational signals and add the missing account-security lifecycle for administrators and tenants.

## Metric Decisions

### Administrator overview

Remove tenant, API key, credential, and channel counts from the default overview. Inventory totals belong on resource pages and do not identify work that needs attention.

The primary overview shows:

- Traffic: request count for the selected period with change against the preceding comparable period.
- Reliability: error rate and absolute error count.
- User experience: P95 first-token latency, with P95 total latency as supporting context.
- Cost efficiency: average tokens per request and cached-token savings.

The attention area prioritizes unhealthy channels, unavailable or quota-constrained credentials, concentrated recent errors, and expired or disabled tenants. Deep rankings and dimensional matrices remain collapsed by default.

### Tenant overview

Remove active API-key count from the headline metrics. Move cache hit rate to secondary cost analysis.

The primary overview shows:

- Today token consumption and remaining daily allowance when limited.
- Today request count.
- Success rate with absolute failure count.
- P95 first-token latency with total latency as supporting context.

Quota progress is hidden for unlimited tenants. Limited tenants receive a consumption state: normal, elevated, or likely to exhaust early. API-key comparisons exclude keys without requests and prioritize requests, failures, tokens, and last activity.

## Public Website URL

Add an optional global `publicBaseUrl` setting.

- Accept only absolute `http` or `https` URLs.
- Normalize by removing trailing slashes.
- Password-reset APIs return a token, relative path, and expiry rather than constructing a server-origin URL.
- The administrator browser constructs the copyable link using configured `publicBaseUrl` when present, otherwise `window.location.origin`.
- Listener addresses and request host headers are never used to construct reset links, preventing `0.0.0.0` links and host-header injection.

## Tenant Password Reset

Administrators can generate a one-time tenant password-reset token from the tenant row actions.

- Store only a SHA-256 token hash.
- A new token invalidates previous unused reset tokens for that tenant.
- Tokens expire after one hour.
- The administrator dialog displays a copyable reset URL and expiry.
- The public reset page accepts the token and a new password.
- Successful reset consumes the token, updates the password hash, increments the tenant session version, and invalidates all existing tenant sessions.
- Responses do not reveal password hashes or token hashes.

## Password Changes and Session Revocation

### Tenant

Tenant settings include a password-change form requiring the current password, a new password, and confirmation. Successful change updates the password hash and increments the session version. The response issues a fresh session cookie so the current browser remains signed in while other sessions become invalid.

### Administrator

Global settings include an administrator password-change form requiring the current password, a new password, and confirmation. Changing the stored administrator password invalidates existing administrator session cookies because their signature derives from the password hash. The response issues a fresh cookie for the current browser.

### Forced tenant sign-out

Administrators can increment a tenant session version without changing the password. This invalidates all tenant sessions and records the action.

## Account Activity

Add tenant fields:

- `session_version`, default `1`.
- `last_login_at`, nullable.
- `password_changed_at`, nullable.

Tenant sessions carry the session version and are rejected when it differs from the current tenant record. Successful login updates `last_login_at`. Tenant lists show last login and an account-security state without exposing secrets.

## Security Events

Persist compact security events for:

- tenant login,
- tenant password change,
- administrator reset-link creation,
- tenant reset completion,
- administrator forced sign-out,
- administrator password change.

Events include timestamp, event type, tenant ID when applicable, actor type, and non-sensitive metadata. Passwords, raw tokens, password hashes, and cookies are never logged.

## Components and Data Flow

- Repository layer owns reset-token persistence, session-version updates, account timestamps, and security events.
- Tenant service owns validation, password verification, hashing, token lifecycle, and session-version enforcement.
- Web-access service owns administrator password rotation.
- Route handlers translate service results to JSON and set refreshed cookies.
- Client API helpers expose typed operations.
- Administrator tenant actions own reset-link and force-sign-out dialogs.
- Tenant and administrator settings own password-change forms.
- A public tenant reset page owns token submission and success navigation.

## Validation and Errors

- Passwords must be at least 10 characters.
- New passwords must differ from the current password where a current password exists.
- Invalid, expired, or consumed reset tokens return the same user-facing invalid-link error.
- Current-password failures return an authentication error without sensitive detail.
- Reset and password-change operations are transactional where token consumption and password updates must remain atomic.

## Testing

- Repository tests cover reset-token replacement, expiry, consumption, and session-version persistence.
- Service tests cover current-password verification, reset completion, session invalidation, and URL validation.
- Route behavior is exercised through service-level tests where existing project patterns do not provide route integration infrastructure.
- Presenter tests cover removal and replacement of headline metrics, unlimited quota behavior, and consumption states.
- Run `pnpm test`, `pnpm lint`, and `pnpm build` before completion.

## Out of Scope

- Email delivery.
- MFA and role-based permissions.
- Account recovery without an administrator-generated link.
- Recording raw credentials or reset tokens.

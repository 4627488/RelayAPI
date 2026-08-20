# Parent and child subscription architecture

RelayAPI models every capacity-bearing encrypted upstream credential as a
parent subscription. Administrators split a parent into child subscriptions
assigned to tenants. RelayAPI owns encrypted credential storage and accounting;
the native runtime owns protocol translation, retries, and routing.

## Invariants

1. Client-supplied `X-Relay-*` headers are never trusted or forwarded.
2. A quota-enforced request is pinned to exactly one native runtime credential.
   The runtime must fail when that credential ID is not an eligible scheduler
   candidate and never silently delegate to another credential.
3. Metered allocation shares use integer parts-per-million (`allocation_ppm`).
   Enabled allocations may not exceed the parent's configured oversell limit.
   Unmetered parents use children as access grants and do not impose an
   allocation-sum limit.
4. Tenant balance and child-subscription capacity are independent policies.
   Admission atomically reserves both when both are enabled.
5. Every request has one durable reservation keyed by request ID. Reservation,
   settlement, release, and expiration are idempotent.
6. Child windows inherit the parent window's reset identity. A new parent
   `resets_at` starts a new child generation; tenant-relative windows are not
   invented for upstream-derived quota.
7. Monetary amounts are signed 64-bit integer nano-USD. Price information used
   by a request is snapshotted with the reservation and request log.
8. Missing terminal usage on a successful upstream response never becomes free
   quota. Relay settles the conservative reservation and marks the request as
   pricing-incomplete for later reconciliation. Rejected upstream requests
   release their reservations.
9. Tenants see child names, shares, usage, and reset times, but never parent
   credential IDs, account emails, tokens, or provider-private metadata.

## Data model

### Parent subscriptions

`parent_subscriptions` mirrors a redacted native credential identity:

- native credential ID stored as `upstream_credential_id` (mirrored onto
  `upstream_auth_index` for pricing-rule and log compatibility) and used for
  strict picks, observations, and request attribution;
- credential name, provider, status and cached model list;
- capacity mode: `unmetered` or `observed`;
- allocation/oversell limit and synchronization timestamps.
- normalized quota-probe capability, status, last error, observation time, and
  the latest secret-free upstream quota snapshot used by both management views.

`parent_quota_windows` stores arbitrary observed window kinds such as `5h`,
`7d`, `daily`, `monthly`, or `credits`. Window identity and timing are updated
by quota probes or native runtime metadata; administrators may only override each
window's USD conversion. The core does not hard-code a provider list.

### Child subscriptions

`child_subscriptions` binds a tenant to one parent with an integer allocation,
priority, lifecycle, and optional model allowlist. A tenant may own any number
of children, including multiple children on the same parent.

`child_quota_windows` holds the active counters inherited from each parent
window. Counters are changed only while holding PostgreSQL row locks.

### Upstream API-key distribution

Provider API keys follow the same redacted credential path as OAuth accounts:

1. the administrator stores the secret in Relay's encrypted credential store;
2. the native runtime loads the stable credential ID and auth index;
3. Relay synchronizes that identity as an `unmetered` parent subscription;
4. the administrator creates one or more child access grants for tenants;
5. Relay strictly pins each request to the selected native runtime credential, reserves
   the priced request cost from the tenant row, then settles the actual cost.

Provider API keys are encrypted as whole credential documents and are never
returned to a tenant. Creating a
child does not transfer money into a second wallet: all children of a tenant
share that tenant's single `balance_nano_usd` balance and billing ledger.

### Request reservations

`request_reservations` is the idempotency and reconciliation authority. It
records the tenant, API key, child, parent, credential ID, balance reserve, quota
reserve, exact quota-window generations, actual cost, status, expiration, and
immutable price snapshot. A request crossing an upstream reset cannot be
settled into the next generation.

## Admission and routing

```text
tenant key
  -> tenant/key/model policy
  -> eligible child subscriptions
  -> lock and reserve balance + child windows
  -> set internal X-Relay-Upstream-Credential-ID
  -> native runtime strictly pins the parent credential ID
  -> protocol/provider request handled by native runtime
  -> parse response usage
  -> idempotently settle both reservations
```

Candidates are ordered by explicit priority and stable creation order.
Exhausted children are skipped before the upstream request. Native runtime model metadata
is cached per parent so obviously incompatible parents are not selected; the
native runtime remains the final authority on candidate validity.

A child subscription only claims the models allowed by its effective child,
parent, and native runtime model policies. If a tenant requests a model that is not
claimed by any active child, Relay falls back to normal native runtime scheduling and
settles the request against the tenant's total balance. If a model is claimed
but its assigned parent is unavailable or its child quota is exhausted, Relay
rejects the request instead of silently bypassing the configured subscription.

## Capacity modes

- `unmetered`: routing is pinned but no child quota is reserved. Balance billing
  and tenant/key limits still apply. This is the normal mode for pay-as-you-go
  upstream API keys: the key remains private in native runtime, any number of child access
  grants can be distributed, and every request is settled against the tenant's
  total Relay balance.
- `observed`: Relay uses a differential method: between two observations in
  the same upstream generation it divides credential-attributed USD cost by
  the upstream used-percentage increase to estimate the full parent capacity.
  Every upstream window (`5h`, `7d`, monthly, and future provider-defined
  kinds) is calibrated independently. An administrator can instead pin the USD
  capacity for each automatically discovered window. In that case the upstream
  still owns the window names, window set, percentages, and reset instants;
  automatic synchronization does not overwrite the administrator's USD
  conversion. Clearing an override immediately restores the best estimate from
  the current generation, and saving one override does not convert or delete
  other automatically learned windows. An
  observed parent with no calibrated window is admitted in learning mode with
  strict credential routing and normal balance billing, but no child-quota
  reservation. A provider explicitly reported as unsupported is rejected until
  an adapter is installed or the parent is switched to unmetered mode.
  Once accepted samples produce a capacity estimate, subsequent admissions
  enforce the learned nano-USD windows. Relay accumulates movement from the
  last calibration anchor until it reaches 0.1 percentage points, attributes
  only settled requests by completion time, and rejects intervals containing
  successful requests with incomplete pricing. The active estimate is the
  median of up to 21 accepted samples from the current upstream reset
  generation; older generations and isolated rounding noise cannot contaminate
  it.

## Native quota boundary

The quota runtime executes inside RelayAPI. Built-in probes follow the same
window contract used by Codex WHAM, official kimi-cli `/usages`, and xAI CLI
billing (as implemented by CPA / sub2api):

- Codex: `GET https://chatgpt.com/backend-api/wham/usage` with
  `ChatGPT-Account-ID` and `OpenAI-Beta: codex-1`. `rate_limit.primary_window`
  is `5h`, `secondary_window` is `7d` (`limit_window_seconds` 18000 / 604800 /
  86400 refine the kind). `reset_at` wins over `reset_after_seconds`. Null
  windows are unused slots. Spark (`metered_feature=codex_bengalfox`) is
  display-only as `spark-5h` / `spark-7d`. Missing account id fails closed.
- Kimi: `GET /coding/v1/usages` (Moonshot fallback) with official `KimiCLI/1.3`
  fingerprint headers. Top-level `usage` is the weekly `7d` window;
  `limits[]` with 300 minutes is `5h`. Kinds are never invented from labels.
- xAI: parallel `GET /v1/billing?format=credits` and `GET /v1/billing`. Weekly
  `7d` comes from `config.creditUsagePercent` (missing percent with a parseable
  period is 0%). Monthly and prepaid are display-only. Plan comes from
  `subscriptionTier` only. HTTP 412 / "no personal team" is unsupported, not a
  probe error. Billing probes never send a `/responses` "hi" that consumes
  quota.

Only standard `5h` / `7d` / `1d` windows with a future reset are enforceable.
A credential may instead expose normalized `relay_quota` metadata directly.
Reports exclude credential fields and raw upstream payloads.

Codex, Kimi, and xAI are probed with the encrypted native credential and the
reusable proxy explicitly selected for that model account. An account without a
selected proxy always uses a direct connection and does not inherit the system
proxy. The same account route is used for inference, model discovery, token
refresh, and quota probes.

The native runtime credential table and parent-subscription table render the same stored
snapshot: plan, used/remaining percentage, reset time, raw credit units, and
non-enforceable product/model windows. Automatic/observed mode treats these
fields as read-only and exposes only the USD capacity conversion for each
enforceable observed window.
Model policies are selected from the credential's native runtime-synchronized model list;
an empty selection means inherit all available models.

Upstream quota and child share are intentionally separate. native runtime/adapter data can
discover a credential's plan, percentage consumption, reset time, and sometimes
raw credits. Only an administrator can decide the child `allocation_ppm` policy;
native runtime scheduler weight is not a tenant allocation share.

## Migration and rollout

Existing tenants remain balance-only until they are assigned an enabled child
subscription. Legacy scheduler hashes are migrated in place to native
credential IDs, preserving parent IDs and every child foreign-key association.
Rollout order:

1. import and encrypt credentials in PostgreSQL;
2. synchronize native credential IDs into existing parent rows;
3. verify native quota observations and reset generations;
4. enable enforcement after model and quota validation;
5. remove the external native runtime service and legacy watchdog;
6. reconcile and monitor incomplete-pricing requests before global enablement.

The legacy Next.js implementation is a behavioral reference, not a storage or
provider abstraction to copy. This design replaces its floating-point shares,
SQLite concurrency, in-memory calibration tasks, and Codex/Grok registry with
PostgreSQL row locking and native runtime-native identity/routing.

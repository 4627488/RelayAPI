# Parent and child subscription architecture

RelayAPI models every capacity-bearing CLIProxyAPI authentication identity as a
parent subscription. Administrators split a parent into child subscriptions
assigned to tenants. CLIProxyAPI continues to own credentials, OAuth, protocol
translation, aliases, retries, and the provider registry; RelayAPI stores only
the stable CPA AuthID and accounting metadata.

## Invariants

1. Client-supplied `X-Relay-*` headers are never trusted or forwarded.
2. A quota-enforced request is pinned to exactly one embedded CPA credential.
   The runtime must fail when that AuthID is not an eligible scheduler
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
   AuthIDs, account emails, tokens, or provider-private metadata.

## Data model

### Parent subscriptions

`parent_subscriptions` mirrors a redacted CPA authentication identity:

- CPA scheduler `id` stored as `cpa_auth_id` and used only for strict picks;
- stable management `auth_index` stored separately for synchronization,
  observations, request attribution, and credential administration;
- CPA auth-file name, provider, display name, status, and cached model list;
- capacity mode: `unmetered` or `observed`;
- allocation/oversell limit and synchronization timestamps.
- normalized quota-probe capability, status, last error, observation time, and
  the latest secret-free upstream quota snapshot used by both management views.

`parent_quota_windows` stores arbitrary observed window kinds such as `5h`,
`7d`, `daily`, `monthly`, or `credits`. Window identity and timing are updated
by quota probes or CPA metadata; administrators may only override each
window's USD conversion. The core does not hard-code a provider list.

### Child subscriptions

`child_subscriptions` binds a tenant to one parent with an integer allocation,
priority, lifecycle, and optional model allowlist. A tenant may own any number
of children, including multiple children on the same parent.

`child_quota_windows` holds the active counters inherited from each parent
window. Counters are changed only while holding PostgreSQL row locks.

### Upstream API-key distribution

Provider API keys follow the same redacted credential path as OAuth accounts:

1. the administrator stores the secret in CPA's provider configuration;
2. CPA exposes the runtime credential's scheduler ID and stable auth index;
3. Relay synchronizes that identity as an `unmetered` parent subscription;
4. the administrator creates one or more child access grants for tenants;
5. Relay strictly pins each request to the selected CPA credential, reserves
   the priced request cost from the tenant row, then settles the actual cost.

No provider API key is copied into Relay or returned to a tenant. Creating a
child does not transfer money into a second wallet: all children of a tenant
share that tenant's single `balance_nano_usd` balance and billing ledger.

### Request reservations

`request_reservations` is the idempotency and reconciliation authority. It
records the tenant, API key, child, parent, AuthID, balance reserve, quota
reserve, exact quota-window generations, actual cost, status, expiration, and
immutable price snapshot. A request crossing an upstream reset cannot be
settled into the next generation.

## Admission and routing

```text
tenant key
  -> tenant/key/model policy
  -> eligible child subscriptions
  -> lock and reserve balance + child windows
  -> set internal X-Relay-CPA-Auth-ID
  -> embedded CPA strictly pins the parent AuthID
  -> protocol/provider request handled by CPA
  -> parse response usage
  -> idempotently settle both reservations
```

Candidates are ordered by explicit priority and stable creation order.
Exhausted children are skipped before the upstream request. CPA model metadata
is cached per parent so obviously incompatible parents are not selected; the
embedded runtime remains the final authority on candidate validity.

A child subscription only claims the models allowed by its effective child,
parent, and CPA model policies. If a tenant requests a model that is not
claimed by any active child, Relay falls back to normal CPA scheduling and
settles the request against the tenant's total balance. If a model is claimed
but its assigned parent is unavailable or its child quota is exhausted, Relay
rejects the request instead of silently bypassing the configured subscription.

## Capacity modes

- `unmetered`: routing is pinned but no child quota is reserved. Balance billing
  and tenant/key limits still apply. This is the normal mode for pay-as-you-go
  upstream API keys: the key remains private in CPA, any number of child access
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
  conversion. An
  observed parent with no calibrated window is admitted in learning mode with
  strict credential routing and normal balance billing, but no child-quota
  reservation. A provider explicitly reported as unsupported is rejected until
  an adapter is installed or the parent is switched to unmetered mode.
  Once accepted samples produce a capacity estimate, subsequent admissions
  enforce the learned nano-USD windows. Movements of 0.01 percentage points or
  more can produce a sample; incomplete pricing and cross-reset samples are
  rejected. The active estimate is the median of up to 21 recent accepted
  samples rather than the latest sample alone.

## Quota extension boundary

The bridge quota runtime is provider-neutral. An adapter manifest declares:

- one or more provider extension keys and upstream HTTP requests;
- credential templates such as `${auth.access_token}`;
- optional requests for partially available provider APIs;
- JSON paths for plan values, used/remaining percentages, raw limit/remaining,
  and reset timestamps;
- which windows are safe to enforce and calibrate.

The bundled Codex and xAI entries are default adapter data, not Go branches.
Custom entries run through the exact same engine and may override or replace
the bundled pack. A CPA credential may instead expose normalized `relay_quota`
metadata directly. In every case the bridge response excludes credential
fields and raw upstream payloads.

The CPA credential table and parent-subscription table render the same stored
snapshot: plan, used/remaining percentage, reset time, raw credit units, and
non-enforceable product/model windows. Automatic/observed mode treats these
fields as read-only and exposes only the USD capacity conversion for each
enforceable observed window.
Model policies are selected from the credential's CPA-synchronized model list;
an empty selection means inherit all available models.

Upstream quota and child share are intentionally separate. CPA/adapter data can
discover a credential's plan, percentage consumption, reset time, and sometimes
raw credits. Only an administrator can decide the child `allocation_ppm` policy;
CPA scheduler weight is not a tenant allocation share.

## Migration and rollout

The feature is additive. Existing tenants remain balance-only until they are
assigned an enabled child subscription. Strict subscription routing requires a
healthy bridge advertising the scheduler capability. Rollout order:

1. deploy header isolation and strict bridge behavior;
2. create parent/child/accounting tables;
3. synchronize CPA AuthIDs and create parent records;
4. assign children while enforcement is disabled;
5. enable enforcement per tenant after model and quota validation;
6. reconcile and monitor incomplete-pricing requests before global enablement.

The legacy Next.js implementation is a behavioral reference, not a storage or
provider abstraction to copy. This design replaces its floating-point shares,
SQLite concurrency, in-memory calibration tasks, and Codex/Grok registry with
PostgreSQL row locking and CPA-native identity/routing.

# Tenant Subscription Pool and Cost Accounting

RelayAPI distributes concrete fractions of upstream Codex subscriptions. A tenant may hold any number of independently assigned sub-subscriptions. Each assignment is bound to one upstream credential and never exposes that parent account to the tenant.

## Capacity

Model-aware immutable price snapshots convert every request into nano-USD cost. Changes in an upstream credential's reported used percentage calibrate the full subscription capacity:

```text
observed request cost / upstream percentage delta = full credential capacity
```

The existing cross-credential baseline is normalized to a Plus-equivalent share. For a Pro credential it is multiplied by the configured Pro multiplier (default 20) to recover full parent capacity. An assigned `units / unitsPerCredential` fraction receives that same fraction of the parent capacity. Thus a Pro `1/20` assignment receives one Plus-equivalent capacity without dividing twice.

## Reset identity

Every sub-subscription window uses the parent credential's cached `resets_at`. The durable identity is:

```text
subscription_id + window_kind + upstream_resets_at
```

When `resets_at` changes, settled and reserved counters start a new generation. RelayAPI never creates tenant-relative 5-hour or 7-day windows.

## Routing and settlement

Tenant API keys may route only to credentials for which the tenant has an active assignment. Channel health, model allowlists and cooldowns still apply. After selecting a credential, RelayAPI chooses an eligible assignment on that credential, reserves both windows, forwards the request, and settles the actual model-priced cost to that assignment only. Other assignments provide automatic failover when one is exhausted.

## Privacy and administration

Tenants see assignment names, fractions, their own consumption and inherited reset times. They do not see parent email, account ID, plan details, reset credits or raw upstream quota. Administrators create, update and revoke assignments. Enabled allocations on one credential may not exceed 100%.

The former `tenants.quota_shares_milli`, tenant-created quota windows and tenant parent-credential APIs are obsolete and removed by migration `013_tenant_subscriptions`.

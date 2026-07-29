# RelayAPI CPA bridge

Build the CPA v7 C-ABI plugin:

```bash
docker build --output type=local,dest=./dist .
```

Mount `dist/relayapi-bridge.so` into CPA's plugin directory and add:

```yaml
plugins:
  enabled: true
  dir: /CLIProxyAPI/plugins
  configs:
    relayapi-bridge:
      enabled: true
      priority: 10
      relay_url: http://relayapi:3000
      secret: replace-with-CPA_PLUGIN_SECRET
      delegate: round-robin
      quota_adapters_mode: append
```

Version 0.2.0 added strict AuthID pinning for parent/child subscriptions.
Relay signs each internal routing instruction with the shared `secret`;
invalid, expired, or unavailable AuthIDs are rejected instead of delegating to
another credential. Requests without a Relay routing instruction still
delegate to CPA's built-in scheduler.

Version 0.3.0 adds a provider-neutral quota extension runtime and the
authenticated route:

```text
GET /v0/management/plugins/relayapi-bridge/quota?auth_index=...
```

The bridge reads the selected credential through `host.auth.get`, uses CPA's
proxy-aware `host.http.do` callback, and returns only a normalized quota report.
Tokens, account identifiers, and raw upstream responses never leave CPA.

## Adapter modes

- `append` (default): load the bundled adapter pack, then custom adapters.
  Custom entries have precedence and the same `id` replaces a bundled entry.
- `replace`: use only the configured adapters.
- `disabled`: disable HTTP quota adapters. Credential-native `relay_quota`
  metadata remains available.

Codex and xAI are bundled YAML definitions in `quota-adapters.yaml`; neither has
a provider-specific Go execution path. Provider aliases also live only in the
manifest, so a generic `openai` API-key credential is not mistaken for Codex
OAuth.

## Custom adapter

Adapters are configured under `plugins.configs.relayapi-bridge.quota_adapters`:

```yaml
quota_adapters_mode: append
quota_adapters:
  - id: nebula-quota
    providers: [nebula, nebula-oauth]
    source: community/nebula
    requests:
      - id: usage
        method: GET
        url: https://api.nebula.example/account/${auth.account_id}/quota
        headers:
          Authorization: "Bearer ${auth.access_token}"
      - id: credits
        method: GET
        url: https://api.nebula.example/credits
        optional: true
        headers:
          Authorization: "Bearer ${auth.access_token}"
    plan:
      request: usage
      path: subscription.tier
      map:
        "2": pro
    windows:
      - kind: daily
        label: Daily
        request: usage
        used_value_path: quota.used
        limit_value_path: quota.limit
        reset_path: quota.resets_at
        enforceable: true
      - kind: credits
        label: Credits
        request: credits
        remaining_percent_path: remaining_percent
        limit_path: limit
        remaining_path: remaining
        unit: credits
        enforceable: false
```

Supported window mappings are:

- `used_percent_path` or `remaining_percent_path`;
- `used_value_path` plus `limit_value_path` for generic percentage calculation;
- `limit_path` and `remaining_path` for raw units;
- `reset_path` as RFC 3339, Unix seconds, Unix milliseconds, or a duration such
  as `2h`;
- `enforceable: true` only for a window whose percentage applies to all usage
  attributed to that credential.

All paths are dot-separated JSON paths and may include array indexes. Templates
only resolve `${auth.<dot.path>}` from the CPA credential JSON. Missing fields
fail the request without returning credential values.

## Credential-native extension

A CPA auth provider or plugin may publish normalized quota directly in the
credential metadata. This works for any provider and takes precedence over HTTP
adapters:

```json
{
  "relay_quota": {
    "plan_type": "enterprise",
    "windows": [
      {
        "kind": "monthly",
        "used_percent": 20,
        "resets_at": "2026-08-01T00:00:00Z",
        "enforceable": true
      }
    ]
  }
}
```

Relay keeps response-correlated usage as the billing source of truth because
CPA v7's usage ABI does not currently expose custom request correlation
headers. Quota observations only calibrate parent capacity; tenant child shares
remain an administrator policy.

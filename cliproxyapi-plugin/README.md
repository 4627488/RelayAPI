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
```

Version 0.2.0 adds strict AuthID pinning for parent/child subscriptions. Relay
signs each internal routing instruction with the shared `secret`; invalid,
expired, or unavailable AuthIDs are rejected instead of delegating to another
credential. Requests without a Relay routing instruction still delegate to
CPA's built-in scheduler. Relay keeps response-correlated usage as the billing
source of truth because CPA v7's usage ABI does not currently expose custom
request correlation headers.

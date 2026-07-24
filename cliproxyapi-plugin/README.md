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

The plugin observes CPA usage/failure events and can select an auth ID from
the trusted `X-Relay-CPA-Auth-ID` header. Otherwise it delegates to CPA's
built-in scheduler. Relay keeps response-correlated usage as the billing
source of truth because CPA v7's usage ABI does not currently expose custom
request correlation headers.

# Credential refresh ownership

CPA owns OAuth refresh for embedded inference, background refresh and Relay's
quota probes. Relay's `embeddedCPAAdapter.RefreshCredential` delegates through
`relaybridge.Runtime` to CPA's shared manager. Do not call provider refresh
endpoints or executor `Refresh` methods directly from Relay: those calls would
bypass CPA's shared credential lock and state updates.

Before probing quota, Relay reads the latest in-memory credential document. After
an HTTP 401, Relay requests one forced refresh through `Manager.ForceRefreshAuth`
and retries the probe once. Force still honors refresh failure backoff and
terminal unauthorized state inside CPA. A revoked or invalid refresh token
requires reauthorization; retrying cannot repair it. Refresh failures are
included in the quota error instead of being hidden behind the original 401.
CPA's existing update hook persists rotated tokens to Relay's encrypted
credential store.

## Dependency maintenance

Pin official `github.com/router-for-me/CLIProxyAPI/v7` in the root module and
`third_party/cpaexecutor/go.mod`. Do not reintroduce a fork replacement unless
upstream loses a shared refresh entry point.

`Runtime.RefreshCredential` maps onto official APIs:

- `force=false` returns `Manager.GetByID` metadata
- `force=true` calls `Manager.ForceRefreshAuth`

When bumping CPA, keep those two calls compiling. No provider-specific OAuth
code should need changes in Relay.

In Relay run `go test ./...` and `go vet ./...`, plus `go test ./...` from
`third_party/cpaexecutor` (a separate Go module). The embedded-adapter test
prevents regression to an empty refresh implementation.

Relay's backend CI also verifies and race-tests the bridge module separately;
the root module's `./...` does not include nested Go modules. Run the full Relay
suite on Linux because its file-credential tests assert Unix permission bits.

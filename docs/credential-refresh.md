# Credential refresh ownership

CPA owns OAuth refresh for embedded inference, background refresh and Relay's
quota probes. Relay's `embeddedCPAAdapter.RefreshCredential` delegates through
`relaybridge.Runtime` to `coreauth.Manager.RefreshCredential`. Do not call
provider refresh endpoints or executor `Refresh` methods directly from Relay:
those calls would bypass CPA's shared credential lock and state updates.

Before probing quota, Relay obtains the latest runtime credential document.
CPA applies its provider-specific refresh policy, so the document is returned
even when no refresh is necessary. After an HTTP 401, Relay requests one forced
refresh and retries the probe once. Force bypasses freshness checks, but still
honors refresh failure backoff and terminal unauthorized state. A revoked or
invalid refresh token requires reauthorization; retrying cannot repair it.
Refresh failures are included in the quota error instead of being hidden behind
the original 401. CPA's existing update hook persists rotated tokens to Relay's
encrypted credential store.

## Dependency maintenance

The root module and `third_party/cpaexecutor/go.mod` pin the same replacement:
[4627488/CLIProxyAPI commit d285d1152ce8](https://github.com/4627488/CLIProxyAPI/commit/d285d1152ce837fdbac8b9bfcc720cdb9dbf7c6a),
on branch `relay/credential-refresh-v7.2.151`. This is upstream **v7.2.151** plus
one commit exposing the shared refresh lifecycle, with regression tests. The
replacement's `v7.0.0-...` pseudo-version reflects the fork's tags, not a
downgrade to CPA v7.0.0.

The patch adds `Manager.RefreshCredential(ctx, id, force)` and extracts the
existing per-credential lock and locked refresh body for reuse. Provider OAuth
implementations and the existing automatic/inference refresh behavior are
unchanged. The CPA tests cover refresh lead times, rotated-token persistence,
static/disabled credentials, failure backoff, concurrent forced requests and
reuse of an in-flight inference refresh.

When updating CPA, rebase this single commit onto the chosen upstream release
and update both replacements and checksums. If upstream provides this API (or
an equivalent shared lifecycle), switch the bridge to it and remove both
replacements. No provider-specific OAuth code should need changes in Relay.

Run `go test ./sdk/cliproxy/auth`, the refresh tests with `-race`, and
`go build ./cmd/server` in the CPA checkout. In Relay run `go test ./...` and
`go vet ./...`, plus `go test ./...` from `third_party/cpaexecutor` (a separate
Go module). The new embedded-adapter test specifically prevents regression to
the former empty refresh implementation.

Relay's backend CI also verifies and race-tests the bridge module separately;
the root module's `./...` does not include nested Go modules. Run the full Relay
suite on Linux because its file-credential tests assert Unix permission bits.

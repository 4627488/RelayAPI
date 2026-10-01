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
[4627488/CLIProxyAPI commit 683363787b6f](https://github.com/4627488/CLIProxyAPI/commit/683363787b6f8251ebb20deaa8f1ac4162ba1b03),
on branch `codex/credential-refresh-v8.0.8`. This is upstream **v8.0.8** plus
the shared refresh lifecycle patch and a credential snapshot race fix, with
regression tests. The replacement version is
`v8.0.0-20261001061144-683363787b6f`; the module path is `/v8` in both
Relay modules. The pseudo-version reflects the fork's tags, not a downgrade
from upstream v8.0.8.

The shared refresh entry point passes the current registration epoch through
the locked refresh body, preserving v8.0.8's protection against stale queued
jobs refreshing a newly registered credential. The original refresh and
snapshot patches remain in place.

CPA v8.0.8 updates the Grok CLI chat-proxy identity to `1.0.44`, fixing HTTP
426 without a Relay inference header override. Relay's quota probe uses the
same version. Grok's protocol conversion remains owned by CPA; this upgrade
also includes executor-aware Codex tool schema normalization, Kimi tool-output
ordering, Claude tool-name translation and upstream stream failure handling.

The bridge
unions both Codex and xAI discovery snapshots with CPA's current catalog,
honors credential model exclusions, and persists expanded lists on startup.

The patch adds `Manager.RefreshCredential(ctx, id, force)` and extracts the
existing per-credential lock and locked refresh body for reuse. Provider OAuth
implementations and the existing automatic/inference refresh behavior are
unchanged. The CPA tests cover refresh lead times, rotated-token persistence,
static/disabled credentials, failure backoff, concurrent forced requests and
reuse of an in-flight inference refresh.

CPA v8 also exposes `GetByID` and `ForceRefreshAuth`. The former returns the
latest runtime snapshot, but does not perform a due refresh. The latter always
forces a refresh, bypassing the provider refresh policy and failure backoff.
Using them together for frequent quota probes would lose pre-probe refresh and
could repeat failed refreshes after each 401. The small shared-lifecycle patch
keeps quota probes on CPA's existing policy and coalesces concurrent refreshes.

Credential registration and updates also clone their callback/scheduler
snapshots under the manager lock. This prevents concurrent request results
from racing with post-lock reads of live credentials. The regression test
exercises registration, updates and refreshes concurrently with request results.

When updating CPA, rebase these patches onto the chosen upstream release
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

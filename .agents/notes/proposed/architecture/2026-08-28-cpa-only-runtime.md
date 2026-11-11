# Agent Note: Make embedded CPA the only provider runtime

Status: proposed

## Problem

`App.New` already boots only `startEmbeddedCPA` ([`internal/app/app.go`](../../../../internal/app/app.go), [`internal/app/embedded_cpa.go`](../../../../internal/app/embedded_cpa.go)). Production inference, catalog, OAuth login, WebSocket, and `StartAutoRefresh` all go through `relaybridge.Runtime`. The second stack is leftover: `startNativeRuntime` has no production or test caller, `internal/upstream/native_*.go` is a complete shadow executor, and `embeddedCPAAdapter.RefreshCredential` is a no-op.

Docs still describe the abandoned native-only world. [architecture.md](../../../../docs/architecture.md) says there is no embedded third-party runtime and that Relay itself refreshes OAuth. [README.md](../../../../README.md) and [subscriptions.md](../../../../docs/subscriptions.md) still say “native runtime.” Quota sync ([`internal/app/quota_sync.go`](../../../../internal/app/quota_sync.go)) and any admin “续期令牌” path call `Runtime.RefreshCredential`, which returns `(nil, false, nil)` on the only live adapter. CPA’s `Manager.StartAutoRefresh` (15-minute start, internal 5-second evaluate) is the refresh that actually runs.

A sibling change that copies CPA refresh into `nativeRuntime` does not help production. Two OAuth stacks will drift again the next time a token dies.

## Proposal

Treat Relay as the multi-tenant policy plane and embedded CPA as the only provider runtime. Do not keep a second executor “just in case.”

### Ownership

Relay owns tenant API keys (including optional `expires_at` / renew), aliases, allowlists, `AdmitRequest` / settlement, parent/child subscriptions, `cpa.ProbeQuota` against provider usage endpoints, in-process pricing, and request-log traces.

CPA owns protocol translation, credential routing, OAuth login, access-token refresh, provider HTTP/WebSocket, images, model discovery, and credential cooling. Relay pins one credential ID and must not silently fail over ([docs/subscriptions.md](../../../../docs/subscriptions.md) invariant 2).

CPA may keep Claude / Gemini / Antigravity executors internally. Relay’s public surface stays Codex-first: Responses, Chat, Images, Codex paths, Responses WebSocket. Anthropic Messages and Gemini `/v1beta/*` stay closed until a product decision opens them.

### Token refresh (do not reimplement)

Keep CPA `StartAutoRefresh`. Persist via the existing `OnCredentialUpdated` → `persistEmbeddedCredential` hook.

Add `relaybridge.Runtime.RefreshCredential(ctx, id, force)` that calls `manager.refreshAuth` / `refreshAuthForRequest` and returns the updated document. `embeddedCPAAdapter` forwards it. Quota 401 retry and admin force-renew use this. Delete Relay’s minute-tick `RefreshDueCredentials` once CPA is the only runtime; a second scheduler is how the two stacks diverged.

Tenant API key expiry is a Relay-only concern and stays out of CPA.

### Transport

Current embed listens on `127.0.0.1:0` with a random bearer and `cpa.Client.Do`. That is the CPA-era hop the in-process note tried to kill.

Target: call `runtime.Handler().ServeHTTP` (and in-process `DialWebSocket`) the same way native `Runtime.Serve` did. Keep `gateway.Client` as local admission. Drop the loopback listener, process-local API key, and `internal/cpa` HTTP client once nothing else uses them. Do this after refresh and tests are on CPA; do not block the ownership cut on the hop.

### Interface and deletion

Keep `upstream.Runtime` as Relay’s typed boundary so policy/billing do not import `relaybridge` types. One implementation: `embeddedCPAAdapter`.

Delete `startNativeRuntime`. After tests move, delete `internal/upstream/native_runtime.go` and the native provider/OAuth/translate/images/websocket files. Keep shared value types and an in-process `DialWebSocket` helper if the CPA hop is removed.

Rewrite tests that construct `upstream.NewRuntime` (`quota_sync_test.go`, `native_provider_probe_test.go`, `native_websocket_test.go`, `internal/upstream/*_test.go`) to use `relaybridge` plus the adapter, or a fake `upstream.Runtime`. Do not keep the native executor as a test double for production behavior.

Rename app-layer `native*` symbols as they are touched (`nativeRuntime` → `runtime`, `nativeProviderAccounts`, `native_settings`, `dialNativeRuntimeWebSocket`). No compatibility flag and no runtime mode switch.

### Docs

When the cut ships, rewrite [architecture.md](../../../../docs/architecture.md), the README data-plane paragraphs, and [subscriptions.md](../../../../docs/subscriptions.md) to say: Relay admits and accounts; embedded CPA executes. Supersede [2026-08-19-inprocess-runtime-no-http-proxy](../../implemented/simplification/2026-08-19-inprocess-runtime-no-http-proxy.md) on the loopback claim, and [2026-08-20-quota-oauth-refresh](../../implemented/feature/2026-08-20-quota-oauth-refresh.md) so quota refresh goes through CPA rather than a native token client.

### Landing order

1. Expose CPA `RefreshCredential`; stop stubbing the adapter; point quota 401 and admin renew at it. Rely on `StartAutoRefresh` for idle tokens.
2. Delete `startNativeRuntime`. Correct docs that claim native-only.
3. Move tests off `upstream.NewRuntime`.
4. Delete the native executor package.
5. Optional: drop the loopback HTTP hop.

## Alternatives considered

**Keep native as a compile-time or config switch.** That is the current accidental dual stack. Every OAuth, Images, or WS fix has to be written twice or one side silently no-ops.

**Finish native and delete CPA.** Rejected by product direction. Native already lost the boot path; finishing it means re-owning every provider contract CPA already ships.

**Call standalone CPA over the network.** Reintroduces an external control plane, management keys, and the plugin client this repo already deleted.

**Copy `StartAutoRefresh` into Relay’s minute loop.** Duplicates CPA’s 5-second evaluator and lead-time rules. Wire through; do not clone.

**Give CPA tenant keys, billing, or ProbeQuota.** Those are Relay invariants (reservation idempotency, integer nano-USD, parent/child windows). CPA refresh must not become CPA quota accounting.

## Acceptance criteria

- `App.New` has one runtime constructor. `startNativeRuntime` is gone.
- `RefreshCredential` on the live adapter refreshes a real OAuth parent and persists the document. Admin renew and quota-401 retry succeed without `native_oauth.go`.
- `StartAutoRefresh` remains the idle-token path. Relay does not run a second refresh ticker.
- No production caller of `upstream.NewRuntime`. Native executor files are deleted or quarantined behind tests that are themselves scheduled for deletion.
- Public protocols and subscription pinning are unchanged. ProbeQuota still hits provider usage endpoints.
- architecture.md / README / subscriptions.md describe CPA as the executor.

## Risks

- CPA `refreshAuth` is not a stable public SDK method; `relaybridge` must wrap it. A CPA upgrade can change lead time or persist shape.
- In-process `ServeHTTP` vs loopback changes WebSocket dialing and latency traces; do that in its own change.
- Tests that pin native translation (Kimi schema, Codex website, Images) need CPA-equivalent coverage or they become false confidence.
- CPA registers extra executors. Pinning and Relay allowlists must keep those models off the public catalog unless product opens them.

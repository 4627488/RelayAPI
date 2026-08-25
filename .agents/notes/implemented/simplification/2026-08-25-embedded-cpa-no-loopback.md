# Agent Note: Embedded CPA without a loopback HTTP hop

Status: implemented

## Problem

Relay restored official embedded CPA for inference, then treated that same-process handler as a remote HTTP server: a `127.0.0.1:0` listener, a random bearer key, `cpa.Client.Do`, and a copy loop in `proxyEmbeddedCPA`. WebSocket did the same over `ws://127.0.0.1`. Public readiness also required the loopback client (`inferenceCPA()`), so a live `relaybridge.Runtime` was not enough to serve traffic. The hop added copies, a second admission/circuit layer, and a serve-error path that no longer protected a process boundary.

## Decision

Keep embedded CPA as the data plane. Call `Runtime.Handler().ServeHTTP` with the already-buffered body, and dial WebSocket through the existing in-memory `DialWebSocket`. Inject the process-local CPA API key and `X-Relay-CPA-Auth-ID` on those in-process requests because CPA's mux still authenticates. Relay `gateway.Client` remains the only admission layer. Drop the loopback listener, `http.Server`, `cpa.Client`, `inferenceCPA`, `proxyEmbeddedCPA`, and `dialEmbeddedCPAWebSocket`. `/healthz` and admin `ready` are `nativeCPARuntime != nil`.

Do not wire the unused native runtime. Do not delete `third_party/cpaexecutor` or drop embedded CPA. Do not implement `RefreshCredential` or delete `internal/cpa` in this change; that package is leftover after the hop and is a follow-up.

## Alternatives considered

**Switch production to the unused native runtime.** That drops CPA capabilities the product still needs.

**Keep the loopback client so CPA stays "just an HTTP server".** The only consumer of that HTTP server is Relay in the same process. The extra hop does not buy isolation.

**Disable CPA API-key checks and drop the process-local secret.** Smaller call sites, but CPA's mux would then accept any in-process `ServeHTTP` if the handler is ever exposed.

**Delete `internal/cpa` in the same change.** Production no longer imports it after the hop is gone, but quota files and client tests are a second cleanup.

## Consequences

Latency traces no longer invent Relay-to-CPA TCP spans. `/healthz` no longer reports a loopback serve error. `internal/cpa.Client` has no production caller. Catalog listing still goes through `Runtime.ServeModels` and Relay policy filtering.

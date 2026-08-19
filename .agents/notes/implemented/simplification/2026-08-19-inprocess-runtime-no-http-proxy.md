# Agent Note: In-process runtime, no HTTP proxy copy

Status: implemented

## Problem

After CPA was removed, Relay still treated the native runtime as a remote HTTP server: a loopback listener, a random bearer key, `http.Client.Do`, then a pipe `ServeHTTP` that copied the response again. The runtime also `ReadAll`'d a body Relay had already buffered. That leftover reverse-proxy shape cost copies, fake DNS/TCP traces, and ceremony that no longer protected a process boundary.

## Decision

Call `Runtime.Serve` with the already-read body and write success streams through a `runtimeWriter` onto the client `ResponseWriter`. Error statuses stay buffered so Relay can still rewrite provider 429/401 into user-facing errors. WebSocket billing still sits between the client and the runtime; that hop uses an in-memory `DialWebSocket` instead of `127.0.0.1`. Admission (`gateway.Client`) remains local concurrency/memory/circuit control and no longer owns a URL or API key. Parent identity is the credential ID; `SyncParentSubscription` and lifecycle event writers are deleted. The `upstream_lifecycle_events` table stays for retention of upgrade leftovers.

## Alternatives considered

**Keep a pipe `ServeHTTP` so proxy.go still speaks `*http.Response`.** That preserves the CPA-era copy loop (new request, pipe, tee, second `ReadAll`) after the only consumer of that shape is ourselves.

**Serve directly onto the client writer with no wrapper.** Success streaming would be one less type, but error rewriting has to happen before `WriteHeader`. Buffering only 4xx/5xx is the smaller compromise.

**Drop WebSocket interception and let the runtime own the client socket.** Billing per turn still needs Relay between the two sockets.

## Consequences

Latency traces no longer invent Relay-to-runtime TCP/TLS spans. `/healthz` reports `runtime` instead of a loopback serve error. Tests that pointed `gateway.NewWithOptions` at `httptest.NewServer(runtime.Handler())` now hold a `Runtime` only.

# Agent Note: Drop unused CPA plugin and management client wrappers

Status: implemented

## Problem

After RelayAPI embedded CPA, `startEmbeddedCPA` constructs `cpa.Client` with an empty management key. Production quota uses `cpa.ProbeQuota` against provider endpoints. Health and model lists use `nativeCPARuntime` and `ControlHTTP` directly.

`rg` found no production callers for `Client.Management`, `ManagementRaw`, `Ready`, `Models`, `Quota`, `BridgeReady`, or `QuotaReady`. The only consumers were `internal/cpa/client_test.go` and `internal/cpa/quota_test.go`. Those methods still talked to `/v0/management/plugins` and `/v1/models` as if an external control plane existed.

## Decision

Remove the unused wrappers and the `ManagementKey` constructor argument. Keep the inference HTTP client, admission/circuit controller, `URL`, and the separate `ControlHTTP` pool used by `proxyNativeModels` for `GET /v1/models`. Do not change `third_party/cpaexecutor` OAuth `/v0/management/*`.

Delete tests that only pinned the removed plugin/management API. Keep admission, circuit, dual-pool, and streaming-timeout tests.

## Alternatives considered

**Keep `Ready`/`Models` as thin helpers.** Health no longer calls them; keeping them would re-introduce a path that can look like a control-plane ping.

**Delete `ControlHTTP` too.** `internal/app/native_models.go` still uses that pool so catalog fetches do not consume inference connection slots.

**Leave the methods for a future admin proxy.** No current admin route wraps CPA management through `cpa.Client`; adding one later is cheaper than carrying dead plugin version checks.

## Consequences

The embedded HTTP client later lost its last production caller when in-process `Handler().ServeHTTP` replaced the loopback hop; see [2026-08-25-embedded-cpa-no-loopback.md](2026-08-25-embedded-cpa-no-loopback.md). `gateway.ProbeQuota` remains the quota path.

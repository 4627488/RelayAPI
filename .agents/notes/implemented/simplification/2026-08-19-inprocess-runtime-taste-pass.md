# Agent Note: Tighten in-process runtime duties

Status: implemented

## Problem

After the loopback HTTP hop was removed, the public path still carried CPA-era transport helpers (`copyStreaming`, `releaseBufferedRequest`, `classifyUpstreamTransportError`, `observedReader`) and names that implied a remote proxy (`proxy`, `RecordTransportResult`, `upstream_admission`). `handlePublic` mixed admission, catalog, WebSocket, and inference in one function. Quota and pricing still treated `upstream_auth_index` as a second identity after parent identity became the credential ID.

## Decision

Delete the leftover HTTP-proxy copy/classify helpers and the tests that only pinned them. Public HTTP is `handlePublic` (auth, policy, Admit) then `serveInference` (in-process `Runtime.Serve`) or `handleWebSocket`. Model listing is `serveModelCatalog` via `Runtime.ServeModels`. Header prep is one `prepareRuntimeHeaders` used by HTTP, catalog, and WebSocket. Admission records `RecordOutcome`. Pricing and request-log `AuthIndex` prefer `UpstreamCredentialID` via `admissionAuthIndex`, with the stored index only as an upgrade leftover. Quota probes look up the credential ID. `/healthz` reports `runtime_credentials` and `runtime_admission`. The `upstream_auth_index` column and admin quota JSON field stay for compatibility.

## Alternatives considered

**Rewrite WebSocket off `net.Pipe`.** Billing still needs Relay between the client and runtime sockets.

**Drop the `upstream_auth_index` column now.** Old reservations and parent rows still store it; `SyncNativeParentSubscription` already mirrors the credential ID.

**Keep `handlePublic` as one function.** The reject/log duplication and the HTTP-vs-WS split were the actual cost; extracting `rejectPublic` and `serveInference` is the smaller, clearer cut.

## Consequences

Error *codes* such as `upstream_http_error` and `upstream_overloaded` are unchanged. Health JSON keys changed. Operators scraping `upstream_credentials` / `upstream_admission` should read the `runtime_*` names.

# Agent Note: Apply Kimi MFJS sanitizer and k3 wire IDs on the live CPA path

Status: implemented

## Problem

Production `https://cn.ai.cafebabe.top` reports `data_plane=embedded_cpa` and last-modified `2026-08-29T07:54:59Z` (CPA v7.2.145). `App` only calls `startEmbeddedCPA`; `startNativeRuntime` never starts.

Two Kimi production failures therefore missed the native-only fixes:

- Moonshot MFJS 400: `when using $ref, type should be defined in the referenced schema`. `sanitizeKimiToolSchemas` lives in `native_serve.go` after Responses→Chat. CPA `KimiExecutor` copies `tools[].function.parameters` unchanged and has no MFJS pass through v7.2.145.
- Coding Plan 401 on `kimi-k3-256k`: `recognized as other:kimi-k3-256k. Please set model id as k3` (prod request `60a4e061-8175-4d3d-8b57-185b9d618c6a`). A credential `model_routes` hot-fix on `kimi-d2f83569e3dd08d9` (revision 1415) and draft PR #21 never reached `main`. CPA `normalizeKimiUpstreamModel` only strips the `kimi-` prefix, so the wire ID becomes `k3-256k` unless a document route exists. OAuth rebind also dropped `model_routes`.

## Decision

- Sanitize outbound Kimi bodies in `proxyEmbeddedCPA` via `PrepareKimiCPABody` before the loopback hop, keyed by credential ID prefix `kimi*` or model `kimi-*` / `k3*`.
- Default compile-time aliases `kimi-k3` / `kimi-k3-256k` → `k3` in both CPA `RouteModel` and the unused native compiler. Document routes still win.
- Preserve `model_routes` when merging a re-bound OAuth credential.

Do not switch production off embedded CPA. Do not wait for CPA PR #4406.

## Alternatives considered

**Rely on the Aug 20 credential hot-fix.** Survives only until the next OAuth rebind; `mergeOAuthCredentialSettings` previously kept `websockets`/`headers` but not `model_routes`.

**Wait for CPA to sanitize MFJS and map k3.** v7.2.145 still has neither. Even a bump would leave Relay's hop forwarding unchecked schemas.

**Re-enable `startNativeRuntime` as the data plane.** That is a cutover, not a Kimi hotfix. Production already chose CPA in `app.go`.

## Consequences

Codex/Chat Kimi turns on the deployed CPA path get the same `$ref`+`type` rewrite as native tests. `kimi-k3-256k` routes to `k3` after deploy or OAuth rebind without editing the stored document. Boolean subschemas and non-`#/$defs/` refs are still unhandled until a real payload hits them.

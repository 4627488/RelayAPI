# Agent Note: Split hot-path files by Go package convention

Status: implemented

## Problem

`internal/app/proxy.go` and `internal/upstream/native_runtime.go` each held almost a thousand lines after the in-process runtime work. The filename `proxy.go` no longer matched `handlePublic`. Tests lived in one `proxy_test.go`. That is not how a Go package is usually laid out: one file per concern, tests next to the code.

## Decision

Keep both packages. Split by responsibility:

- `app`: `public.go` (admit), `inference.go` (Serve + writer), `request_meta.go`, `limits.go`; log writers join `request_logging.go`.
- `upstream`: `native_runtime.go` (lifecycle + Runtime methods), `native_credential.go`, `native_serve.go`, `native_provider.go`.

Tests follow the same names. No new packages and no behavior change.

## Alternatives considered

**New packages such as `internal/app/public`.** That would force exported types across a tiny boundary for no caller outside `app`.

**Leave `proxy.go` and only rename it.** The file would still mix metadata, limits, logging, and HTTP.

## Consequences

`rg proxy.go` will miss the public path; search `handlePublic` or `public.go`.

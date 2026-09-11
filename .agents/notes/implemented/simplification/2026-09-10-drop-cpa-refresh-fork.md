# Agent Note: Drop the CPA credential-refresh fork

Status: implemented

## Problem

Relay pinned official CPA `v7.2.151` through a `replace` to `4627488/CLIProxyAPI` commit `d285d1152ce8` so quota probes could call `Manager.RefreshCredential`. That fork had to be rebased on every bump.

## Decision

CPA `v7.2.157` exports `Manager.ForceRefreshAuth`, which is the shared locked refresh path. `relaybridge.Runtime.RefreshCredential` now uses `GetByID` when `force=false` and `ForceRefreshAuth` when `force=true`. Both module files pin official `v7.2.157` and the fork replacements are gone.

Keep the Bailian `openai_compat` wrapper. Official `OpenAICompatExecutor` still only does `/chat/completions` and `/responses/compact`.

## Alternatives considered

**Rebase the fork onto 157.** Works, but keeps a private pin and a `v7.0.0-...` pseudo-version.

**Call executor `Refresh` from Relay.** That bypasses CPA's lock and persist hook.

## Consequences

Non-forced quota probes no longer ask CPA to refresh a still-valid token; they read the live in-memory document. Forced 401 recovery still goes through CPA.

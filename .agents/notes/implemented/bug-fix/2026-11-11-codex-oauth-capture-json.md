# Agent Note: Initialize OAuth capture files as JSON

Status: implemented

## Problem

Production Codex reauthorization reached token storage but failed with `invalid existing credential JSON`. The bridge reserved an empty file with CreateTemp; CPA's Codex storage reads and merges an existing JSON object before saving. The existing synthetic storage test only overwrote the file and missed that contract. Separately, the old production credential returned `refresh_token_expired`, making reauthorization necessary.

## Decision

Initialize the reserved temporary file with `{}` and check write/close errors before calling provider storage. Remove the credential and its per-file lock after capture. Exercise the actual CPA CodexTokenStorage in a regression test, asserting token capture and temporary-file cleanup.

## Alternatives considered

Removing the reserved file before saving would also avoid decoding an empty file but gives up the existing exclusive reservation. Changing CPA to accept empty existing credentials would weaken corruption detection for real persisted credentials. Keep the correction in Relay's temporary capture adapter.

## Consequences

The patch allows fresh and replacement OAuth credentials to reach the existing capture/finalize flow without changing stored account credentials or refresh behavior. A production deployment and a fresh user login are still needed to recover the expired account; these are not performed by this investigation.

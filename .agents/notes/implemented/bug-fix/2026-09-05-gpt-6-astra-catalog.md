# Agent Note: Publish GPT-6 Astra from frozen Codex allowlists

Status: implemented

## Problem

OpenAI shipped `gpt-6-astra` on 2026-09-03. CPA `v7.2.151` already lists it for Codex Plus / Team / Pro. Production still could not serve it: stored Codex `Models` are a discovery snapshot, and `cpaAuthFromCredential` treated a non-empty list as the entire public catalog. Existing accounts kept the pre-GPT-6 default (`gpt-5.6-sol`, …) so `/v1/models`, routing, and parent `upstream_model_allowlist` omitted the new slug. Bundled prices also had no Astra row.

## Decision

For Codex credentials, union the stored allowlist with CPA's current static catalog. `excluded_models` still subtracts. After embedded CPA starts, persist the expanded list and re-sync parent subscriptions from live `CredentialModels`. New empty Codex accounts default to `gpt-6-astra` first. Bundle OpenAI Standard short-context rates ($10 / $1 cached / $12.50 write / $50 output per 1M) so a stale models.dev snapshot cannot 503 under `unpriced_model_policy=deny`.

Do not invent a `gpt-6` alias. ChatGPT "GPT-6 Pro" is the same API slug.

## Alternatives considered

**Ask operators to click Discover.** That works for one account and forgets the next model launch.

**Always ignore stored Codex Models.** That would undo an admin who trimmed the list in the credential editor. `excluded_models` is the supported hide path; union still preserves extra stored slugs.

**Import models.dev long-context tiers.** Astra reprices the whole request above 272k input ($20 / $75). Relay's catalog compiler only stores the base rate. Track that separately; it is a billing accuracy gap, not the reason the model was unusable.

## Consequences

Existing Plus / Team / Pro Codex accounts publish and route `gpt-6-astra` on the next process start. Free-plan CPA catalogs still omit it. Codex CLI older than `0.153.0` may hide the row via `minimal_client_version` even when Relay serves it.

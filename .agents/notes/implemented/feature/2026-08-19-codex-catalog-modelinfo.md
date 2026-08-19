# Agent Note: Codex catalog ModelInfo

Status: implemented

## Problem

Codex CLI/TUI fetches `GET /v1/models?client_version=…` and merges it with the bundled OpenAI catalog by slug. Relay already filtered by tenant/key/subscription and kept denied slugs as `visibility: hide` tombstones. The rows themselves were too thin: no `supported_reasoning_levels`, `max_context_window`, `shell_type`, `supported_in_api`, `priority`, `truncation_policy`, or `base_instructions`. Codex then either fails serde on the whole remote list or falls back to `model_info_from_slug` (visibility none, no apply_patch, empty reasoning).

## Decision

Build one complete Codex `ModelInfo` in code for every published slug. Visibility still comes from Relay's user model: allowed → `list`, denied → `hide` with the same metadata so the hide override parses. Do not embed CPA's official `models.json`. Keep the optimistic full agent surface (`apply_patch=freeform`, `prefer_websockets=true`); adapters lower unsupported wire details. Image-only slugs (`gpt-image-*`, `grok-imagine-*`) stay hidden in the Codex picker. Compact `base_instructions` cover apply_patch, exec, and the commentary/final channels. ETag token is now `codex-modelinfo-v1`.

## Alternatives considered

**Embed official `models.json` and clone `gpt-5.5` like CPA.** Hundreds of kilobytes, model-specific prompts, and CPA also deletes `apply_patch` / sets `prefer_websockets=false` for custom slugs — the opposite of Relay's product policy.

**Complete only visible rows.** One invalid hide tombstone makes Codex reject the remote catalog, and bundled official slugs reappear.

**Omit `base_instructions`.** Current Codex deserializers require `base_instructions` or `model_messages.instructions_template`.

## Consequences

Codex pickers show Relay-allowed models with reasoning levels and apply_patch. Denied official slugs remain hidden. Changing the ModelInfo shape requires bumping `codexCatalogRevisionToken` so clients refresh.

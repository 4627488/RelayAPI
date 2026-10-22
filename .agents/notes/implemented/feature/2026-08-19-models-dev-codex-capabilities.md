# Agent Note: models.dev Codex capabilities

Status: implemented

## Problem

Relay already emitted a complete Codex `ModelInfo` for every published slug, but
the facts were one optimistic template: 256k context, `none/low/medium/high`,
`prefer_websockets=true`. That is wrong for Kimi and DeepSeek (K3 is 1M with
`low/high/max`; K2.5 is toggle-only; Chat-only providers should not prefer
WebSocket). Hardcoding a family table would rot. Other OSS projects already
solve this with a living catalog.

## What other projects do

**CPA** embeds and remotely refreshes a private `models.json`, clones `gpt-5.5`
for unknown slugs, then deletes `apply_patch` and sets `prefer_websockets=false`
for custom models. Relay must not take that catalog or that apply_patch policy.

**sub2api** rewrites custom `/v1/models` to `{models:[{slug}]}` and relies on
Codex's fallback. That is the failure mode we already fixed.

**LiteLLM** fetches GitHub `model_prices_and_context_window.json` at startup.
It has context and capability bools, not Codex reasoning *levels*.

**OpenCode / models.dev** publishes `https://models.dev/api.json`. First-party
rows already have the fields Codex needs: `limit.context`, `reasoning`,
`reasoning_options` (`toggle` / `effort` values), and `modalities.input`.
Aggregator copies of the same slug disagree (for example qiniu marks
`kimi-k2.5` as `reasoning: false`).

## Decision

Reuse the models.dev fetch Relay already runs for prices. Parse capabilities even when a model has no public price and prefer first-party providers. The [2026-10-22 provider contract decision](../architecture/2026-10-22-versioned-codex-provider-contract.md) extends this to first-party OpenAI facts, input budgets, optional tool flags, modality and priority modes. Complete ModelInfo and old compatibility fields remain; current Codex uses provider capabilities for transport, including WS-to-Chat adaptation. Explicit tool_call=false hides a model from the agent picker. Reasoning mapping:

- effort values are authoritative (so K3 does not invent a fake `none`)
- toggle only → `none` + `high`
- reasoning true with empty options → `high` only
- otherwise → `none` only

Persist original priced RawJSON and an independent full capability snapshot atomically in PostgreSQL. Rebuild unpriced facts on boot as well as refresh. Content revisions include capability facts and administrator overrides.

Do not fetch CPA's `models.json`. Do not embed the 4MB `api.json`.

## Alternatives considered

**Hardcoded Kimi/DeepSeek/Grok profiles.** Accurate on day one, stale when
Moonshot ships K4.

**Fetch CPA's catalog at runtime.** Couples Relay to another project's
schema and conservative tool policy.

**Overlay arbitrary aggregator facts on official slugs.** Rejected; first-party OpenAI facts are accepted as of the 2026-10-22 decision, while aggregator copies cannot replace them.

## Consequences

Codex pickers reflect sourced context, reasoning and agent capability. Admin price sync refreshes picker metadata without granting model access. Transport is negotiated from the gateway implementation rather than inferred from model metadata. Native model thinking and upstream quality remain separately verified concerns.
